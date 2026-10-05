import { pool } from "../db/pool";
import { hashPassword, verifyPasswordOrDummy } from "../lib/passwords";

export type ChangePasswordResult =
  | { ok: true }
  | {
      ok: false;
      code:
        | "ACCOUNT_NOT_FOUND"
        | "PASSWORD_CHANGE_NOT_REQUIRED"
        | "CURRENT_PASSWORD_INVALID"
        | "PASSWORD_UNCHANGED";
    };

interface AccountRow {
  id: string;
  password_hash: string | null;
  must_change_password: boolean;
  status: string;
}

/**
 * Replace the temporary password a lecturer account was created with.
 *
 * The current password is verified against the stored Argon2id hash before anything is written,
 * so knowing a staff id is not enough to take over an account. The new password is hashed with
 * the same helper and the forced-change flag is cleared in the same transaction, so the account
 * can never be left with a changed password and a pending change, or the reverse.
 *
 * Every other session of the account is revoked: any browser that signed in with the temporary
 * credential loses access immediately. The session that performed the change stays signed in.
 * The audit entry records that a change happened and never what the password is.
 */
export async function changeOwnPassword(
  userId: number,
  currentSessionId: number | null,
  currentPassword: string,
  newPassword: string
): Promise<ChangePasswordResult> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Lock the row so two concurrent changes cannot both read the same current password and
    // both believe they are the first.
    const accountResult = await client.query(
      `SELECT id, password_hash, must_change_password, status
       FROM users
       WHERE id = $1 AND role = 'LECTURER'
       FOR UPDATE`,
      [userId]
    );
    const account = accountResult.rows[0] as AccountRow | undefined;
    if (!account || account.status !== "ACTIVE") {
      await client.query("ROLLBACK");
      return { ok: false, code: "ACCOUNT_NOT_FOUND" };
    }
    if (!account.must_change_password) {
      await client.query("ROLLBACK");
      return { ok: false, code: "PASSWORD_CHANGE_NOT_REQUIRED" };
    }

    // Always pay for one Argon2id verification, even when no hash exists, so a failure here is
    // indistinguishable in timing from a wrong password.
    const currentMatches = await verifyPasswordOrDummy(
      account.password_hash,
      currentPassword
    );
    if (!currentMatches) {
      await client.query("ROLLBACK");
      return { ok: false, code: "CURRENT_PASSWORD_INVALID" };
    }
    if (currentPassword === newPassword) {
      await client.query("ROLLBACK");
      return { ok: false, code: "PASSWORD_UNCHANGED" };
    }

    const newHash = await hashPassword(newPassword);

    await client.query(
      `UPDATE users
       SET password_hash = $2, must_change_password = false
       WHERE id = $1`,
      [userId, newHash]
    );

    if (currentSessionId === null) {
      await client.query(
        `UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`,
        [userId]
      );
    } else {
      await client.query(
        `UPDATE sessions SET revoked_at = now()
         WHERE user_id = $1 AND revoked_at IS NULL AND id <> $2`,
        [userId, currentSessionId]
      );
    }

    await client.query(
      `INSERT INTO audit_logs (user_id, action, entity_type, entity_id, description)
       VALUES ($1, 'PASSWORD_CHANGED', 'users', $1, $2)`,
      [
        userId,
        "Lecturer replaced the temporary password issued at account creation; other sessions were revoked.",
      ]
    );

    await client.query("COMMIT");
    return { ok: true };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
