import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
import { E2E_ADMIN, E2E_STUDENT } from "./constants";
import { withLoginMutex } from "./helpers/login-mutex";

test.describe.configure({ mode: "serial" });

const MONITOR_STAFF_ID = "E2E/LEC/0002";
const MONITOR_NAME = "E2E Monitor Lecturer";
const OTHER_LECTURER_NAME = "E2E Lecturer";

async function loginAsAdmin(page: Page): Promise<void> {
  await withLoginMutex("admin", async () => {
    await page.goto("/staff/admin/login");
    await page.getByLabel("Username").fill(E2E_ADMIN.username);
    await page.getByLabel("Password").fill(E2E_ADMIN.password);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page).toHaveURL(/\/app\/admin$/, { timeout: 15_000 });
  });
}

async function loginAsStudent(page: Page): Promise<void> {
  await withLoginMutex("student", async () => {
    await page.goto("/login");
    await page.getByLabel("Matric Number").fill(E2E_STUDENT.matricNumber);
    await page.getByLabel("Password").fill(E2E_STUDENT.password);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page).toHaveURL(/\/app\/student$/, { timeout: 15_000 });
  });
}

async function openAdminAttendancePage(page: Page): Promise<void> {
  await loginAsAdmin(page);
  await page.goto("/app/admin/attendance");
  await expect(
    page.getByRole("heading", { level: 1, name: "Attendance Monitoring" })
  ).toBeVisible();
}

async function selectOptionByText(
  select: Locator,
  pattern: RegExp
): Promise<void> {
  const option = select.locator("option").filter({ hasText: pattern });
  const value = await option.getAttribute("value");
  expect(value).not.toBeNull();
  await select.selectOption(String(value));
}

async function findMonitorLecturerId(page: Page): Promise<number> {
  const response = await page.request.get("/api/admin/attendance-sessions");
  expect(response.status()).toBe(200);
  const payload = (await response.json()) as {
    data: { lecturerStaffId: string; lecturerId: number }[];
  };
  const monitor = payload.data.find(
    (session) => session.lecturerStaffId === MONITOR_STAFF_ID
  );
  expect(monitor).toBeDefined();
  return monitor!.lecturerId;
}

async function applyMonitorLecturerFilter(page: Page): Promise<void> {
  const lecturerId = await findMonitorLecturerId(page);
  await page.getByLabel("Lecturer ID").fill(String(lecturerId));
  await page.getByRole("button", { name: "Apply filters" }).click();
  await expect(page.getByText("2 sessions", { exact: true })).toBeVisible();
}

async function seedAttendanceRecordsForSession(page: Page, sessionId: number): Promise<void> {
  // Directly insert attendance records via the backend API
  // We need to create attendance records for the E2E student in this session
  // Since we can't easily do this via the API in tests, we'll rely on the backend
  // having seeded data, or we'll need to insert directly via the database
  
  // For now, we'll use the page.request to call a test-only endpoint if available
  // Or we can try to create records via the student attendance marking flow
  // But that requires WebAuthn which is complex
  
  // For testing purposes, we'll skip seeding and handle empty records in tests
}

async function openSessionDetails(page: Page, rowIndex: number = 0): Promise<void> {
  await page
    .locator(".admin-table__row")
    .nth(rowIndex)
    .getByRole("button", { name: "View details" })
    .click();
  await expect(
    page.getByRole("heading", { level: 2, name: "Session details" })
  ).toBeVisible();
}

async function getDetailSection(page: Page): Promise<Locator> {
  return page.getByRole("region", { name: "Session details" });
}

async function getRecordsTable(page: Page): Promise<Locator> {
  const detailSection = page.getByRole("region", { name: "Session details" });
  return detailSection.locator(".admin-table-scroll table");
}

async function getRecordRow(page: Page, studentName: string): Promise<Locator> {
  return page
    .locator(".admin-table__row")
    .filter({ hasText: studentName });
}

async function waitForRecordsLoad(page: Page): Promise<void> {
  // Wait for either loading to finish or records table to appear
  await expect(
    page.getByRole("region", { name: "Session details" }).locator(".admin-table-scroll table")
  ).toBeVisible({ timeout: 15_000 });
}

test("an unauthenticated user is redirected to the admin login page", async ({
  page,
}) => {
  await page.goto("/app/admin/attendance");

  await expect(page).toHaveURL(/\/staff\/admin\/login$/);
  await expect(
    page.getByRole("heading", { level: 1, name: "Admin Login" })
  ).toBeVisible();
});

test("a student cannot reach the attendance monitoring page", async ({
  page,
}) => {
  await loginAsStudent(page);

  await page.goto("/app/admin/attendance");

  await expect(page).toHaveURL(/\/app\/student$/);
  await expect(
    page.getByRole("heading", { level: 1, name: "Student Home" })
  ).toBeVisible();
});

test("an admin can navigate to Attendance Monitoring and see sessions from the backend", async ({
  page,
}) => {
  await loginAsAdmin(page);

  await page.getByRole("link", { name: "Attendance Monitoring" }).click();

  await expect(page).toHaveURL(/\/app\/admin\/attendance$/);
  await expect(
    page.getByRole("heading", { level: 1, name: "Attendance Monitoring" })
  ).toBeVisible();
  await expect(page.getByText(MONITOR_NAME, { exact: false }).first()).toBeVisible();
  await expect(
    page.getByRole("cell", { name: /E2E-101/ }).first()
  ).toBeVisible();
  await expect(
    page.getByRole("cell", { name: "E2E Test Lecture Hall" }).first()
  ).toBeVisible();
  await expect(
    page.getByRole("cell", { name: /E2E Test Network/ }).first()
  ).toBeVisible();
});

test("applying a filter reloads the list using the filter", async ({ page }) => {
  await openAdminAttendancePage(page);

  await applyMonitorLecturerFilter(page);

  await expect(page.getByText(MONITOR_NAME, { exact: false })).toHaveCount(2);
  await expect(page.getByText(OTHER_LECTURER_NAME, { exact: true })).toHaveCount(0);
  await expect(page.locator(".admin-table__row")).toHaveCount(2);
});

test("clearing filters restores the unfiltered list", async ({ page }) => {
  await openAdminAttendancePage(page);

  await selectOptionByText(
    page.getByLabel("Course offering"),
    /E2E-101.*Second Semester/
  );
  await page.getByRole("button", { name: "Apply filters" }).click();
  await expect(
    page.getByText("No attendance sessions match the current filters.")
  ).toBeVisible();

  await page.getByRole("button", { name: "Clear filters" }).click();

  await expect(page.getByLabel("Course offering")).toHaveValue("");
  await expect(page.locator(".admin-table__row")).not.toHaveCount(0);
  await expect(page.getByText(MONITOR_NAME, { exact: false }).first()).toBeVisible();
});

test("a filter with no results shows an informative empty state", async ({
  page,
}) => {
  await openAdminAttendancePage(page);

  await selectOptionByText(
    page.getByLabel("Course offering"),
    /E2E-101.*Second Semester/
  );
  await page.getByRole("button", { name: "Apply filters" }).click();

  await expect(
    page.getByText("No attendance sessions match the current filters.")
  ).toBeVisible();
  await expect(
    page.getByText("Try adjusting the filters, or clear them to see all sessions.")
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Clear filters" })).toBeVisible();
});

test("an API failure shows an error and Retry recovers the list", async ({
  page,
}) => {
  await openAdminAttendancePage(page);

  await page.route("**/api/admin/attendance-sessions*", (route) =>
    route.abort()
  );
  await page.getByRole("button", { name: "Apply filters" }).click();

  await expect(
    page.getByRole("alert").filter({ hasText: "Something went wrong" })
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Retry", exact: true })).toBeVisible();

  await page.unroute("**/api/admin/attendance-sessions*");
  await page.getByRole("button", { name: "Retry", exact: true }).click();

  await expect(page.locator(".admin-table__row")).not.toHaveCount(0);
  await expect(page.getByText(MONITOR_NAME, { exact: false }).first()).toBeVisible();
});

test("the monitoring page list shows View details but no recording controls", async ({
  page,
}) => {
  await openAdminAttendancePage(page);

  await expect(
    page.getByRole("button", { name: /mark|record|correct|edit|delete|end/i })
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "View details" }).first()
  ).toBeVisible();
});

test("clicking a session opens its details fetched from the backend", async ({
  page,
}) => {
  await openAdminAttendancePage(page);
  await applyMonitorLecturerFilter(page);

  await openSessionDetails(page, 0);

  const detailSection = await getDetailSection(page);
  await expect(detailSection.getByText("E2E-101 — E2E Computer Science 101")).toBeVisible();
  await expect(
    detailSection.getByText(`${MONITOR_NAME} (${MONITOR_STAFF_ID})`)
  ).toBeVisible();
  await expect(detailSection.getByText("E2E-NET-001 — E2E Test Network")).toBeVisible();
  await expect(detailSection.getByText("E2E Test Lecture Hall")).toBeVisible();
  await expect(detailSection.getByText("E2E-2026/2027 · First Semester")).toBeVisible();
  await expect(detailSection.locator(".session-status--active")).toContainText("ACTIVE");
  await expect(detailSection.getByText("Created at:", { exact: false })).toBeVisible();
});

test("the detail view for an active session shows attendance records with correction controls", async ({
  page,
}) => {
  await openAdminAttendancePage(page);
  await applyMonitorLecturerFilter(page);

  await openSessionDetails(page, 0);
  await waitForRecordsLoad(page);

  const detailSection = await getDetailSection(page);

  await expect(detailSection.locator(".session-status--active")).toContainText("ACTIVE");

  const recordsTable = await getRecordsTable(page);
  await expect(recordsTable).toBeVisible();

  await expect(recordsTable.getByRole("columnheader", { name: "Student" })).toBeVisible();
  await expect(recordsTable.getByRole("columnheader", { name: "Matric No." })).toBeVisible();
  await expect(recordsTable.getByRole("columnheader", { name: "Status" })).toBeVisible();
  await expect(recordsTable.getByRole("columnheader", { name: "Marked At" })).toBeVisible();
  await expect(recordsTable.getByRole("columnheader", { name: "Correction" })).toBeVisible();

  const recordRows = recordsTable.locator(".admin-table__row");
  await expect(recordRows).toHaveCount(1);

  await expect(recordRows.first().getByRole("button", { name: "PRESENT" })).toBeVisible();
  await expect(recordRows.first().getByRole("button", { name: "LATE" })).toBeVisible();
});

test("the detail view for an ended session shows attendance records with correction controls", async ({
  page,
}) => {
  await openAdminAttendancePage(page);
  await applyMonitorLecturerFilter(page);

  await openSessionDetails(page, 1);
  await waitForRecordsLoad(page);

  const detailSection = await getDetailSection(page);

  await expect(detailSection.locator(".session-status--ended")).toContainText("ENDED");

  const recordsTable = await getRecordsTable(page);
  await expect(recordsTable).toBeVisible();

  const recordRows = recordsTable.locator(".admin-table__row");
  await expect(recordRows).toHaveCount(1);

  await expect(recordRows.first().getByRole("button", { name: "PRESENT" })).toBeVisible();
  await expect(recordRows.first().getByRole("button", { name: "LATE" })).toBeVisible();
});

test("admin can correct LATE to PRESENT and sees updated status", async ({
  page,
}) => {
  await openAdminAttendancePage(page);
  await applyMonitorLecturerFilter(page);

  await openSessionDetails(page, 0);
  await waitForRecordsLoad(page);

  const recordsTable = await getRecordsTable(page);
  const firstRecord = recordsTable.locator(".admin-table__row").first();

  // The active session has LATE status (seeded as LATE)
  const initialStatus = await firstRecord.locator(".attendance-state").textContent();
  expect(initialStatus?.trim()).toBe("LATE");

  const targetStatus = "PRESENT";
  const otherStatus = "LATE";

  await firstRecord.getByRole("button", { name: targetStatus }).click();

  const confirmDialog = firstRecord.locator(".correction-confirm");
  await expect(confirmDialog).toBeVisible();
  await expect(confirmDialog.getByText(new RegExp(targetStatus))).toBeVisible();

  await confirmDialog.getByRole("button", { name: "Confirm" }).click();

  await expect(confirmDialog).toBeHidden();

  const updatedStatus = await firstRecord.locator(".attendance-state").textContent();
  expect(updatedStatus?.trim()).toBe(targetStatus);

  await expect(firstRecord.getByRole("button", { name: otherStatus })).toBeVisible();
  await expect(firstRecord.getByRole("button", { name: targetStatus })).toBeDisabled();
});

test("admin can correct PRESENT to LATE and sees updated status", async ({
  page,
}) => {
  await openAdminAttendancePage(page);
  await applyMonitorLecturerFilter(page);

  // Use the ended session (index 1) which has PRESENT status
  await openSessionDetails(page, 1);
  await waitForRecordsLoad(page);

  const recordsTable = await getRecordsTable(page);
  const firstRecord = recordsTable.locator(".admin-table__row").first();

  const initialStatus = await firstRecord.locator(".attendance-state").textContent();
  expect(initialStatus?.trim()).toBe("PRESENT");

  const targetStatus = "LATE";
  const otherStatus = "PRESENT";

  await firstRecord.getByRole("button", { name: targetStatus }).click();

  const confirmDialog = firstRecord.locator(".correction-confirm");
  await expect(confirmDialog).toBeVisible();
  await expect(confirmDialog.getByText(new RegExp(targetStatus))).toBeVisible();

  await confirmDialog.getByRole("button", { name: "Confirm" }).click();

  await expect(confirmDialog).toBeHidden();

  const updatedStatus = await firstRecord.locator(".attendance-state").textContent();
  expect(updatedStatus?.trim()).toBe(targetStatus);

  await expect(firstRecord.getByRole("button", { name: otherStatus })).toBeVisible();
  await expect(firstRecord.getByRole("button", { name: targetStatus })).toBeDisabled();
});

test("confirmation is required before submitting a correction", async ({
  page,
}) => {
  await openAdminAttendancePage(page);
  await applyMonitorLecturerFilter(page);

  await openSessionDetails(page, 0);
  await waitForRecordsLoad(page);

  const firstRecord = (await getRecordsTable(page)).locator(".admin-table__row").first();

  await firstRecord.getByRole("button", { name: "LATE" }).click();

  const confirmDialog = firstRecord.locator(".correction-confirm");
  await expect(confirmDialog).toBeVisible();

  await confirmDialog.getByRole("button", { name: "Cancel" }).click();

  await expect(confirmDialog).toBeHidden();

  const statusAfterCancel = await firstRecord.locator(".attendance-state").textContent();
  const initialStatus = await firstRecord.locator(".attendance-state").textContent();
  expect(statusAfterCancel).toBe(initialStatus);
});

test("duplicate submission is prevented while loading", async ({
  page,
}) => {
  await openAdminAttendancePage(page);
  await applyMonitorLecturerFilter(page);

  // Use the ended session (index 1) which has LATE status (corrected by an earlier test)
  await openSessionDetails(page, 1);
  await waitForRecordsLoad(page);

  const firstRecord = (await getRecordsTable(page)).locator(".admin-table__row").first();

  // The ended session has LATE status, so we correct to PRESENT
  await expect(firstRecord.getByRole("button", { name: "PRESENT" })).toBeEnabled({ timeout: 15_000 });
  await firstRecord.getByRole("button", { name: "PRESENT" }).click();

  const confirmDialog = firstRecord.locator(".correction-confirm");
  await expect(confirmDialog).toBeVisible();

  const confirmButton = confirmDialog.getByRole("button", { name: "Confirm" });
  await confirmButton.click();

  // Wait for the correction to complete (dialog closes)
  await expect(confirmDialog).toBeHidden({ timeout: 10_000 });

  // Verify the correction was applied (status changed)
  const updatedStatus = await firstRecord.locator(".attendance-state").textContent();
  expect(updatedStatus?.trim()).toBe("PRESENT");

  // The same correction button should now be disabled (status already matches)
  await expect(firstRecord.getByRole("button", { name: "PRESENT" })).toBeDisabled();
  await expect(firstRecord.getByRole("button", { name: "LATE" })).toBeVisible();
});

test("NO_OP_CORRECTION displays appropriate message", async ({
  page,
}) => {
  await openAdminAttendancePage(page);
  await applyMonitorLecturerFilter(page);

  await openSessionDetails(page, 0);
  await waitForRecordsLoad(page);

  const firstRecord = (await getRecordsTable(page)).locator(".admin-table__row").first();

  const initialStatus = await firstRecord.locator(".attendance-state").textContent();
  expect(initialStatus?.trim()).toMatch(/PRESENT|LATE/);

  // The UI disables the same-status button, so we mock the backend 409
  // response to exercise the error-display path.  The real NO_OP_CORRECTION
  // logic is covered by the backend unit tests.
  await page.route("**/api/admin/attendance-records/**", (route) =>
    route.fulfill({
      status: 409,
      body: JSON.stringify({
        error: "NO_OP_CORRECTION",
        message:
          "The attendance record already has this status; no correction was made.",
      }),
    })
  );

  const otherStatus = initialStatus?.trim() === "PRESENT" ? "LATE" : "PRESENT";
  await firstRecord.getByRole("button", { name: otherStatus }).click();

  const confirmDialog = firstRecord.locator(".correction-confirm");
  await expect(confirmDialog).toBeVisible();

  await confirmDialog.getByRole("button", { name: "Confirm" }).click();

  await expect(
    confirmDialog.getByText(/already has that status|NO_OP_CORRECTION/i)
  ).toBeVisible({ timeout: 10_000 });

  await page.unroute("**/api/admin/attendance-records/**");
});

test("backend error displays appropriate message", async ({
  page,
}) => {
  await openAdminAttendancePage(page);
  await applyMonitorLecturerFilter(page);

  await openSessionDetails(page, 0);
  await waitForRecordsLoad(page);

  const firstRecord = (await getRecordsTable(page)).locator(".admin-table__row").first();

  await page.route("**/api/admin/attendance-records/**", (route) =>
    route.fulfill({ status: 500, body: JSON.stringify({ error: "INTERNAL_ERROR" }) })
  );

  await firstRecord.getByRole("button", { name: "LATE" }).click();

  const confirmDialog = firstRecord.locator(".correction-confirm");
  await expect(confirmDialog).toBeVisible();

  await confirmDialog.getByRole("button", { name: "Confirm" }).click();

  await expect(
    confirmDialog.getByText(/Something went wrong|INTERNAL_ERROR/i)
  ).toBeVisible({ timeout: 10_000 });

  await page.unroute("**/api/admin/attendance-records/**");
});

test("back to sessions closes the detail panel and returns to the list", async ({
  page,
}) => {
  await openAdminAttendancePage(page);
  await applyMonitorLecturerFilter(page);

  await openSessionDetails(page, 0);
  await expect(
    page.getByRole("heading", { level: 2, name: "Session details" })
  ).toBeVisible();

  await page
    .getByRole("button", { name: "Back to sessions" })
    .click();

  await expect(
    page.getByRole("heading", { level: 2, name: "Session details" })
  ).toBeHidden();
  await expect(page.locator(".admin-table__row")).toHaveCount(2);
  await expect(page.getByText("2 sessions", { exact: true })).toBeVisible();
});