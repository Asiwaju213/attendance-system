import { randomBytes } from "node:crypto";
import { after } from "node:test";
import { authConfig } from "../src/config/auth";
import { pool } from "../src/db/pool";

/**
 * Helpers for tests that need an *authenticated student session*.
 *
 * Why this exists
 * ---------------
 * `POST /api/auth/student/login` deliberately refuses to create a session from a matric number and
 * a password alone. A password is not a device proof, so a browser with no device-binding cookie
 * is either issued a short-lived enrollment grant (no active device) or refused outright (an active
 * device exists). Only the existing-device path — a valid device-binding cookie *plus* the
 * password — mints a session.
 *
 * That means a test whose actual subject is "an authenticated student can read their attendance",
 * and not device enrollment itself, must first put the student in the state a real returning user
 * is in: an ACTIVE, discoverable device whose credential id is presented as the device-binding
 * cookie.
 *
 * This is the mechanical fix for tests affected by that change. It deliberately does not relax any
 * production behaviour: the tests still authenticate through the real endpoint, with a real
 * device-binding cookie, exactly as the browser does.
 */

const CREDENTIAL_ID_PREFIX = "bound-test-cred-";

/**
 * Device rows this module created, removed again in the root teardown below.
 *
 * These rows exist only to give a test an authenticated student. They would otherwise outlive the
 * test and break the next one: `student_devices.student_id` is `ON DELETE RESTRICT`, so a leftover
 * device makes the owning test file's own `DELETE FROM students` cleanup fail.
 */
const createdCredentialIds = new Set<string>();

/** Student profile ids this module bound a device for, so their grants can be cleared too. */
const touchedStudentIds = new Set<number>();

/**
 * Root-level teardown for this module.
 *
 * Registering `after` here — from an imported module — attaches to the test file's root suite, and
 * Node runs root hooks in registration order. The helper is imported at module load, before the
 * importing test file registers its own `after`, so these rows are removed before that file's
 * cleanup and before it calls `pool.end()`.
 */
after(async () => {
  if (createdCredentialIds.size === 0 && touchedStudentIds.size === 0) {
    return;
  }

  if (touchedStudentIds.size > 0) {
    // Enrollment grants are issued by the login endpoint itself, not by this module, but they
    // point at the same students and `ON DELETE RESTRICT` means a leftover grant would make the
    // owning test file's `DELETE FROM students` fail. Clear them for every student this module
    // bound a device for.
    await pool.query(
      `DELETE FROM student_device_enrollment_grants WHERE student_id = ANY($1::BIGINT[])`,
      [[...touchedStudentIds]]
    );
  }

  if (createdCredentialIds.size > 0) {
    await pool.query(`DELETE FROM student_devices WHERE credential_id = ANY($1::TEXT[])`, [
      [...createdCredentialIds],
    ]);
  }

  createdCredentialIds.clear();
  touchedStudentIds.clear();
});

/**
 * Ensure the student identified by `matricNumber` has an ACTIVE, discoverable device and return
 * its credential id.
 *
 * Reuses an existing ACTIVE discoverable device when there is one, so calling this repeatedly for
 * the same student (which happens across test files sharing a seeded student) is idempotent and
 * does not violate the one-ACTIVE-device-per-student constraint.
 *
 * The credential id is random and the stored public key is a placeholder: these tests authenticate
 * with the device-binding cookie but never perform a WebAuthn signature verification. Tests that
 * need a real, verifiable authenticator build one with `webauthnTestHelpers` instead.
 */
export async function ensureActiveDiscoverableDevice(
  matricNumber: string
): Promise<string> {
  const existing = await pool.query(
    `SELECT d.credential_id, d.student_id
       FROM student_devices d
       JOIN students s ON s.id = d.student_id
      WHERE s.matric_number = $1
        AND d.status = 'ACTIVE'
        AND d.discoverable = TRUE
      LIMIT 1`,
    [matricNumber]
  );

  const existingCredentialId = existing.rows[0]?.credential_id;
  if (typeof existingCredentialId === "string") {
    touchedStudentIds.add(Number(existing.rows[0].student_id));
    return existingCredentialId;
  }

  // The one-ACTIVE-device-per-student index would reject the insert below with an opaque unique
  // violation. Say what is actually wrong instead.
  const activeNonDiscoverable = await pool.query(
    `SELECT d.credential_id
       FROM student_devices d
       JOIN students s ON s.id = d.student_id
      WHERE s.matric_number = $1
        AND d.status = 'ACTIVE'
        AND d.discoverable IS NOT TRUE
      LIMIT 1`,
    [matricNumber]
  );
  if (activeNonDiscoverable.rows.length > 0) {
    throw new Error(
      `Student ${matricNumber} has an ACTIVE non-discoverable device ` +
        `(${activeNonDiscoverable.rows[0].credential_id}). Device-binding login only accepts a ` +
        `discoverable credential, and a second ACTIVE device cannot coexist with it. Seed the ` +
        `fixture as discoverable, or revoke the existing device first.`
    );
  }

  const credentialId = `${CREDENTIAL_ID_PREFIX}${randomBytes(16).toString("hex")}`;
  const result = await pool.query(
    `INSERT INTO student_devices
       (student_id, credential_id, credential_public_key, counter, cred_type, discoverable, status)
     SELECT s.id, $2, $3, 0, 'public-key', TRUE, 'ACTIVE'
       FROM students s
      WHERE s.matric_number = $1
     RETURNING credential_id, student_id`,
    // A single-byte CBOR placeholder. Never used to verify a signature; see the note above.
    [matricNumber, credentialId, Buffer.from([0xa0, 0x01])]
  );

  // `RETURNING` is empty when the matric number matches no student. Say so plainly rather than
  // returning a credential id that was never stored, which would produce a baffling 401 later.
  if (result.rows.length === 0) {
    throw new Error(`No student found with matric number: ${matricNumber}`);
  }

  createdCredentialIds.add(credentialId);
  touchedStudentIds.add(Number(result.rows[0].student_id));
  return credentialId;
}

/**
 * The `cookie` request header presenting `credentialId` as the device-binding cookie.
 *
 * The device-binding cookie holds the WebAuthn credential id verbatim, so this is exactly what a
 * browser would send after a successful enrollment on that device.
 */
export function deviceBindingHeader(credentialId: string): Record<string, string> {
  return { cookie: `${authConfig.deviceBindingCookieName}=${credentialId}` };
}

/**
 * The `cookie` request header for logging in as an already-enrolled student, creating the ACTIVE
 * device first if the student does not have one.
 *
 * This is the one-line form used by tests that just need an authenticated student. It composes the
 * two helpers above so a test reads as a normal login with a device bound to the browser.
 */
export async function boundDeviceHeaders(
  matricNumber: string
): Promise<Record<string, string>> {
  return deviceBindingHeader(await ensureActiveDiscoverableDevice(matricNumber));
}