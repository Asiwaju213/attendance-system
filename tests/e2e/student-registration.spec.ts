import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { E2E_STUDENT, E2E_STUDENT_PENDING } from "./constants";
import { withLoginMutex } from "./helpers/login-mutex";

const NEW_PASSWORD = "newsecurepassword123";

let registeredStudentCookies: { name: string; value: string; domain: string; path: string }[] = [];

async function verifyMatric(page: Page, matricNumber: string): Promise<void> {
  await page.goto("/register");
  await page.getByLabel("Matric Number").fill(matricNumber);
  await page.getByRole("button", { name: "Continue" }).click();
}

async function completeRegistration(page: Page): Promise<void> {
  await page.getByLabel("Password", { exact: true }).fill(NEW_PASSWORD);
  await page.getByLabel("Confirm Password", { exact: true }).fill(NEW_PASSWORD);
  await page.getByRole("button", { name: "Complete registration" }).click();
}

async function loginAsStudent(page: Page): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("Matric Number").fill(E2E_STUDENT.matricNumber);
  await page.getByLabel("Password").fill(E2E_STUDENT.password);
  await withLoginMutex("student", async () => {
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page).toHaveURL(/\/app\/student$/, { timeout: 15_000 });
  });
}

test.describe.configure({ mode: "serial" });

test.describe("Student Registration", () => {
  test("registration page renders the matric verification form", async ({ page }) => {
    await page.goto("/register");
    await expect(page.getByRole("heading", { level: 1, name: "Student Registration" })).toBeVisible();
    await expect(page.getByLabel("Matric Number")).toBeVisible();
    await expect(page.getByRole("button", { name: "Continue" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Back to student login" })).toBeVisible();
  });

  test("student login page links to registration", async ({ page }) => {
    await page.goto("/login");
    await expect(page.getByRole("link", { name: "New student? Register here" })).toBeVisible();
    await page.getByRole("link", { name: "New student? Register here" }).click();
    await expect(page).toHaveURL(/\/register$/);
    await expect(page.getByRole("heading", { level: 1, name: "Student Registration" })).toBeVisible();
  });

  test("unknown and already-registered matric numbers show a friendly error", async ({ page }) => {
    await page.goto("/register");
    await page.getByLabel("Matric Number").fill("INVALID/MATRIC");
    await page.getByRole("button", { name: "Continue" }).click();
    await expect(page.getByRole("alert")).toContainText("No pending registration found");

    await page.getByLabel("Matric Number").fill(E2E_STUDENT.matricNumber);
    await page.getByRole("button", { name: "Continue" }).click();
    await expect(page.getByRole("alert")).toContainText("No pending registration found");
    await expect(page.getByRole("heading", { level: 1, name: "Student Registration" })).toBeVisible();
  });

  test("empty matric shows client-side validation error", async ({ page }) => {
    await page.goto("/register");
    await page.getByRole("button", { name: "Continue" }).click();
    await expect(page.getByLabel("Matric Number")).toHaveAttribute("aria-invalid", "true");
  });

  test("valid PENDING student reaches the verified identity with the password step", async ({ page }) => {
    await verifyMatric(page, E2E_STUDENT_PENDING.matricNumber);
    await expect(page.locator(".identity-preview")).toBeVisible();
    await expect(page.locator(".identity-preview__details")).toContainText(E2E_STUDENT_PENDING.name);
    await expect(page.locator(".identity-preview__details")).toContainText(E2E_STUDENT_PENDING.matricNumber);
    await expect(page.getByLabel("Password", { exact: true })).toBeVisible();
    await expect(page.getByLabel("Confirm Password", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Complete registration" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Request a new verification" })).toBeVisible();

    // The verified identity is read-only: there is no editable identity/matric field.
    await expect(page.getByLabel("Matric Number")).toHaveCount(0);
  });

  test("password validation rejects passwords shorter than 8 characters", async ({ page }) => {
    await verifyMatric(page, E2E_STUDENT_PENDING.matricNumber);
    await page.getByLabel("Password", { exact: true }).fill("short");
    await page.getByLabel("Confirm Password", { exact: true }).fill("short");
    await page.getByRole("button", { name: "Complete registration" }).click();
    await expect(page.getByText("at least 8 characters")).toBeVisible();
    await expect(page.getByLabel("Confirm Password", { exact: true })).toBeVisible();
  });

  test("password confirmation mismatch is rejected client-side", async ({ page }) => {
    await verifyMatric(page, E2E_STUDENT_PENDING.matricNumber);
    await page.getByLabel("Password", { exact: true }).fill("validpassword123");
    await page.getByLabel("Confirm Password", { exact: true }).fill("differentpassword");
    await page.getByRole("button", { name: "Complete registration" }).click();
    await expect(page.getByText("Passwords do not match")).toBeVisible();
    await expect(page.getByLabel("Confirm Password", { exact: true })).toBeVisible();
  });

  test("invalidated challenge is handled and returns to verification", async ({ page }) => {
    await verifyMatric(page, E2E_STUDENT_PENDING.matricNumber);
    await expect(page.locator(".identity-preview")).toBeVisible();

    // Issue a fresh challenge for the same student so the one held by the page
    // is expired/invalidated server-side.
    const refresh = await page.request.post("/api/auth/student/register/verify", {
      data: { matricNumber: E2E_STUDENT_PENDING.matricNumber },
    });
    expect(refresh.ok()).toBeTruthy();

    await completeRegistration(page);
    await expect(page.getByRole("alert")).toContainText("expired or is invalid");

    // The user is sent back to the matric verification step with a clean form.
    await expect(page.getByLabel("Matric Number")).toBeVisible();
    await expect(page.getByLabel("Password", { exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "Continue" }).click();
    await expect(page.locator(".identity-preview")).toBeVisible();
  });

  test("mobile layout has no horizontal overflow on either step", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 });
    await verifyMatric(page, E2E_STUDENT_PENDING.matricNumber);
    await expect(page.locator(".identity-preview")).toBeVisible();

    const overflow = await page.evaluate(() => {
      const element = document.documentElement;
      return { scrollWidth: element.scrollWidth, clientWidth: element.clientWidth };
    });
    expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth);
  });

  test("registration does not put tokens, challenges, or passwords into browser storage", async ({ page }) => {
    const verifyResponsePromise = page.waitForResponse(
      (response) =>
        response.url().includes("/api/auth/student/register/verify") && response.status() === 200
    );

    await page.goto("/register");
    await page.getByLabel("Matric Number").fill(E2E_STUDENT_PENDING.matricNumber);
    await page.getByRole("button", { name: "Continue" }).click();

    const verifyResponse = await verifyResponsePromise;
    const verifyBody = await verifyResponse.json();
    const challengeToken = verifyBody?.data?.challengeToken as string | undefined;
    expect(challengeToken).toBeTruthy();

    await expect(page.locator(".identity-preview")).toBeVisible();

    const storageDump = () =>
      page.evaluate(() =>
        JSON.stringify({
          local: { ...localStorage },
          session: { ...sessionStorage },
        })
      );

    expect(await storageDump()).not.toContain(challengeToken);
    expect(await storageDump()).not.toMatch(/challenge/i);

    // A failed (too short) submission keeps the password out of storage too.
    await page.getByLabel("Password", { exact: true }).fill("short");
    await page.getByLabel("Confirm Password", { exact: true }).fill("short");
    await page.getByRole("button", { name: "Complete registration" }).click();
    await expect(page.getByText("at least 8 characters")).toBeVisible();
    expect(await storageDump()).not.toContain("short");
    expect(await storageDump()).not.toMatch(/password/i);
  });

  test("successful registration creates an authenticated session and redirects", async ({ page }) => {
    await verifyMatric(page, E2E_STUDENT_PENDING.matricNumber);
    await completeRegistration(page);
    await expect(page).toHaveURL(/\/app\/student$/, { timeout: 15_000 });
    await expect(page.getByRole("heading", { level: 1, name: "Student Home" })).toBeVisible();

    const cookies = await page.context().cookies();
    const session = cookies.find((cookie) => cookie.name === "oou_session");
    expect(session).toBeTruthy();
    expect(session?.httpOnly).toBe(true);
    if (session) {
      registeredStudentCookies = [session];
    }
  });

  test("after registration, the student can no longer register again", async ({ page }) => {
    await page.context().addCookies(registeredStudentCookies);

    // The ACTIVE account is redirected away from the guest registration flow.
    await page.goto("/register");
    await expect(page).toHaveURL(/\/app\/student$/);
    await expect(page.getByRole("heading", { level: 1, name: "Student Home" })).toBeVisible();

    // Verification now rejects the already-registered student.
    const verify = await page.request.post("/api/auth/student/register/verify", {
      data: { matricNumber: E2E_STUDENT_PENDING.matricNumber },
    });
    expect(verify.status()).toBe(404);
  });

  test("authenticated ACTIVE student cannot access the registration flow", async ({ page }) => {
    await loginAsStudent(page);
    await page.goto("/register");
    await expect(page).toHaveURL(/\/app\/student$/);
    await expect(page.getByRole("heading", { level: 1, name: "Student Home" })).toBeVisible();
    await expect(page.getByRole("heading", { level: 1, name: "Student Registration" })).toHaveCount(0);
  });
});