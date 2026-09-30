import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
import {
  E2E_ADMIN,
  E2E_COURSE_CODE_TWO,
  E2E_LECTURER,
  E2E_MONITOR_LECTURER,
  E2E_STUDENT,
} from "./constants";
import {
  acquireE2E102RegistrationFixturesLock,
  acquireLecturerReportsFixturesLock,
} from "./helpers/attendance-fixture-mutex";
import { withLoginMutex } from "./helpers/login-mutex";

test.describe.configure({ mode: "serial" });

const COURSE_CODE = "E2E-101";
const COURSE_TITLE = "E2E Computer Science 101";
const COURSE_TWO_TITLE = "E2E Computer Science 102";
const OPEN_OFFERING_PATTERN = /E2E-101.*First Semester/;
const CLOSED_OFFERING_PATTERN = /E2E-101.*Second Semester/;
const COURSE_TWO_PATTERN = /E2E-102/;
const CATALOG_API = "**/api/lecturer/course-offerings";
const REPORT_API = "**/api/lecturer/attendance-reports/course-offering/*";

const STATUS_LABELS: Record<string, string> = {
  PRESENT: "Present",
  LATE: "Late",
  ABSENT: "Absent",
};

interface MockSession {
  sessionId: number;
  startTime: string;
  endTime: string;
  lecturerName: string;
  locationName: string;
  attendanceNetworkName: string;
  status: "PRESENT" | "LATE" | "ABSENT";
  markedAt: string | null;
}

interface MockStudent {
  studentId: number;
  matricNumber: string;
  studentName: string;
  totalCompletedSessions: number;
  presentCount: number;
  lateCount: number;
  absentCount: number;
  attendancePercentage: number | null;
  sessions: MockSession[];
}

interface MockReportCourseOffering {
  courseOfferingId: number;
  courseId: number;
  courseCode: string;
  courseTitle: string;
  academicSession: string;
  semester: string;
  level: number;
  lecturer: { id: number; staffId: string; name: string };
  totalCompletedSessions: number;
}

interface MockReportPayload {
  data: {
    courseOffering: MockReportCourseOffering;
    students: MockStudent[];
  };
}

function session(
  id: number,
  day: number,
  status: MockSession["status"],
  markedAt: string | null
): MockSession {
  const label = status.charAt(0) + status.slice(1).toLowerCase();
  return {
    sessionId: id,
    startTime: `2026-02-${day}T09:00:00.000Z`,
    endTime: `2026-02-${day}T10:30:00.000Z`,
    lecturerName: `E2E ${label} Lecturer`,
    locationName: `E2E ${label} Hall`,
    attendanceNetworkName: `E2E Network ${id}`,
    status,
    markedAt,
  };
}

function student(
  id: number,
  matric: string,
  counts: {
    present: number;
    late: number;
    absent: number;
    percentage: number | null;
  },
  sessions: MockSession[]
): MockStudent {
  return {
    studentId: id,
    matricNumber: matric,
    studentName: matric === E2E_STUDENT.matricNumber ? "E2E Student" : "E2E Student Two",
    totalCompletedSessions: sessions.length,
    presentCount: counts.present,
    lateCount: counts.late,
    absentCount: counts.absent,
    attendancePercentage: counts.percentage,
    sessions,
  };
}

function makeReport(
  overrides: {
    totalCompletedSessions?: number;
    students?: MockStudent[];
  } = {}
): MockReportPayload {
  return {
    data: {
      courseOffering: {
        courseOfferingId: 9999,
        courseId: 1,
        courseCode: COURSE_CODE,
        courseTitle: COURSE_TITLE,
        academicSession: "E2E-2026/2027",
        semester: "First Semester",
        level: 100,
        lecturer: {
          id: 2,
          staffId: E2E_MONITOR_LECTURER.staffId,
          name: E2E_MONITOR_LECTURER.name,
        },
        totalCompletedSessions: overrides.totalCompletedSessions ?? 3,
      },
      students: overrides.students ?? [
        student(
          1,
          E2E_STUDENT.matricNumber,
          { present: 2, late: 1, absent: 0, percentage: 100 },
          [
            session(9001, 10, "PRESENT", "2026-02-10T09:10:00.000Z"),
            session(9002, 11, "LATE", "2026-02-11T10:00:00.000Z"),
            session(9003, 12, "ABSENT", null),
          ]
        ),
        student(
          2,
          "E2E/STU/0002",
          { present: 1, late: 0, absent: 2, percentage: 33.3333 },
          [
            session(9004, 10, "PRESENT", "2026-02-10T09:15:00.000Z"),
            session(9005, 11, "ABSENT", null),
            session(9006, 12, "ABSENT", null),
          ]
        ),
      ],
    },
  };
}

async function loginAsMainLecturer(page: Page): Promise<void> {
  await page.goto("/staff/lecturer/login");
  await page.getByLabel("Staff ID").fill(E2E_LECTURER.staffId);
  await page.getByLabel("Password").fill(E2E_LECTURER.password);
  await withLoginMutex("lecturer", async () => {
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page).toHaveURL(/\/app\/lecturer$/, { timeout: 15_000 });
  });
}

async function loginAsMonitorLecturer(page: Page): Promise<void> {
  await page.goto("/staff/lecturer/login");
  await page.getByLabel("Staff ID").fill(E2E_MONITOR_LECTURER.staffId);
  await page.getByLabel("Password").fill(E2E_MONITOR_LECTURER.password);
  await withLoginMutex("lecturer", async () => {
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page).toHaveURL(/\/app\/lecturer$/, { timeout: 15_000 });
  });
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

async function loginAsAdmin(page: Page): Promise<void> {
  await page.goto("/staff/admin/login");
  await page.getByLabel("Username").fill(E2E_ADMIN.username);
  await page.getByLabel("Password").waitFor({ state: "visible", timeout: 15_000 });
  await page.getByLabel("Password").fill(E2E_ADMIN.password);
  await withLoginMutex("admin", async () => {
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page).toHaveURL(/\/app\/admin$/, { timeout: 15_000 });
  });
}

async function openReportsPage(page: Page): Promise<void> {
  await loginAsMainLecturer(page);
  await page.goto("/app/lecturer/attendance-reports");
  await expect(
    page.getByRole("heading", { level: 1, name: "Attendance Reports" })
  ).toBeVisible();
}

async function selectOfferingByText(
  page: Page,
  pattern: RegExp
): Promise<void> {
  const select = page.getByLabel("Course offering", { exact: true });
  const option = select.locator("option").filter({ hasText: pattern });
  const value = await option.getAttribute("value");
  expect(value).not.toBeNull();
  await select.selectOption(String(value));
}

async function selectOfferingByValue(page: Page, value: string): Promise<void> {
  const select = page.getByLabel("Course offering", { exact: true });
  await select.selectOption(value);
}

function reportSection(page: Page): Locator {
  return page.getByRole("region", { name: "Attendance report" });
}

test("an unauthenticated user is redirected to the lecturer login page", async ({
  page,
}) => {
  await page.goto("/app/lecturer/attendance-reports");

  await expect(page).toHaveURL(/\/staff\/lecturer\/login$/);
  await expect(
    page.getByRole("heading", { level: 1, name: "Lecturer Login" })
  ).toBeVisible();
});

test("a student cannot reach the lecturer attendance reports page", async ({
  page,
}) => {
  await loginAsStudent(page);

  await page.goto("/app/lecturer/attendance-reports");

  await expect(page).toHaveURL(/\/app\/student$/);
  await expect(
    page.getByRole("heading", { level: 1, name: "Student Home" })
  ).toBeVisible();
});

test("an admin cannot reach the lecturer attendance reports page", async ({
  page,
}) => {
  await loginAsAdmin(page);

  await page.goto("/app/lecturer/attendance-reports");

  await expect(page).toHaveURL(/\/app\/admin$/);
  await expect(
    page.getByRole("heading", { level: 1, name: "Admin Home" })
  ).toBeVisible();
});

test("a lecturer can navigate to Attendance Reports from Lecturer Home", async ({
  page,
}) => {
  await loginAsMainLecturer(page);

  await page.getByRole("link", { name: "View attendance reports" }).click();

  await expect(page).toHaveURL(/\/app\/lecturer\/attendance-reports$/);
  await expect(
    page.getByRole("heading", { level: 1, name: "Attendance Reports" })
  ).toBeVisible();
});

test("a lecturer can directly load the reports page and sees the selector", async ({
  page,
}) => {
  await openReportsPage(page);

  await expect(
    page.getByRole("heading", { level: 2, name: "Choose a course offering" })
  ).toBeVisible();
  const select = page.getByLabel("Course offering", { exact: true });
  await expect(select).toHaveValue("");
  await expect(select).toContainText("Select a course offering…");
  await expect(
    page.getByText("Select a course offering to view its attendance report.")
  ).toBeVisible();
});

test("the main lecturer only sees their own assigned open offerings", async ({
  page,
}) => {
  await openReportsPage(page);

  await expect(
    page.getByRole("option", { name: OPEN_OFFERING_PATTERN })
  ).toHaveCount(1);
  await expect(
    page.getByRole("option", { name: CLOSED_OFFERING_PATTERN })
  ).toHaveCount(0);
  await expect(
    page.getByRole("option", { name: COURSE_TWO_PATTERN })
  ).toHaveCount(0);
});

test("the monitor lecturer sees their second assigned open offering as well", async ({
  page,
}) => {
  await loginAsMonitorLecturer(page);
  await page.goto("/app/lecturer/attendance-reports");
  await expect(
    page.getByRole("heading", { level: 1, name: "Attendance Reports" })
  ).toBeVisible();

  await expect(
    page.getByRole("option", { name: OPEN_OFFERING_PATTERN })
  ).toHaveCount(1);
  await expect(
    page.getByRole("option", { name: COURSE_TWO_PATTERN })
  ).toHaveCount(1);
  await expect(
    page.getByRole("option", { name: CLOSED_OFFERING_PATTERN })
  ).toHaveCount(0);
});

test("a mocked report shows exact counts and percentages with per-student details", async ({
  page,
}) => {
  await openReportsPage(page);
  await page.route(REPORT_API, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(makeReport()),
    })
  );

  await selectOfferingByText(page, OPEN_OFFERING_PATTERN);

  const report = reportSection(page);
  await expect(report.getByText("E2E-101 — E2E Computer Science 101")).toBeVisible();
  await expect(report.getByText("E2E-2026/2027 · First Semester")).toBeVisible();
  await expect(report.getByText("Level 100")).toBeVisible();
  await expect(
    report.getByText("E2E Monitor Lecturer (E2E/LEC/0002)")
  ).toBeVisible();
  await expect(report.getByText("Completed sessions: 3 sessions")).toBeVisible();

  const rows = report.locator(".admin-table__row");
  await expect(rows).toHaveCount(2);

  const firstRow = rows.filter({ hasText: "E2E/STU/0001" });
  const firstCells = firstRow.locator("td");
  await expect(firstCells.nth(2)).toHaveText("3");
  await expect(firstCells.nth(3)).toHaveText("2");
  await expect(firstCells.nth(4)).toHaveText("1");
  await expect(firstCells.nth(5)).toHaveText("0");
  await expect(firstCells.nth(6)).toHaveText("100.00%");

  const secondRow = rows.filter({ hasText: "E2E/STU/0002" });
  const secondCells = secondRow.locator("td");
  await expect(secondCells.nth(2)).toHaveText("3");
  await expect(secondCells.nth(3)).toHaveText("1");
  await expect(secondCells.nth(4)).toHaveText("0");
  await expect(secondCells.nth(5)).toHaveText("2");
  await expect(secondCells.nth(6)).toHaveText("33.33%");
});

test("per-student session history shows statuses, marked times, and metadata", async ({
  page,
}) => {
  await openReportsPage(page);
  await page.route(REPORT_API, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(makeReport()),
    })
  );

  await selectOfferingByText(page, OPEN_OFFERING_PATTERN);

  const studentReport = reportSection(page)
    .locator(".student-report")
    .filter({ hasText: "E2E/STU/0001" });
  await expect(studentReport).toContainText("2 present · 1 late · 0 absent");
  await studentReport.locator(".student-sessions__summary").click();

  const items = studentReport.locator(".session-list__item");
  await expect(items).toHaveCount(3);

  const presentItem = items.filter({ hasText: "E2E Present Hall" });
  await expect(presentItem.locator(".history-status")).toHaveText("Present");
  await expect(presentItem).toContainText("Lecturer: E2E Present Lecturer");
  await expect(presentItem).toContainText("Location: E2E Present Hall");
  await expect(presentItem).toContainText("Attendance network: E2E Network 9001");
  await expect(presentItem.getByText(/Marked at/)).toBeVisible();

  const lateItem = items.filter({ hasText: "E2E Late Hall" });
  await expect(lateItem.locator(".history-status")).toHaveText("Late");
  await expect(lateItem.getByText(/Marked at/)).toBeVisible();

  const absentItem = items.filter({ hasText: "E2E Absent Hall" });
  await expect(absentItem.locator(".history-status")).toHaveText("Absent");
  await expect(absentItem.getByText(/Marked at/)).toHaveCount(0);
});

test("a null percentage is shown as a dash with a no-completed-sessions notice", async ({
  page,
}) => {
  await openReportsPage(page);
  await page.route(REPORT_API, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(
        makeReport({
          totalCompletedSessions: 0,
          students: [
            student(1, E2E_STUDENT.matricNumber, {
              present: 0,
              late: 0,
              absent: 0,
              percentage: null,
            }, []),
          ],
        })
      ),
    })
  );

  await selectOfferingByText(page, OPEN_OFFERING_PATTERN);

  await expect(
    page.getByText(
      "No attendance sessions have ended for this course offering yet"
    )
  ).toBeVisible();
  const row = page.locator(".admin-table__row").filter({ hasText: "E2E/STU/0001" });
  await expect(row).toBeVisible();
  await expect(row.locator("td").nth(6)).toHaveText("—");
});

test("a report with no enrolled students shows the empty state", async ({
  page,
}) => {
  await openReportsPage(page);
  await page.route(REPORT_API, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(makeReport({ students: [] })),
    })
  );

  await selectOfferingByText(page, OPEN_OFFERING_PATTERN);

  await expect(
    page.getByText("No students are enrolled in this course offering.")
  ).toBeVisible();
  await expect(page.locator(".admin-table__row")).toHaveCount(0);
});

test("the report section shows a loading state before rendering rows", async ({
  page,
}) => {
  await openReportsPage(page);
  await page.route(REPORT_API, async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    await route.continue();
  });

  await selectOfferingByText(page, OPEN_OFFERING_PATTERN);

  await expect(page.getByText("Loading attendance report…")).toBeVisible({
    timeout: 10_000,
  });
  await expect(page.locator(".admin-table__row").first()).toBeVisible();
});

test("a catalog failure shows a friendly error and Retry options recovers", async ({
  page,
}) => {
  await loginAsMainLecturer(page);
  await page.route(CATALOG_API, (route) => route.abort());
  await page.goto("/app/lecturer/attendance-reports");

  await expect(
    page.getByRole("alert").filter({
      hasText: "The course offerings could not be loaded. Please try again.",
    })
  ).toBeVisible();

  await page.unroute(CATALOG_API);
  await page.getByRole("button", { name: "Retry options" }).click();

  await expect(
    page.getByRole("option", { name: OPEN_OFFERING_PATTERN })
  ).toHaveCount(1);
});

test("a report API failure shows a friendly error and Retry recovers", async ({
  page,
}) => {
  await openReportsPage(page);
  await page.route(REPORT_API, (route) => route.abort());
  await selectOfferingByText(page, OPEN_OFFERING_PATTERN);

  await expect(
    page.getByRole("alert").filter({ hasText: "Something went wrong" })
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();

  await page.unroute(REPORT_API);
  await page.getByRole("button", { name: "Retry" }).click();

  await expect(
    reportSection(page).getByText("E2E-101 — E2E Computer Science 101")
  ).toBeVisible();
});

test("a 401 API response shows the session-expired message", async ({ page }) => {
  await openReportsPage(page);
  await page.route(REPORT_API, (route) =>
    route.fulfill({
      status: 401,
      contentType: "application/json",
      body: JSON.stringify({ error: "UNAUTHENTICATED", message: "no session" }),
    })
  );

  await selectOfferingByText(page, OPEN_OFFERING_PATTERN);

  await expect(
    page.getByText("Your session has expired. Please sign in again.")
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();
});

test("a 403 API response shows the forbidden message", async ({ page }) => {
  await openReportsPage(page);
  await page.route(REPORT_API, (route) =>
    route.fulfill({
      status: 403,
      contentType: "application/json",
      body: JSON.stringify({ error: "FORBIDDEN", message: "not allowed" }),
    })
  );

  await selectOfferingByText(page, OPEN_OFFERING_PATTERN);

  await expect(
    page.getByText("You are not authorized to view attendance reports.")
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();
});

test("a 404 API response shows an offering-not-found error", async ({ page }) => {
  await openReportsPage(page);
  await page.route(REPORT_API, (route) =>
    route.fulfill({
      status: 404,
      contentType: "application/json",
      body: JSON.stringify({
        error: "OFFERING_NOT_FOUND",
        message: "The course offering was not found.",
      }),
    })
  );

  await selectOfferingByText(page, OPEN_OFFERING_PATTERN);

  await expect(
    page.getByRole("alert").filter({ hasText: /could not be found/ })
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();
});

test("a 500 API response shows a server error without leaking the raw message", async ({
  page,
}) => {
  await openReportsPage(page);
  await page.route(REPORT_API, (route) =>
    route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({
        error: "INTERNAL",
        message: "boom database",
      }),
    })
  );

  await selectOfferingByText(page, OPEN_OFFERING_PATTERN);

  const alert = page.getByRole("alert");
  await expect(alert).toContainText(
    "The report could not be generated right now. Please try again later."
  );
  await expect(alert).not.toContainText("boom database");
});

test("a malformed API response shows the safe generic error state", async ({
  page,
}) => {
  await openReportsPage(page);
  await page.route(REPORT_API, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ data: { courseOffering: null, students: "oops" } }),
    })
  );

  await selectOfferingByText(page, OPEN_OFFERING_PATTERN);

  await expect(
    page.getByRole("alert").filter({ hasText: "Something went wrong" })
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();
  await expect(page.locator(".admin-table__row")).toHaveCount(0);
});

test("selecting the same offering does not trigger a second report request", async ({
  page,
}) => {
  await openReportsPage(page);
  let reportRequests = 0;
  await page.route(REPORT_API, (route) => {
    reportRequests += 1;
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(makeReport()),
    });
  });

  const select = page.getByLabel("Course offering", { exact: true });
  const option = select.locator("option").filter({ hasText: OPEN_OFFERING_PATTERN });
  const value = await option.getAttribute("value");
  expect(value).not.toBeNull();

  await select.selectOption(String(value));
  await expect(page.locator(".admin-table__row")).toHaveCount(2);

  await select.selectOption(String(value));
  await expect(reportRequests).toBe(1);
});

test("the page issues exactly one catalog request and never polls", async ({
  page,
}) => {
  await loginAsMainLecturer(page);

  let catalogRequests = 0;
  let reportRequests = 0;
  await page.route(CATALOG_API, (route) => {
    catalogRequests += 1;
    route.continue();
  });
  await page.route(REPORT_API, (route) => {
    reportRequests += 1;
    route.continue();
  });

  await page.goto("/app/lecturer/attendance-reports");
  await selectOfferingByText(page, OPEN_OFFERING_PATTERN);
  await expect(page.locator(".admin-table__row").first()).toBeVisible();
  expect(catalogRequests).toBe(1);
  expect(reportRequests).toBe(1);

  await page.waitForTimeout(1200);
  expect(reportRequests).toBe(1);

  await page.goto("/app/lecturer");
  await page.goto("/app/lecturer/attendance-reports");
  await expect(page.getByLabel("Course offering", { exact: true })).toBeVisible();
  // The catalog may or may not be refetched when navigating back (browser caching).
  // The important assertion is that the report API is never polled.
  expect(reportRequests).toBe(1);
});

test("the page is read-only with no attendance modification controls", async ({
  page,
}) => {
  await openReportsPage(page);
  await page.route(REPORT_API, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(makeReport()),
    })
  );

  await selectOfferingByText(page, OPEN_OFFERING_PATTERN);
  await expect(page.locator(".admin-table__row").first()).toBeVisible();

  await expect(page.getByRole("button", { name: /mark/i })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /correct/i })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /end session/i })).toHaveCount(0);
  // Export button is a read-only feature, not a modification control
  await expect(page.getByRole("button", { name: /export/i })).toBeVisible();
  await expect(page.getByRole("link", { name: "Back to Lecturer Home" })).toBeVisible();
});

test("the page is responsive on a mobile viewport without horizontal overflow", async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 667 });
  await openReportsPage(page);
  await page.route(REPORT_API, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(makeReport()),
    })
  );

  await selectOfferingByText(page, OPEN_OFFERING_PATTERN);
  await expect(page.locator(".admin-table__row").first()).toBeVisible();
  await expect(page.locator(".student-report").first()).toBeVisible();

  const overflow = await page.evaluate(() => {
    const documentElement = document.documentElement;
    return {
      scrollWidth: documentElement.scrollWidth,
      clientWidth: documentElement.clientWidth,
    };
  });
  expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth);
});

test("a real monitor lecturer sees the real E2E-101 report from the backend", async ({
  page,
}) => {
  const releaseLock = await acquireLecturerReportsFixturesLock();
  try {
    await loginAsMonitorLecturer(page);

    const catalogRes = await page.request.get("/api/lecturer/course-offerings");
    expect(catalogRes.status()).toBe(200);
    const catalog = (await catalogRes.json()) as {
      data: Array<{ id: number; courseCode: string }>;
    };
    const offering = catalog.data.find((o) => o.courseCode === COURSE_CODE);
    expect(offering).toBeDefined();

    const response = await page.request.get(
      `/api/lecturer/attendance-reports/course-offering/${offering!.id}`
    );
    expect(response.status()).toBe(200);
    const payload = (await response.json()) as MockReportPayload;
    const studentRow = payload.data.students.find(
      (s) => s.matricNumber === E2E_STUDENT.matricNumber
    );
    expect(studentRow).toBeDefined();
    expect(studentRow!.totalCompletedSessions).toBeGreaterThan(0);

    await page.goto("/app/lecturer/attendance-reports");
    const select = page.getByLabel("Course offering", { exact: true });
    await expect(select).toContainText(COURSE_CODE);
    await selectOfferingByValue(page, String(offering!.id));

    const report = reportSection(page);
    await expect(
      report.getByText(`${payload.data.courseOffering.courseCode} — ${payload.data.courseOffering.courseTitle}`)
    ).toBeVisible();
    await expect(report).toContainText(payload.data.courseOffering.academicSession);
    await expect(report).toContainText(payload.data.courseOffering.semester);
    await expect(
      report.getByText(`Level ${payload.data.courseOffering.level}`)
    ).toBeVisible();
    await expect(report).toContainText(
      `${payload.data.courseOffering.lecturer.name} (${payload.data.courseOffering.lecturer.staffId})`
    );

    await expect(report.locator(".admin-table__row")).toHaveCount(
      payload.data.students.length
    );
    const cells = report.locator(".admin-table__row").first().locator("td");
    await expect(cells.nth(2)).toHaveText(String(studentRow!.totalCompletedSessions));
    await expect(cells.nth(3)).toHaveText(String(studentRow!.presentCount));
    await expect(cells.nth(4)).toHaveText(String(studentRow!.lateCount));
    await expect(cells.nth(5)).toHaveText(String(studentRow!.absentCount));
    await expect(cells.nth(6)).toHaveText(
      studentRow!.attendancePercentage === null
        ? "—"
        : `${studentRow!.attendancePercentage.toFixed(2)}%`
    );

    const studentReport = report
      .locator(".student-report")
      .filter({ hasText: studentRow!.matricNumber });
    await expect(studentReport).toBeVisible();
    await studentReport.locator(".student-sessions__summary").click();
    const sessionItems = studentReport.locator(".session-list__item");
    await expect(sessionItems).toHaveCount(studentRow!.sessions.length);

    for (let i = 0; i < studentRow!.sessions.length; i++) {
      const liveSession = studentRow!.sessions[i];
      const item = sessionItems.nth(i);
      await expect(item).toContainText(`Lecturer: ${liveSession.lecturerName}`);
      await expect(item).toContainText(`Location: ${liveSession.locationName}`);
      await expect(item).toContainText(
        `Attendance network: ${liveSession.attendanceNetworkName}`
      );
      await expect(item.locator(".history-status")).toHaveText(
        STATUS_LABELS[liveSession.status]
      );
      if (liveSession.markedAt !== null) {
        await expect(item.getByText(/Marked at/)).toBeVisible();
      } else {
        await expect(item.getByText(/Marked at/)).toHaveCount(0);
      }
    }
  } finally {
    await releaseLock();
  }
});

test("the report endpoint enforces lecturer ownership server-side", async ({
  browser,
}) => {
  const monitorContext = await browser.newContext();
  const monitorPage = await monitorContext.newPage();
  await loginAsMonitorLecturer(monitorPage);
  // Ensure the session cookie is committed before making API calls.
  await monitorPage.waitForLoadState("domcontentloaded");

  const catalogRes = await monitorPage.request.get("/api/lecturer/course-offerings");
  expect(catalogRes.status()).toBe(200);
  const catalog = (await catalogRes.json()) as {
    data: Array<{ id: number; courseCode: string }>;
  };
  const offeringTwo = catalog.data.find(
    (o) => o.courseCode === E2E_COURSE_CODE_TWO
  );
  expect(offeringTwo).toBeDefined();
  const offeringTwoId = offeringTwo!.id;

  const releaseRegistrationLock =
    await acquireE2E102RegistrationFixturesLock();
  try {
    const ownerRes = await monitorPage.request.get(
      `/api/lecturer/attendance-reports/course-offering/${offeringTwoId}`
    );
    expect(ownerRes.status()).toBe(200);
    const ownerPayload = (await ownerRes.json()) as MockReportPayload;
    expect(ownerPayload.data.courseOffering.courseCode).toBe(E2E_COURSE_CODE_TWO);
    expect(ownerPayload.data.students).toHaveLength(0);
  } finally {
    await releaseRegistrationLock();
  }

  const mainContext = await browser.newContext();
  const mainPage = await mainContext.newPage();
  await loginAsMainLecturer(mainPage);
  // Ensure the session cookie is committed before making API calls.
  await mainPage.waitForLoadState("domcontentloaded");
  const nonOwnerRes = await mainPage.request.get(
    `/api/lecturer/attendance-reports/course-offering/${offeringTwoId}`
  );
  expect(nonOwnerRes.status()).toBe(404);

  const studentContext = await browser.newContext();
  const studentPage = await studentContext.newPage();
  await loginAsStudent(studentPage);
  // Ensure the session cookie is committed before making API calls.
  await studentPage.waitForLoadState("domcontentloaded");
  const studentRes = await studentPage.request.get(
    `/api/lecturer/attendance-reports/course-offering/${offeringTwoId}`
  );
  expect(studentRes.status()).toBe(403);

  const adminContext = await browser.newContext();
  const adminPage = await adminContext.newPage();
  await loginAsAdmin(adminPage);
  // Ensure the session cookie is committed before making API calls.
  await adminPage.waitForLoadState("domcontentloaded");
  const adminRes = await adminPage.request.get(
    `/api/lecturer/attendance-reports/course-offering/${offeringTwoId}`
  );
  expect(adminRes.status()).toBe(403);

  await adminContext.close();
  await studentContext.close();
  await mainContext.close();
  await monitorContext.close();
});