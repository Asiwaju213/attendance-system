import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
import { E2E_ADMIN, E2E_STUDENT } from "./constants";

test.describe.configure({ mode: "serial" });

const MONITOR_STAFF_ID = "E2E/LEC/0002";
const MONITOR_NAME = "E2E Monitor Lecturer";
const OTHER_LECTURER_NAME = "E2E Lecturer";

async function loginAsAdmin(page: Page): Promise<void> {
  await page.goto("/staff/admin/login");
  await page.getByLabel("Username").fill(E2E_ADMIN.username);
  await page.getByLabel("Password").fill(E2E_ADMIN.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/app\/admin$/);
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
  await page.goto("/login");
  await page.getByLabel("Matric Number").fill(E2E_STUDENT.matricNumber);
  await page.getByLabel("Password").fill(E2E_STUDENT.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/app\/student$/);

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
    /Second Semester/
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
    /Second Semester/
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

test("the monitoring page has no attendance recording or correction controls", async ({
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

  await page
    .locator(".admin-table__row")
    .first()
    .getByRole("button", { name: "View details" })
    .click();

  const detailSection = page.getByRole("region", { name: "Session details" });
  await expect(
    page.getByRole("heading", { level: 2, name: "Session details" })
  ).toBeVisible();
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

test("the detail view shows ended session information and no correction controls", async ({
  page,
}) => {
  await openAdminAttendancePage(page);
  await applyMonitorLecturerFilter(page);

  await page
    .locator(".admin-table__row")
    .nth(1)
    .getByRole("button", { name: "View details" })
    .click();

  const detailSection = page.getByRole("region", { name: "Session details" });
  await expect(detailSection.locator(".session-status--ended")).toContainText("ENDED");
  await expect(detailSection.getByText("Ended at:", { exact: false })).toBeVisible();
  await expect(detailSection.getByText("Created at:", { exact: false })).toBeVisible();
  await expect(
    detailSection.getByRole("button", { name: /mark|record|correct|edit|delete|end/i })
  ).toHaveCount(0);
});

test("back to sessions closes the detail panel and returns to the list", async ({
  page,
}) => {
  await openAdminAttendancePage(page);
  await applyMonitorLecturerFilter(page);

  await page
    .locator(".admin-table__row")
    .first()
    .getByRole("button", { name: "View details" })
    .click();
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