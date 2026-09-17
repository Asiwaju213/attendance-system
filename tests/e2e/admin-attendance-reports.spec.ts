import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { E2E_ADMIN, E2E_LECTURER, E2E_STUDENT } from "./constants";
import { withLoginMutex } from "./helpers/login-mutex";
import {
  acquireAttendanceFixturesLock,
} from "./helpers/attendance-fixture-mutex";

test.describe.configure({ mode: "serial" });

const OPEN_OFFERING_PATTERN = /E2E-101.*First Semester/;
const CLOSED_OFFERING_PATTERN = /E2E-101.*Second Semester/;
const REPORT_API_URL = "**/api/admin/attendance-reports/course-offering/*";

async function loginAsAdmin(page: Page): Promise<void> {
  await withLoginMutex("admin", async () => {
    await page.goto("/staff/admin/login");
    await page.getByLabel("Username").fill(E2E_ADMIN.username);
    await page.getByLabel("Password").fill(E2E_ADMIN.password);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page).toHaveURL(/\/app\/admin$/, { timeout: 15_000 });
  });
}

async function openReportsPage(page: Page): Promise<void> {
  await loginAsAdmin(page);
  await page.goto("/app/admin/attendance-reports");
  await expect(
    page.getByRole("heading", { level: 1, name: "Attendance Reports" })
  ).toBeVisible();
}

async function selectOffering(page: Page, pattern: RegExp): Promise<void> {
  const select = page.getByLabel("Course offering", { exact: true });
  const option = select.locator("option").filter({ hasText: pattern });
  const value = await option.getAttribute("value");
  expect(value).not.toBeNull();
  await select.selectOption(String(value));
}

function reportSection(page: Page) {
  return page.getByRole("region", { name: "Attendance report" });
}

function mockReportPayload(
  overrides?: {
    totalCompletedSessions?: number;
    students?: Array<Record<string, unknown>>;
  }
) {
  return {
    data: {
      courseOffering: {
        id: 9999,
        courseId: 1,
        courseCode: "E2E-101",
        courseTitle: "E2E Computer Science 101",
        academicSessionId: 1,
        academicSessionName: "E2E-2026/2027",
        semesterId: 1,
        semesterName: "First Semester",
        levelId: 1,
        levelName: 100,
        lecturers: [
          { id: 1, userId: 10, staffId: "E2E/LEC/0001", name: "E2E Lecturer" },
          {
            id: 2,
            userId: 11,
            staffId: "E2E/LEC/0002",
            name: "E2E Monitor Lecturer",
          },
        ],
        totalCompletedSessions: overrides?.totalCompletedSessions ?? 3,
      },
      students: overrides?.students ?? [
        {
          studentId: 1,
          userId: 12,
          matricNumber: "E2E/STU/0001",
          studentName: "E2E Student",
          totalCompletedSessions: 3,
          presentCount: 2,
          lateCount: 1,
          absentCount: 0,
          attendancePercentage: 100,
        },
        {
          studentId: 2,
          userId: 13,
          matricNumber: "E2E/STU/0002",
          studentName: "E2E Student Two",
          totalCompletedSessions: 3,
          presentCount: 1,
          lateCount: 0,
          absentCount: 2,
          attendancePercentage: 33.3333,
        },
      ],
    },
  };
}

test("an unauthenticated user is redirected to the admin login page", async ({
  page,
}) => {
  await page.goto("/app/admin/attendance-reports");

  await expect(page).toHaveURL(/\/staff\/admin\/login$/);
  await expect(
    page.getByRole("heading", { level: 1, name: "Admin Login" })
  ).toBeVisible();
});

test("a student cannot reach the attendance reports page", async ({ page }) => {
  await withLoginMutex("student", async () => {
    await page.goto("/login");
    await page.getByLabel("Matric Number").fill(E2E_STUDENT.matricNumber);
    await page.getByLabel("Password").fill(E2E_STUDENT.password);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page).toHaveURL(/\/app\/student$/, { timeout: 15_000 });
  });

  await page.goto("/app/admin/attendance-reports");

  await expect(page).toHaveURL(/\/app\/student$/);
  await expect(
    page.getByRole("heading", { level: 1, name: "Student Home" })
  ).toBeVisible();
});

test("a lecturer cannot reach the attendance reports page", async ({ page }) => {
  await withLoginMutex("lecturer", async () => {
    await page.goto("/staff/lecturer/login");
    await page.getByLabel("Staff ID").fill(E2E_LECTURER.staffId);
    await page.getByLabel("Password").fill(E2E_LECTURER.password);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page).toHaveURL(/\/app\/lecturer$/, { timeout: 15_000 });
  });

  await page.goto("/app/admin/attendance-reports");

  await expect(page).toHaveURL(/\/app\/lecturer$/);
  await expect(
    page.getByRole("heading", { level: 1, name: "Lecturer Home" })
  ).toBeVisible();
});

test("an admin can open the page from Admin Home and sees a course offering selector", async ({
  page,
}) => {
  await loginAsAdmin(page);

  await page.getByRole("link", { name: "Attendance Reports" }).click();

  await expect(page).toHaveURL(/\/app\/admin\/attendance-reports$/);
  await expect(
    page.getByRole("heading", { level: 1, name: "Attendance Reports" })
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { level: 2, name: "Choose a course offering" })
  ).toBeVisible();
  await expect(
    page.getByRole("option", { name: OPEN_OFFERING_PATTERN })
  ).toHaveCount(1);
  await expect(
    page.getByRole("option", { name: CLOSED_OFFERING_PATTERN })
  ).toHaveCount(1);
  const select = page.getByLabel("Course offering", { exact: true });
  await expect(select).toHaveValue("");
  await expect(select).toContainText("Select a course offering…");
  await expect(
    page.getByText("Select a course offering to view its attendance report.")
  ).toBeVisible();
});

test("selecting E2E-101 loads its report context and enrolled student row from the backend", async ({
  page,
}) => {
  const releaseLock = await acquireAttendanceFixturesLock();
  try {
    await openReportsPage(page);
    await selectOffering(page, OPEN_OFFERING_PATTERN);

    const report = reportSection(page);
    await expect(report.getByText("E2E-101 — E2E Computer Science 101")).toBeVisible();
    await expect(report.getByText("E2E-2026/2027 · First Semester")).toBeVisible();
    await expect(report.getByText("Level 100")).toBeVisible();
    await expect(report.getByText("E2E Lecturer (E2E/LEC/0001)")).toBeVisible();
    await expect(
      report.getByText("E2E Monitor Lecturer (E2E/LEC/0002)")
    ).toBeVisible();
    await expect(
      report.getByText("E2E Student Mark Lecturer (E2E/LEC/0003)")
    ).toBeVisible();
    const studentRow = report.getByRole("row").filter({ hasText: "E2E/STU/0001" });
    await expect(studentRow).toBeVisible();
    await expect(studentRow.getByText("E2E Student")).toBeVisible();
    await expect(report.locator(".admin-table__row")).toHaveCount(1);
  } finally {
    await releaseLock();
  }
});

test("selecting E2E-101 shows the correct attendance counts from the backend", async ({
  page,
}) => {
  const releaseLock = await acquireAttendanceFixturesLock();
  try {
    await openReportsPage(page);
    await selectOffering(page, OPEN_OFFERING_PATTERN);

    const studentRow = page
      .locator(".admin-table__row")
      .filter({ hasText: "E2E/STU/0001" });
    await expect(studentRow).toBeVisible();
    const cells = studentRow.locator("td");
    await expect(cells.nth(3)).toHaveText("1");
    await expect(cells.nth(4)).toHaveText("0");
    await expect(cells.nth(5)).toHaveText("0");
  } finally {
    await releaseLock();
  }
});

test("a mocked report shows exact PRESENT, LATE, ABSENT and percentage values", async ({
  page,
}) => {
  await openReportsPage(page);
  await page.route(REPORT_API_URL, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(mockReportPayload()),
    })
  );

  await selectOffering(page, OPEN_OFFERING_PATTERN);

  const firstRow = page
    .locator(".admin-table__row")
    .filter({ hasText: "E2E Student" })
    .filter({ hasText: "E2E/STU/0001" });
  await expect(firstRow).toBeVisible();
  const firstCells = firstRow.locator("td");
  await expect(firstCells.nth(2)).toHaveText("3");
  await expect(firstCells.nth(3)).toHaveText("2");
  await expect(firstCells.nth(4)).toHaveText("1");
  await expect(firstCells.nth(5)).toHaveText("0");
  await expect(firstCells.nth(6)).toHaveText("100.00%");

  const secondRow = page
    .locator(".admin-table__row")
    .filter({ hasText: "E2E Student Two" });
  await expect(secondRow).toBeVisible();
  const secondCells = secondRow.locator("td");
  await expect(secondCells.nth(3)).toHaveText("1");
  await expect(secondCells.nth(4)).toHaveText("0");
  await expect(secondCells.nth(5)).toHaveText("2");
  await expect(secondCells.nth(6)).toHaveText("33.33%");
});

test("null percentage is displayed as a dash", async ({ page }) => {
  await openReportsPage(page);
  await page.route(REPORT_API_URL, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(
        mockReportPayload({
          totalCompletedSessions: 0,
          students: [
            {
              studentId: 1,
              userId: 12,
              matricNumber: "E2E/STU/0001",
              studentName: "E2E Student",
              totalCompletedSessions: 0,
              presentCount: 0,
              lateCount: 0,
              absentCount: 0,
              attendancePercentage: null,
            },
          ],
        })
      ),
    })
  );

  await selectOffering(page, OPEN_OFFERING_PATTERN);

  const row = page.locator(".admin-table__row").filter({ hasText: "E2E/STU/0001" });
  await expect(row).toBeVisible();
  await expect(row.locator("td").nth(6)).toHaveText("—");
});

test("selecting a closed offering shows the no enrolled students state", async ({
  page,
}) => {
  await openReportsPage(page);
  await selectOffering(page, CLOSED_OFFERING_PATTERN);

  await expect(
    page.getByText(
      "No students are enrolled in this course offering."
    )
  ).toBeVisible();
  await expect(page.locator(".admin-table__row")).toHaveCount(0);
});

test("a mocked report with no completed sessions shows a clear notice", async ({
  page,
}) => {
  await openReportsPage(page);
  await page.route(REPORT_API_URL, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(
        mockReportPayload({
          totalCompletedSessions: 0,
          students: [
            {
              studentId: 1,
              userId: 12,
              matricNumber: "E2E/STU/0001",
              studentName: "E2E Student",
              totalCompletedSessions: 0,
              presentCount: 0,
              lateCount: 0,
              absentCount: 0,
              attendancePercentage: null,
            },
          ],
        })
      ),
    })
  );

  await selectOffering(page, OPEN_OFFERING_PATTERN);

  await expect(
    page.getByText(
      "No attendance sessions have ended for this course offering yet"
    )
  ).toBeVisible();
  await expect(page.locator(".admin-table__row")).toHaveCount(1);
});

test("selecting the same offering does not trigger a second report request", async ({
  page,
}) => {
  await openReportsPage(page);
  let requestCount = 0;
  await page.route(REPORT_API_URL, (route) => {
    requestCount += 1;
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(mockReportPayload()),
    });
  });

  const select = page.getByLabel("Course offering", { exact: true });
  const option = select
    .locator("option")
    .filter({ hasText: OPEN_OFFERING_PATTERN });
  const value = await option.getAttribute("value");
  expect(value).not.toBeNull();

  await select.selectOption(String(value));
  await expect(page.locator(".admin-table__row")).toHaveCount(2);

  await select.selectOption(String(value));
  await expect(requestCount).toBe(1);
});

test("the report section shows a loading state before rendering rows", async ({
  page,
}) => {
  await openReportsPage(page);
  await page.route(REPORT_API_URL, async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    await route.continue();
  });

  await selectOffering(page, OPEN_OFFERING_PATTERN);

  await expect(page.getByText("Loading attendance report…")).toBeVisible({
    timeout: 10_000,
  });
  await expect(page.locator(".admin-table__row").first()).toBeVisible();
});

test("an API failure shows a friendly error and Retry recovers the report", async ({
  page,
}) => {
  await openReportsPage(page);
  await page.route(REPORT_API_URL, (route) => route.abort());
  await selectOffering(page, OPEN_OFFERING_PATTERN);

  await expect(
    page.getByRole("alert").filter({ hasText: "Something went wrong" })
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();

  await page.unroute(REPORT_API_URL);
  await page.getByRole("button", { name: "Retry" }).click();

  await expect(
    reportSection(page).getByText("E2E-101 — E2E Computer Science 101")
  ).toBeVisible();
});

test("a 404 API response shows an offering-not-found error", async ({
  page,
}) => {
  await openReportsPage(page);
  await page.route(REPORT_API_URL, (route) =>
    route.fulfill({
      status: 404,
      contentType: "application/json",
      body: JSON.stringify({
        error: "OFFERING_NOT_FOUND",
        message: "The course offering was not found.",
      }),
    })
  );

  await selectOffering(page, OPEN_OFFERING_PATTERN);

  await expect(
    page.getByRole("alert").filter({ hasText: /could not be found/ })
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();
});

test("a 500 API response shows a server error without exposing the raw error", async ({
  page,
}) => {
  await openReportsPage(page);
  await page.route(REPORT_API_URL, (route) =>
    route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({
        error: "INTERNAL",
        message: "Something unexpected happened internally.",
      }),
    })
  );

  await selectOffering(page, OPEN_OFFERING_PATTERN);

  const alert = page.getByRole("alert");
  await expect(alert).toBeVisible();
  await expect(alert).toContainText(
    "The report could not be generated right now. Please try again later."
  );
  await expect(alert).not.toContainText("Something unexpected happened");
});

test("the excel export button is disabled before a report is loaded", async ({
  page,
}) => {
  await openReportsPage(page);

  await expect(page.getByRole("button", { name: "Export Excel" })).toBeDisabled();
});

test("the excel export button is enabled after a report loads", async ({
  page,
}) => {
  await openReportsPage(page);
  await expect(page.getByRole("button", { name: "Export Excel" })).toBeDisabled();

  await selectOffering(page, OPEN_OFFERING_PATTERN);

  await expect(page.locator(".admin-table__row").first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Export Excel" })).toBeEnabled();
});

test("clicking export downloads an xlsx file", async ({ page }) => {
  await openReportsPage(page);
  await selectOffering(page, OPEN_OFFERING_PATTERN);
  await expect(page.locator(".admin-table__row").first()).toBeVisible();

  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export Excel" }).click();
  const download = await downloadPromise;

  expect(download.suggestedFilename()).toMatch(/\.xlsx$/);
});

test("the downloaded filename contains the course and academic period", async ({
  page,
}) => {
  await openReportsPage(page);
  await selectOffering(page, OPEN_OFFERING_PATTERN);
  await expect(page.locator(".admin-table__row").first()).toBeVisible();

  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export Excel" }).click();
  const download = await downloadPromise;

  const filename = download.suggestedFilename();
  expect(filename).toContain("E2E-101");
  expect(filename).toContain("E2E-2026-2027");
  expect(filename).toContain("First-Semester");
  expect(filename).toMatch(/\.xlsx$/);
});

test("exporting does not trigger another report request", async ({ page }) => {
  await openReportsPage(page);
  let reportRequests = 0;
  await page.route(REPORT_API_URL, (route) => {
    reportRequests += 1;
    route.continue();
  });

  await selectOffering(page, OPEN_OFFERING_PATTERN);
  await expect(page.locator(".admin-table__row").first()).toBeVisible();
  expect(reportRequests).toBe(1);

  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export Excel" }).click();
  const download = await downloadPromise;

  expect(download.suggestedFilename()).toMatch(/\.xlsx$/);
  expect(reportRequests).toBe(1);
});
