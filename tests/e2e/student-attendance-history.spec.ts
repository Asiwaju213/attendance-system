import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { E2E_LECTURER, E2E_STUDENT } from "./constants";
import {
  acquireAttendanceFixturesLock,
} from "./helpers/attendance-fixture-mutex";
import { withLoginMutex } from "./helpers/login-mutex";

const HISTORY_API = "**/api/student/attendance/history";
const COURSE_CODE = "E2E-101";
const COURSE_TITLE = "E2E Computer Science 101";
const COURSE_REGION = new RegExp(`${COURSE_CODE} — ${COURSE_TITLE}`);

const STATUS_LABELS: Record<string, string> = {
  PRESENT: "Present",
  LATE: "Late",
  ABSENT: "Absent",
};

interface HistorySession {
  sessionId: number;
  startTime: string;
  endTime: string;
  lecturerName: string;
  locationName: string;
  attendanceNetworkName: string;
  status: "PRESENT" | "LATE" | "ABSENT";
  markedAt: string | null;
}

interface HistoryCourse {
  courseOfferingId: number;
  courseCode: string;
  courseTitle: string;
  academicSession: string;
  semester: string;
  level: number;
  summary: {
    completedSessions: number;
    presentCount: number;
    lateCount: number;
    absentCount: number;
    attendancePercentage: number | null;
  };
  sessions: HistorySession[];
}

interface HistoryPayload {
  data: { courses: HistoryCourse[] };
}

function historyCourse(
  overrides: Partial<HistoryCourse> = {}
): HistoryCourse {
  return {
    courseOfferingId: 4242,
    courseCode: COURSE_CODE,
    courseTitle: COURSE_TITLE,
    academicSession: "E2E-2026/2027",
    semester: "First Semester",
    level: 100,
    summary: {
      completedSessions: 3,
      presentCount: 1,
      lateCount: 1,
      absentCount: 1,
      attendancePercentage: 33.33,
    },
    sessions: [
      {
        sessionId: 9001,
        startTime: "2026-02-10T09:00:00.000Z",
        endTime: "2026-02-10T10:30:00.000Z",
        lecturerName: "E2E Present Lecturer",
        locationName: "E2E Present Hall",
        attendanceNetworkName: "E2E Network One",
        status: "PRESENT",
        markedAt: "2026-02-10T09:10:00.000Z",
      },
      {
        sessionId: 9002,
        startTime: "2026-02-11T09:00:00.000Z",
        endTime: "2026-02-11T10:30:00.000Z",
        lecturerName: "E2E Late Lecturer",
        locationName: "E2E Late Hall",
        attendanceNetworkName: "E2E Network Two",
        status: "LATE",
        markedAt: "2026-02-11T10:00:00.000Z",
      },
      {
        sessionId: 9003,
        startTime: "2026-02-12T09:00:00.000Z",
        endTime: "2026-02-12T10:30:00.000Z",
        lecturerName: "E2E Absent Lecturer",
        locationName: "E2E Absent Hall",
        attendanceNetworkName: "E2E Network Three",
        status: "ABSENT",
        markedAt: null,
      },
    ],
    ...overrides,
  };
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

async function loginAsLecturer(page: Page): Promise<void> {
  await withLoginMutex("lecturer", async () => {
    await page.goto("/staff/lecturer/login");
    await page.getByLabel("Staff ID").fill(E2E_LECTURER.staffId);
    await page.getByLabel("Password").fill(E2E_LECTURER.password);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page).toHaveURL(/\/app\/lecturer$/, { timeout: 15_000 });
  });
}

async function mockHistory(page: Page, courses: unknown[]): Promise<void> {
  await page.route(HISTORY_API, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ data: { courses } }),
    })
  );
}

function courseRegion(page: Page) {
  return page.getByRole("region", { name: COURSE_REGION });
}

test("an unauthenticated user is redirected to the student login page", async ({
  page,
}) => {
  await page.goto("/app/student/attendance-history");

  await expect(page).toHaveURL(/\/login$/);
  await expect(
    page.getByRole("heading", { level: 1, name: "Student Login" })
  ).toBeVisible();
});

test("a non-student cannot reach the attendance history page", async ({
  page,
}) => {
  await loginAsLecturer(page);

  await page.goto("/app/student/attendance-history");

  await expect(page).toHaveURL(/\/app\/lecturer$/);
  await expect(
    page.getByRole("heading", { level: 1, name: "Lecturer Home" })
  ).toBeVisible();
});

test("a student can navigate to Attendance History from Student Home", async ({
  page,
}) => {
  await loginAsStudent(page);

  await page.getByRole("link", { name: "Attendance history" }).click();

  await expect(page).toHaveURL(/\/app\/student\/attendance-history$/);
  await expect(
    page.getByRole("heading", { level: 1, name: "Attendance History" })
  ).toBeVisible();
});

test("a student can directly load the attendance history page", async ({
  page,
}) => {
  await loginAsStudent(page);

  await page.goto("/app/student/attendance-history");

  await expect(page).toHaveURL(/\/app\/student\/attendance-history$/);
  await expect(
    page.getByRole("heading", { level: 1, name: "Attendance History" })
  ).toBeVisible();
  await expect(courseRegion(page)).toBeVisible();
});

test("the loading state is displayed while the history request is pending", async ({
  page,
}) => {
  await loginAsStudent(page);
  await page.route(HISTORY_API, async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ data: { courses: [historyCourse()] } }),
    });
  });

  await page.goto("/app/student/attendance-history");

  await expect(page.getByText("Loading attendance history…")).toBeVisible({
    timeout: 10_000,
  });
  await expect(courseRegion(page)).toBeVisible();
});

test("a real authenticated student sees the real attendance history from the backend", async ({
  page,
}) => {
  const releaseLock = await acquireAttendanceFixturesLock();
  try {
    await loginAsStudent(page);

    const response = await page.request.get("/api/student/attendance/history");
    expect(response.status()).toBe(200);
    const payload = (await response.json()) as HistoryPayload;
    const course = payload.data.courses.find(
      (c) => c.courseCode === COURSE_CODE
    );
    expect(course).toBeDefined();
    expect(course!.sessions.length).toBeGreaterThan(0);

    await page.goto("/app/student/attendance-history");
    await expect(courseRegion(page)).toBeVisible();

    const region = courseRegion(page);
    await expect(region.getByRole("heading", { level: 2 })).toHaveText(
      `${course!.courseCode} — ${course!.courseTitle}`
    );
    await expect(region).toContainText(course!.academicSession);
    await expect(region).toContainText(course!.semester);
    await expect(region).toContainText(`Level ${course!.level}`);

    await expect(region.locator(".history-summary__item")).toHaveCount(5);

    const sessionItems = region.locator(".session-list__item");
    await expect(sessionItems).toHaveCount(course!.sessions.length);

    for (let i = 0; i < course!.sessions.length; i++) {
      const session = course!.sessions[i];
      const item = sessionItems.nth(i);
      await expect(item).toContainText(`Lecturer: ${session.lecturerName}`);
      await expect(item).toContainText(`Location: ${session.locationName}`);
      await expect(item).toContainText(
        `Attendance network: ${session.attendanceNetworkName}`
      );
      await expect(item.locator(".history-status")).toHaveText(
        STATUS_LABELS[session.status]
      );
      if (session.markedAt !== null) {
        await expect(item.getByText(/Marked at/)).toBeVisible();
      } else {
        await expect(item.getByText(/Marked at/)).toHaveCount(0);
      }
    }
  } finally {
    await releaseLock();
  }
});

test("course information is rendered correctly", async ({ page }) => {
  await mockHistory(page, [historyCourse()]);
  await loginAsStudent(page);

  await page.goto("/app/student/attendance-history");

  await expect(courseRegion(page)).toBeVisible();
  await expect(
    courseRegion(page).getByRole("heading", { level: 2 })
  ).toHaveText("E2E-101 — E2E Computer Science 101");
  await expect(courseRegion(page)).toContainText("E2E Computer Science 101");
});

test("academic session, semester, and numeric level are rendered correctly", async ({
  page,
}) => {
  await mockHistory(page, [historyCourse()]);
  await loginAsStudent(page);

  await page.goto("/app/student/attendance-history");

  const region = courseRegion(page);
  await expect(region).toContainText("E2E-2026/2027");
  await expect(region).toContainText("First Semester");
  await expect(region.getByText("Level 100")).toBeVisible();
});

test("summary counts are rendered without recalculation", async ({ page }) => {
  await mockHistory(page, [historyCourse()]);
  await loginAsStudent(page);

  await page.goto("/app/student/attendance-history");

  const values = courseRegion(page).locator(".history-summary__value");
  await expect(values.nth(0)).toHaveText("3");
  await expect(values.nth(1)).toHaveText("1");
  await expect(values.nth(2)).toHaveText("1");
  await expect(values.nth(3)).toHaveText("1");
});

test("the backend-provided attendance percentage is rendered as-is", async ({
  page,
}) => {
  await mockHistory(page, [
    historyCourse({
      summary: {
        completedSessions: 4,
        presentCount: 3,
        lateCount: 1,
        absentCount: 0,
        attendancePercentage: 99.99,
      },
    }),
  ]);
  await loginAsStudent(page);

  await page.goto("/app/student/attendance-history");

  await expect(courseRegion(page).locator(".history-summary__value").nth(4)).toHaveText(
    "99.99%"
  );
});

test("PRESENT, LATE, and ABSENT sessions display with distinct statuses and marked times", async ({
  page,
}) => {
  await mockHistory(page, [historyCourse()]);
  await loginAsStudent(page);

  await page.goto("/app/student/attendance-history");

  const items = courseRegion(page).locator(".session-list__item");
  await expect(items).toHaveCount(3);

  const presentItem = items.filter({ hasText: "E2E Present Hall" });
  await expect(presentItem.locator(".history-status")).toHaveText("Present");
  await expect(presentItem.getByText(/Marked at/)).toBeVisible();

  const lateItem = items.filter({ hasText: "E2E Late Hall" });
  await expect(lateItem.locator(".history-status")).toHaveText("Late");
  await expect(lateItem.getByText(/Marked at/)).toBeVisible();

  const absentItem = items.filter({ hasText: "E2E Absent Hall" });
  await expect(absentItem.locator(".history-status")).toHaveText("Absent");
  await expect(absentItem.getByText(/Marked at/)).toHaveCount(0);
});

test("session lecturer, location, and network information is rendered", async ({
  page,
}) => {
  await mockHistory(page, [historyCourse()]);
  await loginAsStudent(page);

  await page.goto("/app/student/attendance-history");

  const item = courseRegion(page)
    .locator(".session-list__item")
    .filter({ hasText: "E2E Present Hall" });
  await expect(item).toContainText("Lecturer: E2E Present Lecturer");
  await expect(item).toContainText("Location: E2E Present Hall");
  await expect(item).toContainText("Attendance network: E2E Network One");
});

test("an empty history response shows the empty state", async ({ page }) => {
  await mockHistory(page, []);
  await loginAsStudent(page);

  await page.goto("/app/student/attendance-history");

  await expect(
    page.getByText("You have no completed attendance sessions yet.")
  ).toBeVisible();
  await expect(courseRegion(page)).toHaveCount(0);
});

test("a 401 shows the friendly session-expired message", async ({ page }) => {
  await loginAsStudent(page);
  await page.route(HISTORY_API, (route) =>
    route.fulfill({
      status: 401,
      contentType: "application/json",
      body: JSON.stringify({ error: "UNAUTHENTICATED", message: "no session" }),
    })
  );

  await page.goto("/app/student/attendance-history");

  await expect(
    page.getByText("Your session has expired. Please sign in again.")
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();
});

test("a 403 shows the friendly forbidden message", async ({ page }) => {
  await loginAsStudent(page);
  await page.route(HISTORY_API, (route) =>
    route.fulfill({
      status: 403,
      contentType: "application/json",
      body: JSON.stringify({ error: "FORBIDDEN", message: "not allowed" }),
    })
  );

  await page.goto("/app/student/attendance-history");

  await expect(
    page.getByText("You are not authorized to view your attendance history.")
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();
});

test("a 500 shows a friendly server error without leaking details and Retry recovers", async ({
  page,
}) => {
  await loginAsStudent(page);
  await page.route(HISTORY_API, (route) =>
    route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({ error: "INTERNAL", message: "boom database" }),
    })
  );

  await page.goto("/app/student/attendance-history");

  await expect(
    page.getByText(
      "Your attendance history could not be loaded right now. Please try again later."
    )
  ).toBeVisible();
  await expect(page.getByText("boom database")).toHaveCount(0);

  await page.unroute(HISTORY_API);
  await page.getByRole("button", { name: "Retry" }).click();

  await expect(courseRegion(page)).toBeVisible();
});

test("a network failure shows a friendly error", async ({ page }) => {
  await loginAsStudent(page);
  await page.route(HISTORY_API, (route) => route.abort());

  await page.goto("/app/student/attendance-history");

  await expect(
    page.getByText("Something went wrong. Please try again later.")
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();
});

test("a malformed API response shows the safe generic error state", async ({
  page,
}) => {
  await loginAsStudent(page);
  await page.route(HISTORY_API, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ data: { courses: "not-an-array" } }),
    })
  );

  await page.goto("/app/student/attendance-history");

  await expect(
    page.getByText("Something went wrong. Please try again later.")
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();
  await expect(courseRegion(page)).toHaveCount(0);
});

test("the page issues exactly one history request per page load", async ({
  page,
}) => {
  await loginAsStudent(page);

  let requestCount = 0;
  await page.route(HISTORY_API, (route) => {
    requestCount += 1;
    route.continue();
  });

  await page.goto("/app/student/attendance-history");
  await expect(courseRegion(page)).toBeVisible();
  expect(requestCount).toBe(1);

  await page.waitForTimeout(500);
  expect(requestCount).toBe(1);

  await page.goto("/app/student");
  await page.goto("/app/student/attendance-history");
  await expect(courseRegion(page)).toBeVisible();
  expect(requestCount).toBe(2);
});

test("the page is responsive on a mobile viewport without horizontal overflow", async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 667 });
  await mockHistory(page, [historyCourse()]);
  await loginAsStudent(page);

  await page.goto("/app/student/attendance-history");

  await expect(
    page.getByRole("heading", { level: 1, name: "Attendance History" })
  ).toBeVisible();
  await expect(courseRegion(page)).toBeVisible();
  await expect(
    courseRegion(page).locator(".history-summary__item")
  ).toHaveCount(5);
  await expect(
    courseRegion(page).locator(".session-list__item").first()
  ).toContainText("Present");

  const overflow = await page.evaluate(() => {
    const documentElement = document.documentElement;
    return {
      scrollWidth: documentElement.scrollWidth,
      clientWidth: documentElement.clientWidth,
    };
  });
  expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth);
});