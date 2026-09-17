import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { E2E_LECTURER, E2E_STUDENT } from "./constants";
import {
  acquireAttendanceFixturesLock,
} from "./helpers/attendance-fixture-mutex";
import { withLoginMutex } from "./helpers/login-mutex";

test.describe.configure({ mode: "serial" });

let releaseAttendanceLock: (() => Promise<void>) | undefined;

test.beforeAll(async () => {
  releaseAttendanceLock = await acquireAttendanceFixturesLock();
});

test.afterAll(async () => {
  await releaseAttendanceLock?.();
});

const COURSE_TITLE = "E2E Computer Science 101";

function eligibleSession(overrides: Record<string, unknown> = {}) {
  return {
    id: 999,
    courseOfferingId: 1,
    courseCode: "E2E-101",
    courseTitle: COURSE_TITLE,
    startTime: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
    endTime: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    lateThresholdMinutes: 5,
    attendanceNetworkName: "E2E Test Network",
    locationName: "E2E Test Lecture Hall",
    currentAttendanceState: "NOT_MARKED",
    ...overrides,
  };
}

const DEVICE_CHALLENGE = {
  data: {
    challenge: "Y2hhbGxlbmdlLWUyZQ",
    rpId: "localhost",
    timeout: 60000,
    userVerification: "preferred",
    allowCredentials: [
      { id: "Y3JlZGVudGlhbElkLWUyZQ", type: "public-key", transports: ["internal"] },
    ],
  },
};

async function loginAsStudent(page: Page): Promise<void> {
  await withLoginMutex("student", async () => {
    await page.goto("/login");
    await page.getByLabel("Matric Number").fill(E2E_STUDENT.matricNumber);
    await page.getByLabel("Password").fill(E2E_STUDENT.password);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page).toHaveURL(/\/app\/student$/, { timeout: 15_000 });
  });
}

async function loginAsLecturer(page: Page): Promise<void> {
  await withLoginMutex("lecturer", async () => {
    await page.goto("/staff/lecturer/login");
    await page.getByLabel("Staff ID").fill(E2E_LECTURER.staffId);
    await page.getByLabel("Password").fill(E2E_LECTURER.password);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page).toHaveURL(/\/app\/lecturer$/, { timeout: 15_000 });
  });
}

async function openAttendancePage(page: Page): Promise<void> {
  await loginAsStudent(page);
  await page.goto("/app/student/attendance");
  await expect(
    page.getByRole("heading", { level: 1, name: "Attendance" })
  ).toBeVisible();
}

async function mockEligible(page: Page, sessions: unknown[]): Promise<void> {
  await page.route("**/api/student/attendance/eligible", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ data: sessions }),
    })
  );
}

async function mockDeviceChallenge(page: Page): Promise<void> {
  await page.route("**/api/student/attendance/device-challenge", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(DEVICE_CHALLENGE),
    })
  );
}

async function mockMarkFailure(
  page: Page,
  status: number,
  code: string
): Promise<void> {
  await page.route("**/api/student/attendance", (route) =>
    route.fulfill({
      status,
      contentType: "application/json",
      body: JSON.stringify({ error: code, message: "Test error." }),
    })
  );
}

/**
 * Override the WebAuthn boundary only: the API calls, XMLHttpRequest/fetch, and the
 * React page all stay real. `get` either resolves a structurally valid assertion
 * (the backend POST is still stubbed by the caller) or cancels like a real
 * authenticator prompt, exercising the page's error handling without real crypto.
 */
async function stubDeviceGet(page: Page, mode: "resolve" | "cancel"): Promise<void> {
  await page.addInitScript((behavior) => {
    const b64ToBytes = (value: string): Uint8Array => {
      const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
      const padded =
        normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
      const binary = atob(padded);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
      }
      return bytes;
    };

    const clientData = new TextEncoder().encode(
      JSON.stringify({
        type: "webauthn.get",
        challenge: "Y2hhbGxlbmdlLWUyZQ",
        origin: "http://localhost:4173",
        crossOrigin: false,
      })
    );

    const credential = {
      id: "Y3JlZGVudGlhbElkLWUyZQ",
      rawId: b64ToBytes("Y3JlZGVudGlhbElkLWUyZQ"),
      type: "public-key",
      response: {
        clientDataJSON: clientData,
        authenticatorData: new Uint8Array([0x49, 0x00, 0x00, 0x00, 0x00]),
        signature: new Uint8Array([0x30]),
      },
      getClientExtensionResults: () => ({}),
    };

    Object.defineProperty(navigator, "credentials", {
      configurable: true,
      value: {
        get: async () => {
          if (behavior === "cancel") {
            throw new DOMException(
              "The operation either timed out or was not allowed.",
              "NotAllowedError"
            );
          }
          return credential;
        },
      },
    });
  }, mode);
}

async function disableWebAuthn(page: Page): Promise<void> {
  await page.addInitScript(() => {
    Object.defineProperty(window, "PublicKeyCredential", {
      configurable: true,
      value: undefined,
    });
  });
}

/**
 * Enroll a real credential on a CDP virtual authenticator through the real backend
 * enrollment endpoints, so the later attendance mark goes through the real
 * challenge/assertion/verify path. Test-only: it drives production APIs + a
 * Chromium virtual authenticator and never touches production code.
 */
async function enrollDeviceOnVirtualAuthenticator(page: Page): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("WebAuthn.enable", { enableUI: false });
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      ctap2Version: "ctap2_1",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });

  const result = await page.evaluate(async () => {
    const b64ToBytes = (value: string): Uint8Array => {
      const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
      const padded =
        normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
      const binary = atob(padded);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
      }
      return bytes;
    };

    const bytesToB64 = (bytes: Uint8Array): string => {
      let binary = "";
      for (let i = 0; i < bytes.length; i++) {
        binary += String.fromCharCode(bytes[i]);
      }
      return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    };

    const optionsRes = await fetch("/api/student/device/enrollment/options", {
      method: "POST",
      credentials: "include",
    });
    if (!optionsRes.ok) {
      throw new Error(`Enrollment options failed: ${await optionsRes.text()}`);
    }
    const { data: options } = (await optionsRes.json()) as {
      data: Record<string, unknown>;
    };

    const publicKey: PublicKeyCredentialCreationOptions = {
      challenge: b64ToBytes(String(options.challenge)),
      rp: options.rp as { id: string; name: string },
      user: {
        ...(options.user as { name: string; displayName: string }),
        id: b64ToBytes((options.user as { id: string }).id),
      },
      pubKeyCredParams: options.pubKeyCredParams as PublicKeyCredentialParameters[],
      timeout: Number(options.timeout),
      attestation: options.attestation as "none",
      authenticatorSelection: options.authenticatorSelection as {
        authenticatorAttachment: string;
        residentKey: string;
        userVerification: string;
      },
      excludeCredentials: ((options.excludeCredentials ?? []) as {
        id: string;
        type?: string;
        transports?: string[];
      }[]).map((credential) => ({
        id: b64ToBytes(credential.id),
        type: "public-key",
        ...(credential.transports
          ? { transports: credential.transports as AuthenticatorTransport[] }
          : {}),
      })),
    };

    const credential = (await navigator.credentials.create({
      publicKey,
    })) as PublicKeyCredential;
    const response = credential.response as AuthenticatorAttestationResponse;

    const payload = {
      credential: {
        id: credential.id,
        rawId: bytesToB64(new Uint8Array(credential.rawId)),
        type: credential.type,
        response: {
          attestationObject: bytesToB64(
            new Uint8Array(response.attestationObject)
          ),
          clientDataJSON: bytesToB64(new Uint8Array(response.clientDataJSON)),
          transports: response.getTransports
            ? response.getTransports()
            : undefined,
        },
        clientExtensionResults: credential.getClientExtensionResults() as Record<
          string,
          unknown
        >,
        authenticatorAttachment: credential.authenticatorAttachment ?? undefined,
      },
      label: "E2E virtual device",
    };

    const completeRes = await fetch("/api/student/device/enrollment/complete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify(payload),
    });
    if (completeRes.status !== 201) {
      throw new Error(`Enrollment complete failed: ${await completeRes.text()}`);
    }
    return true;
  });

  expect(result).toBe(true);
}

test("an unauthenticated user is redirected to the student login page", async ({
  page,
}) => {
  await page.goto("/app/student/attendance");

  await expect(page).toHaveURL(/\/login$/);
  await expect(
    page.getByRole("heading", { level: 1, name: "Student Login" })
  ).toBeVisible();
});

test("a non-student cannot reach the attendance page", async ({ page }) => {
  await loginAsLecturer(page);

  await page.goto("/app/student/attendance");

  await expect(page).toHaveURL(/\/app\/lecturer$/);
  await expect(
    page.getByRole("heading", { level: 1, name: "Lecturer Home" })
  ).toBeVisible();
});

test("the seeded eligible session appears with a mark action", async ({ page }) => {
  await openAttendancePage(page);

  const item = page
    .locator(".session-list__item")
    .filter({ hasText: COURSE_TITLE })
    .filter({ has: page.getByRole("button", { name: "Mark attendance for E2E-101" }) });
  await expect(item).toBeVisible();
  await expect(item).toContainText(`${COURSE_TITLE}`);
  await expect(item).toContainText("E2E Test Network");
  await expect(item).toContainText("E2E Test Lecture Hall");
  await expect(page.getByRole("button", { name: "Mark attendance for E2E-101" })).toBeVisible();
});

test("an empty eligible response shows the empty state", async ({ page }) => {
  await mockEligible(page, []);
  await openAttendancePage(page);

  await expect(
    page.getByText("No attendance sessions are currently available.")
  ).toBeVisible();
  await expect(page.locator(".session-list__item")).toHaveCount(0);
});

test("a session already marked PRESENT shows the present state", async ({
  page,
}) => {
  await mockEligible(page, [
    eligibleSession({ currentAttendanceState: "PRESENT" }),
  ]);
  await openAttendancePage(page);

  const item = page
    .locator(".session-list__item")
    .filter({ hasText: COURSE_TITLE });
  await expect(item).toContainText("Present");
  await expect(
    page.getByRole("button", { name: "Mark attendance for E2E-101" })
  ).toHaveCount(0);
});

test("a session marked LATE shows the late state", async ({ page }) => {
  await mockEligible(page, [
    eligibleSession({ currentAttendanceState: "LATE" }),
  ]);
  await openAttendancePage(page);

  const item = page
    .locator(".session-list__item")
    .filter({ hasText: COURSE_TITLE });
  await expect(item).toContainText("Late");
  await expect(
    page.getByRole("button", { name: "Mark attendance for E2E-101" })
  ).toHaveCount(0);
});

test("a server failure on load is recoverable with Retry", async ({ page }) => {
  await loginAsStudent(page);

  await page.route("**/api/student/attendance/eligible", (route) =>
    route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({ error: "INTERNAL_ERROR", message: "boom" }),
    })
  );

  await page.goto("/app/student/attendance");

  await expect(
    page.getByText("Something went wrong. Please try again later.")
  ).toBeVisible();
  await page.unroute("**/api/student/attendance/eligible");
  await page.getByRole("button", { name: "Retry" }).click();

  await expect(page.getByRole("button", { name: "Mark attendance for E2E-101" })).toBeVisible();
});

test("a student can mark attendance end-to-end with a device", async ({
  page,
}) => {
  await loginAsStudent(page);
  await enrollDeviceOnVirtualAuthenticator(page);

  await page.goto("/app/student/attendance");

  await page.getByRole("button", { name: "Mark attendance for E2E-101" }).click();

  await expect(page.locator(".mark-confirmation")).toContainText(
    "Attendance marked as"
  );
  await expect(page.locator(".mark-confirmation")).toContainText("E2E-101");

  const item = page
    .locator(".session-list__item")
    .filter({ hasText: COURSE_TITLE });
  await expect(item.first()).toContainText("Late");
  await expect(
    page.getByRole("button", { name: "Mark attendance for E2E-101" })
  ).toHaveCount(0);
});

test("already-marked sessions surface a clear error", async ({ page }) => {
  await mockEligible(page, [eligibleSession()]);
  await mockDeviceChallenge(page);
  await mockMarkFailure(page, 409, "ALREADY_MARKED");
  await stubDeviceGet(page, "resolve");

  await openAttendancePage(page);
  await page.getByRole("button", { name: "Mark attendance for E2E-101" }).click();

  await expect(
    page.getByRole("alert").filter({
      hasText: "Attendance has already been marked for this session.",
    })
  ).toBeVisible();
});

test("a session that is no longer active surfaces a clear error", async ({
  page,
}) => {
  await mockEligible(page, [eligibleSession()]);
  await mockDeviceChallenge(page);
  await mockMarkFailure(page, 409, "SESSION_NOT_ACTIVE");
  await stubDeviceGet(page, "resolve");

  await openAttendancePage(page);
  await page.getByRole("button", { name: "Mark attendance for E2E-101" }).click();

  await expect(
    page
      .getByRole("alert")
      .filter({ hasText: "This attendance session is no longer active." })
  ).toBeVisible();
});

test("browsers without WebAuthn show a clear error instead of failing silently", async ({
  page,
}) => {
  await mockEligible(page, [eligibleSession()]);
  await disableWebAuthn(page);

  await openAttendancePage(page);
  await page.getByRole("button", { name: "Mark attendance for E2E-101" }).click();

  await expect(
    page
      .getByRole("alert")
      .filter({
        hasText:
          "Device verification is not supported in this browser. Please use a browser that supports WebAuthn.",
      })
  ).toBeVisible();
});

test("cancelling device verification shows a friendly message and keeps the button usable", async ({
  page,
}) => {
  await mockEligible(page, [eligibleSession()]);
  await mockDeviceChallenge(page);
  await stubDeviceGet(page, "cancel");

  await openAttendancePage(page);
  await page.getByRole("button", { name: "Mark attendance for E2E-101" }).click();

  await expect(
    page
      .getByRole("alert")
      .filter({ hasText: "Device verification was cancelled." })
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Mark attendance for E2E-101" })).toBeEnabled();
});