import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
import {
  E2E_ADMIN,
  E2E_LECTURER,
  E2E_STUDENT,
  E2E_STUDENT_ACTIVE_MANAGEMENT,
  E2E_STUDENT_INACTIVE_MANAGEMENT,
  E2E_STUDENT_PENDING_MANAGEMENT,
  E2E_STUDENT_RESET_MANAGEMENT,
} from "./constants";
import { withLoginMutex } from "./helpers/login-mutex";

test.describe.configure({ mode: "serial" });

const MANAGEMENT_NAME_FILTER = "Management";
const MANAGEMENT_DEVICE_LABEL = "E2E Management Device";

async function loginAsAdmin(page: Page): Promise<void> {
  await page.goto("/staff/admin/login");
  await page.getByLabel("Username").fill(E2E_ADMIN.username);
  await page.getByLabel("Password").fill(E2E_ADMIN.password);
  await withLoginMutex("admin", async () => {
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page).toHaveURL(/\/app\/admin$/, { timeout: 15_000 });
  });
}

async function openStudentsPage(page: Page): Promise<void> {
  await loginAsAdmin(page);
  await page.goto("/app/admin/students");
  await expect(
    page.getByRole("heading", { level: 1, name: "Student Management" })
  ).toBeVisible();
}

function studentRow(page: Page, matricNumber: string): Locator {
  return page
    .locator(".admin-table__row")
    .filter({ hasText: matricNumber });
}

async function filterToStudent(page: Page, matricNumber: string): Promise<void> {
  await page.getByLabel("Matric Number").fill(matricNumber);
  await expect(studentRow(page, matricNumber)).toBeVisible();
}

async function getStudentId(page: Page, matricNumber: string): Promise<number> {
  const response = await page.request.get(
    `/api/admin/students?matricNumber=${encodeURIComponent(matricNumber)}`
  );
  expect(response.ok()).toBeTruthy();
  const payload = (await response.json()) as {
    data: { items: Array<{ studentId: number }> };
  };
  const item = payload.data.items[0];
  expect(item).toBeDefined();
  return item.studentId;
}

/**
 * Attach a Chromium virtual authenticator to the page so the real WebAuthn
 * enrollment ceremony runs against the real backend. Test-only: production
 * code and the cryptographic verification path are untouched.
 */
async function addVirtualAuthenticator(page: Page): Promise<void> {
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
}

test("an unauthenticated user is redirected to the admin login page", async ({
  page,
}) => {
  await page.goto("/app/admin/students");

  await expect(page).toHaveURL(/\/staff\/admin\/login$/);
  await expect(
    page.getByRole("heading", { level: 1, name: "Admin Login" })
  ).toBeVisible();
});

test("a student cannot reach the student management page", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("Matric Number").fill(E2E_STUDENT.matricNumber);
  await page.getByLabel("Password").fill(E2E_STUDENT.password);
  await withLoginMutex("student", async () => {
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page).toHaveURL(/\/app\/student$/, { timeout: 15_000 });
  });

  await page.goto("/app/admin/students");

  await expect(page).toHaveURL(/\/app\/student$/);
  await expect(
    page.getByRole("heading", { level: 1, name: "Student Home" })
  ).toBeVisible();
});

test("a lecturer cannot reach the student management page", async ({
  page,
}) => {
  await page.goto("/staff/lecturer/login");
  await page.getByLabel("Staff ID").fill(E2E_LECTURER.staffId);
  await page.getByLabel("Password").fill(E2E_LECTURER.password);
  await withLoginMutex("lecturer", async () => {
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page).toHaveURL(/\/app\/lecturer$/, { timeout: 15_000 });
  });

  await page.goto("/app/admin/students");

  await expect(page).toHaveURL(/\/app\/lecturer$/);
  await expect(
    page.getByRole("heading", { level: 1, name: "Lecturer Home" })
  ).toBeVisible();
});

test("the admin home links to student management and the page renders", async ({
  page,
}) => {
  await loginAsAdmin(page);

  const link = page.getByRole("link", { name: "Student Management" });
  await expect(link).toBeVisible();
  await expect(link).toHaveAttribute("href", "/app/admin/students");

  await link.click();

  await expect(page).toHaveURL(/\/app\/admin\/students$/);
  await expect(
    page.getByRole("heading", { level: 1, name: "Student Management" })
  ).toBeVisible();
  await expect(
    page.getByText(
      "Search, view, deactivate, reactivate, and reset the registration of student accounts."
    )
  ).toBeVisible();
  await expect(page.getByText("Back to Admin Home")).toBeVisible();
});

test("the list shows the management students with their statuses and count", async ({
  page,
}) => {
  await openStudentsPage(page);
  await page.getByLabel("Student Name").fill(MANAGEMENT_NAME_FILTER);

  await expect(page.getByText("4 students")).toBeVisible();
  await expect(page.locator(".admin-table__row")).toHaveCount(4);

  await expect(
    studentRow(page, E2E_STUDENT_ACTIVE_MANAGEMENT.matricNumber)
  ).toContainText(E2E_STUDENT_ACTIVE_MANAGEMENT.name);
  await expect(
    studentRow(page, E2E_STUDENT_ACTIVE_MANAGEMENT.matricNumber)
      .locator(".student-status")
      .first()
  ).toHaveText("ACTIVE");

  await expect(
    studentRow(page, E2E_STUDENT_INACTIVE_MANAGEMENT.matricNumber)
  ).toContainText(E2E_STUDENT_INACTIVE_MANAGEMENT.name);
  await expect(
    studentRow(page, E2E_STUDENT_INACTIVE_MANAGEMENT.matricNumber)
      .locator(".student-status")
      .first()
  ).toHaveText("INACTIVE");

  await expect(
    studentRow(page, E2E_STUDENT_PENDING_MANAGEMENT.matricNumber)
  ).toContainText(E2E_STUDENT_PENDING_MANAGEMENT.name);
  await expect(
    studentRow(page, E2E_STUDENT_PENDING_MANAGEMENT.matricNumber)
      .locator(".student-status")
      .first()
  ).toHaveText("PENDING");

  await expect(
    studentRow(page, E2E_STUDENT_RESET_MANAGEMENT.matricNumber)
  ).toContainText(E2E_STUDENT_RESET_MANAGEMENT.name);
  await expect(
    studentRow(page, E2E_STUDENT_RESET_MANAGEMENT.matricNumber)
      .locator(".student-status")
      .first()
  ).toHaveText("ACTIVE");
});

test("the matric and name filters narrow the list", async ({ page }) => {
  await openStudentsPage(page);

  await page.getByLabel("Matric Number").fill(
    E2E_STUDENT_PENDING_MANAGEMENT.matricNumber
  );
  await expect(
    studentRow(page, E2E_STUDENT_PENDING_MANAGEMENT.matricNumber)
  ).toBeVisible();
  await expect(
    studentRow(page, E2E_STUDENT_PENDING_MANAGEMENT.matricNumber)
  ).toContainText(E2E_STUDENT_PENDING_MANAGEMENT.name);
  await expect(page.locator(".admin-table__row")).toHaveCount(1);

  await page.getByLabel("Matric Number").fill("");
  await page.getByLabel("Student Name").fill("Reset Management");
  await expect(
    studentRow(page, E2E_STUDENT_RESET_MANAGEMENT.matricNumber)
  ).toBeVisible();
  await expect(
    studentRow(page, E2E_STUDENT_RESET_MANAGEMENT.matricNumber)
  ).toContainText(E2E_STUDENT_RESET_MANAGEMENT.name);
  await expect(page.locator(".admin-table__row")).toHaveCount(1);
});

test("the status filter scopes to the matching management student", async ({
  page,
}) => {
  await openStudentsPage(page);
  await page.getByLabel("Student Name").fill(MANAGEMENT_NAME_FILTER);

  await page.getByLabel("Status").selectOption("PENDING");
  await expect(
    studentRow(page, E2E_STUDENT_PENDING_MANAGEMENT.matricNumber)
  ).toBeVisible();
  await expect(
    studentRow(page, E2E_STUDENT_INACTIVE_MANAGEMENT.matricNumber)
  ).toHaveCount(0);
  await expect(
    studentRow(page, E2E_STUDENT_RESET_MANAGEMENT.matricNumber)
  ).toHaveCount(0);

  await page.getByLabel("Status").selectOption("INACTIVE");
  await expect(
    studentRow(page, E2E_STUDENT_INACTIVE_MANAGEMENT.matricNumber)
  ).toBeVisible();
  await expect(
    studentRow(page, E2E_STUDENT_PENDING_MANAGEMENT.matricNumber)
  ).toHaveCount(0);
  await expect(
    studentRow(page, E2E_STUDENT_RESET_MANAGEMENT.matricNumber)
  ).toHaveCount(0);
});

test("the level and department filters combine with the name filter", async ({
  page,
}) => {
  await openStudentsPage(page);
  await page.getByLabel("Student Name").fill(MANAGEMENT_NAME_FILTER);

  await page.getByLabel("Level").selectOption({ label: "Level 300" });
  await expect(
    page.getByText("No students match the current filters.")
  ).toBeVisible();

  await page.getByLabel("Level").selectOption({ label: "Level 100" });
  await expect(page.locator(".admin-table__row")).toHaveCount(4);

  await page.getByLabel("Department").selectOption({
    label: "E2E Test Department (E2EFLOW)",
  });
  await expect(page.locator(".admin-table__row")).toHaveCount(4);
});

test("an empty filter result shows the empty state and clear filters restores the list", async ({
  page,
}) => {
  await openStudentsPage(page);

  await page.getByLabel("Matric Number").fill("E2E/STU/DOES-NOT-EXIST");
  await expect(
    page.getByText("No students match the current filters.")
  ).toBeVisible();
  await expect(page.locator(".admin-table__row")).toHaveCount(0);

  await page.getByRole("button", { name: "Clear filters" }).click();

  await expect(page.getByLabel("Matric Number")).toHaveValue("");
  await expect(
    studentRow(page, E2E_STUDENT_RESET_MANAGEMENT.matricNumber)
  ).toBeVisible();
});

test("a list error renders with a working retry", async ({ page }) => {
  await loginAsAdmin(page);
  await page.route("**/api/admin/students*", async (route) => {
    await route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({ error: "INTERNAL_ERROR" }),
    });
  });

  await page.goto("/app/admin/students");
  await expect(page.getByText("Something went wrong. Please try again later.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();

  await page.unroute("**/api/admin/students*");
  await page.getByRole("button", { name: "Retry" }).click();
  await expect(
    studentRow(page, E2E_STUDENT_RESET_MANAGEMENT.matricNumber)
  ).toBeVisible();
});

test("the page shows a loading indicator while the list request is in flight", async ({
  page,
}) => {
  await loginAsAdmin(page);
  await page.route("**/api/admin/students*", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 700));
    await route.continue();
  });

  await page.goto("/app/admin/students");
  await expect(page.getByText("Loading students…")).toBeVisible({ timeout: 5_000 });
  await expect(
    studentRow(page, E2E_STUDENT_RESET_MANAGEMENT.matricNumber)
  ).toBeVisible({ timeout: 10_000 });
});

test("a department catalog failure shows a note and the list still works", async ({
  page,
}) => {
  await loginAsAdmin(page);
  await page.route("**/api/admin/departments*", async (route) => {
    await route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({ error: "INTERNAL_ERROR" }),
    });
  });

  await page.goto("/app/admin/students");
  await expect(
    page.getByText("Some filter options could not be loaded.")
  ).toBeVisible();
  await expect(
    studentRow(page, E2E_STUDENT_RESET_MANAGEMENT.matricNumber)
  ).toBeVisible();

  await page.unroute("**/api/admin/departments*");
  await page.getByRole("button", { name: "Retry" }).click();
  await expect(page.getByLabel("Department")).toContainText(
    "E2E Test Department (E2EFLOW)"
  );
});

test("the detail view shows only safe information for an inactive student", async ({
  page,
}) => {
  await openStudentsPage(page);
  await filterToStudent(page, E2E_STUDENT_INACTIVE_MANAGEMENT.matricNumber);

  await studentRow(page, E2E_STUDENT_INACTIVE_MANAGEMENT.matricNumber)
    .getByRole("button", { name: "View details" })
    .click();

  const detail = page.getByRole("region", { name: "Student details" });
  await expect(detail).toContainText(E2E_STUDENT_INACTIVE_MANAGEMENT.name);
  await expect(detail).toContainText(E2E_STUDENT_INACTIVE_MANAGEMENT.matricNumber);
  await expect(detail).toContainText("E2E Test Faculty (E2EFAC)");
  await expect(detail).toContainText("E2E Test Department (E2EFLOW)");
  await expect(detail).toContainText("Level 100");
  await expect(detail).toContainText("INACTIVE");
  await expect(detail).toContainText("No device");
  await expect(detail).toContainText("Created:");
  await expect(detail).toContainText("Enrolled Courses:");
  await expect(detail).toContainText("0 courses");

  await detail.getByRole("button", { name: "Close details" }).click();
  await expect(detail).toHaveCount(0);
});

test("a pending student has no status control", async ({ page }) => {
  await openStudentsPage(page);
  await filterToStudent(page, E2E_STUDENT_PENDING_MANAGEMENT.matricNumber);

  const row = studentRow(page, E2E_STUDENT_PENDING_MANAGEMENT.matricNumber);
  await expect(row.locator(".student-status").first()).toHaveText("PENDING");
  await expect(row.getByRole("button", { name: "Deactivate" })).toHaveCount(0);
  await expect(row.getByRole("button", { name: "Reactivate" })).toHaveCount(0);
  await expect(row.getByRole("button", { name: "Reset registration" })).toHaveCount(0);
  await expect(row.getByRole("button", { name: "View details" })).toBeVisible();
});

test("cancelling a status action leaves the student unchanged", async ({
  page,
}) => {
  await openStudentsPage(page);
  await filterToStudent(page, E2E_STUDENT_ACTIVE_MANAGEMENT.matricNumber);

  const row = studentRow(page, E2E_STUDENT_ACTIVE_MANAGEMENT.matricNumber);
  await row.getByRole("button", { name: "Deactivate" }).click();
  await expect(page.locator(".confirm-message")).toContainText(
    E2E_STUDENT_ACTIVE_MANAGEMENT.name
  );

  await page.getByRole("button", { name: "Cancel" }).click();

  await expect(page.locator(".confirm-message")).toHaveCount(0);
  await expect(page.locator(".resource-success")).toHaveCount(0);
  await expect(row.locator(".student-status--active")).toBeVisible();
});

test("an admin can deactivate an active student", async ({ page }) => {
  await openStudentsPage(page);
  await filterToStudent(page, E2E_STUDENT_ACTIVE_MANAGEMENT.matricNumber);

  const row = studentRow(page, E2E_STUDENT_ACTIVE_MANAGEMENT.matricNumber);
  await row.getByRole("button", { name: "Deactivate" }).click();
  await expect(page.locator(".confirm-message")).toContainText(
    "no longer be able to sign in"
  );

  await page.getByRole("button", { name: "Confirm Deactivate" }).click();

  await expect(page.locator(".resource-success")).toContainText("deactivated");
  await expect(row.locator(".student-status--inactive")).toBeVisible();
  await expect(row.getByRole("button", { name: "Reactivate" })).toBeVisible();
});

test("an activation that the backend rejects renders the ACTIVE_REQUIRES_PASSWORD error", async ({
  page,
}) => {
  await loginAsAdmin(page);
  await page.route("**/api/admin/students/*/status", async (route) => {
    await route.fulfill({
      status: 409,
      contentType: "application/json",
      body: JSON.stringify({
        error: "ACTIVE_REQUIRES_PASSWORD",
        message: "The account has no password and cannot be activated.",
      }),
    });
  });

  await page.goto("/app/admin/students");
  await filterToStudent(page, E2E_STUDENT_ACTIVE_MANAGEMENT.matricNumber);

  const row = studentRow(page, E2E_STUDENT_ACTIVE_MANAGEMENT.matricNumber);
  await row.getByRole("button", { name: "Reactivate" }).click();
  await page.getByRole("button", { name: "Confirm Reactivate" }).click();

  await expect(page.locator(".resource-error")).toContainText(
    "cannot be activated"
  );
  await expect(row.locator(".student-status--inactive")).toBeVisible();
  await expect(page.locator(".resource-success")).toHaveCount(0);
});

test("an admin can reactivate an inactive student", async ({ page }) => {
  await openStudentsPage(page);
  await filterToStudent(page, E2E_STUDENT_ACTIVE_MANAGEMENT.matricNumber);

  const row = studentRow(page, E2E_STUDENT_ACTIVE_MANAGEMENT.matricNumber);
  await expect(row.locator(".student-status--inactive")).toBeVisible();
  await row.getByRole("button", { name: "Reactivate" }).click();
  await expect(page.locator(".confirm-message")).toContainText("sign in again");

  await page.getByRole("button", { name: "Confirm Reactivate" }).click();

  await expect(page.locator(".resource-success")).toContainText("reactivated");
  await expect(row.locator(".student-status--active")).toBeVisible();
});

test("a NO_OP status change renders the backend conflict error", async ({
  page,
}) => {
  await loginAsAdmin(page);
  await page.route("**/api/admin/students/*/status", async (route) => {
    await route.fulfill({
      status: 409,
      contentType: "application/json",
      body: JSON.stringify({
        error: "NO_OP_CORRECTION",
        message: "The student already has this status; no change was made.",
      }),
    });
  });

  await page.goto("/app/admin/students");
  await filterToStudent(page, E2E_STUDENT_ACTIVE_MANAGEMENT.matricNumber);

  const row = studentRow(page, E2E_STUDENT_ACTIVE_MANAGEMENT.matricNumber);
  await row.getByRole("button", { name: "Deactivate" }).click();
  await page.getByRole("button", { name: "Confirm Deactivate" }).click();

  await expect(page.locator(".resource-error")).toContainText(
    "already has this status"
  );
  await expect(row.locator(".student-status--active")).toBeVisible();
  await expect(page.locator(".resource-success")).toHaveCount(0);
});

test("an invalid reset renders the INVALID_STUDENT_STATE rejection", async ({
  page,
}) => {
  await loginAsAdmin(page);
  await page.route("**/api/admin/students/*/reset-registration", async (route) => {
    await route.fulfill({
      status: 409,
      contentType: "application/json",
      body: JSON.stringify({
        error: "INVALID_STUDENT_STATE",
        message: "Only active students may be reset for re-registration.",
      }),
    });
  });

  await page.goto("/app/admin/students");
  await filterToStudent(page, E2E_STUDENT_ACTIVE_MANAGEMENT.matricNumber);

  const row = studentRow(page, E2E_STUDENT_ACTIVE_MANAGEMENT.matricNumber);
  await row.getByRole("button", { name: "Reset registration" }).click();
  await page.getByRole("button", { name: "Confirm Reset" }).click();

  await expect(page.locator(".resource-error")).toContainText(
    "Only active students can have their registration reset."
  );
  await expect(row.locator(".student-status--active")).toBeVisible();
  await expect(page.locator(".resource-success")).toHaveCount(0);
});

test("a missing student renders the NOT_FOUND handling on reset", async ({
  page,
}) => {
  await loginAsAdmin(page);
  await page.route("**/api/admin/students/*/reset-registration", async (route) => {
    await route.fulfill({
      status: 404,
      contentType: "application/json",
      body: JSON.stringify({
        error: "NOT_FOUND",
        message: "The student was not found.",
      }),
    });
  });

  await page.goto("/app/admin/students");
  await filterToStudent(page, E2E_STUDENT_ACTIVE_MANAGEMENT.matricNumber);

  const row = studentRow(page, E2E_STUDENT_ACTIVE_MANAGEMENT.matricNumber);
  await row.getByRole("button", { name: "Reset registration" }).click();
  await page.getByRole("button", { name: "Confirm Reset" }).click();

  await expect(page.locator(".resource-error")).toContainText(
    "The student was not found."
  );
  await expect(page.locator(".resource-success")).toHaveCount(0);
});

test("a student can enroll a device for device-column coverage", async ({
  page,
}) => {
  await page.goto("/login");
  await page
    .getByLabel("Matric Number")
    .fill(E2E_STUDENT_ACTIVE_MANAGEMENT.matricNumber);
  await page.getByLabel("Password").fill(E2E_STUDENT_ACTIVE_MANAGEMENT.password);
  await withLoginMutex("student", async () => {
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page).toHaveURL(/\/app\/student$/, { timeout: 15_000 });
  });

  await addVirtualAuthenticator(page);
  await page.goto("/app/student/device");
  await expect(
    page.getByRole("heading", { level: 1, name: "Device Enrollment" })
  ).toBeVisible();
  await expect(page.locator(".device-status--none")).toContainText(
    "No Active Device"
  );

  await page.getByLabel("Device Label (optional)").fill(MANAGEMENT_DEVICE_LABEL);
  await page.getByRole("button", { name: "Register This Device" }).click();

  await expect(page.locator(".device-enrolled")).toContainText("Device Active", {
    timeout: 15_000,
  });
  await expect(page.locator(".device-details")).toContainText(MANAGEMENT_DEVICE_LABEL);
});

test("the admin sees the enrolled device as active and summarized safely", async ({
  page,
}) => {
  await openStudentsPage(page);
  await filterToStudent(page, E2E_STUDENT_ACTIVE_MANAGEMENT.matricNumber);

  const row = studentRow(page, E2E_STUDENT_ACTIVE_MANAGEMENT.matricNumber);
  await expect(row.locator(".student-status").nth(1)).toHaveText("Active");

  await row.getByRole("button", { name: "View details" }).click();
  const detail = page.getByRole("region", { name: "Student details" });
  await expect(detail).toContainText("Device Summary");
  await expect(detail).toContainText(MANAGEMENT_DEVICE_LABEL);
  await expect(detail).toContainText("Enrolled");

  const studentId = await getStudentId(
    page,
    E2E_STUDENT_ACTIVE_MANAGEMENT.matricNumber
  );
  const detailResponse = await page.request.get(
    `/api/admin/students/${studentId}`
  );
  expect(detailResponse.ok()).toBeTruthy();
  const detailPayload = (await detailResponse.json()) as {
    data: { device: { credentialId: string } | null };
  };
  const rawCredentialId = detailPayload.data.device?.credentialId ?? "";
  expect(rawCredentialId.length).toBeGreaterThan(0);

  const detailText = await detail.innerText();
  expect(detailText).not.toContain(rawCredentialId);
  await expect(detail.locator("code")).toHaveCount(0);
});

test("resetting a student's registration explains the consequences and clears the password", async ({
  page,
}) => {
  await openStudentsPage(page);
  await filterToStudent(page, E2E_STUDENT_RESET_MANAGEMENT.matricNumber);

  const row = studentRow(page, E2E_STUDENT_RESET_MANAGEMENT.matricNumber);
  await row.getByRole("button", { name: "Reset registration" }).click();

  const confirm = page.locator(".confirm-row--block");
  await expect(confirm).toContainText("Reset registration for");
  await expect(confirm).toContainText("return their account to PENDING");
  await expect(confirm).toContainText("clear their password");
  await expect(confirm).toContainText("complete student registration again");
  await expect(confirm).toContainText("keep their enrolled-course history intact");
  await expect(confirm).toContainText("retain their existing active device for now");

  await page.getByRole("button", { name: "Confirm Reset" }).click();

  await expect(page.locator(".resource-success")).toContainText("now pending");
  await expect(row.locator(".student-status--pending")).toBeVisible();
  await expect(row.getByRole("button", { name: "View details" })).toBeVisible();
  await expect(row.getByRole("button", { name: "Reset registration" })).toHaveCount(0);

  const studentId = await getStudentId(
    page,
    E2E_STUDENT_RESET_MANAGEMENT.matricNumber
  );
  const reactivation = await page.request.patch(
    `/api/admin/students/${studentId}/status`,
    { data: { status: "ACTIVE" } }
  );
  expect(reactivation.status()).toBe(409);
  const payload = (await reactivation.json()) as { error?: string };
  expect(payload.error).toBe("ACTIVE_REQUIRES_PASSWORD");
});

test("the backend enforces the student status and reset guards", async ({
  page,
}) => {
  await loginAsAdmin(page);

  const inactiveId = await getStudentId(
    page,
    E2E_STUDENT_INACTIVE_MANAGEMENT.matricNumber
  );
  const pendingId = await getStudentId(
    page,
    E2E_STUDENT_PENDING_MANAGEMENT.matricNumber
  );

  const noOp = await page.request.patch(`/api/admin/students/${inactiveId}/status`, {
    data: { status: "INACTIVE" },
  });
  expect(noOp.status()).toBe(409);
  expect(((await noOp.json()) as { error?: string }).error).toBe("NO_OP_CORRECTION");

  const inactiveReset = await page.request.post(
    `/api/admin/students/${inactiveId}/reset-registration`
  );
  expect(inactiveReset.status()).toBe(409);
  expect(((await inactiveReset.json()) as { error?: string }).error).toBe(
    "INVALID_STUDENT_STATE"
  );

  const pendingActivation = await page.request.patch(
    `/api/admin/students/${pendingId}/status`,
    { data: { status: "ACTIVE" } }
  );
  expect(pendingActivation.status()).toBe(409);
  expect(((await pendingActivation.json()) as { error?: string }).error).toBe(
    "ACTIVE_REQUIRES_PASSWORD"
  );

  const alreadyPending = await page.request.post(
    `/api/admin/students/${pendingId}/reset-registration`
  );
  expect(alreadyPending.status()).toBe(409);
  expect(((await alreadyPending.json()) as { error?: string }).error).toBe(
    "ALREADY_PENDING"
  );

  const missingStudent = await page.request.patch(
    "/api/admin/students/999999/status",
    { data: { status: "INACTIVE" } }
  );
  expect(missingStudent.status()).toBe(404);
  expect(((await missingStudent.json()) as { error?: string }).error).toBe(
    "NOT_FOUND"
  );

  const missingReset = await page.request.post(
    "/api/admin/students/999999/reset-registration"
  );
  expect(missingReset.status()).toBe(404);
});

test("sensitive credential material is never rendered on the page", async ({
  page,
}) => {
  await openStudentsPage(page);
  await filterToStudent(page, E2E_STUDENT_ACTIVE_MANAGEMENT.matricNumber);

  const row = studentRow(page, E2E_STUDENT_ACTIVE_MANAGEMENT.matricNumber);
  await row.getByRole("button", { name: "View details" }).click();
  await expect(
    page.getByRole("region", { name: "Student details" })
  ).toContainText("Device Summary");

  const studentId = await getStudentId(
    page,
    E2E_STUDENT_ACTIVE_MANAGEMENT.matricNumber
  );
  const detailResponse = await page.request.get(
    `/api/admin/students/${studentId}`
  );
  expect(detailResponse.ok()).toBeTruthy();
  const detailPayload = (await detailResponse.json()) as {
    data: { device: { credentialId: string } | null };
  };
  const rawCredentialId = detailPayload.data.device?.credentialId ?? "";

  const bodyText = await page.locator("body").innerText();
  expect(rawCredentialId).not.toBe("");
  expect(bodyText).not.toContain(rawCredentialId);
  expect(bodyText.toLowerCase()).not.toContain("public key");
  expect(bodyText.toLowerCase()).not.toContain("password hash");
  expect(bodyText.toLowerCase()).not.toContain("password_hash");
  expect(bodyText.toLowerCase()).not.toContain("session token");
  expect(bodyText.toLowerCase()).not.toContain("challenge");
  expect(bodyText.toLowerCase()).not.toContain("credential id");
});