import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import {
  E2E_LECTURER,
  E2E_MONITOR_LECTURER,
  E2E_STUDENT,
} from "./constants";
import {
  acquireLecturerSessionReportFixturesLock,
} from "./helpers/attendance-fixture-mutex";
import { withLoginMutex } from "./helpers/login-mutex";

test.describe.configure({ mode: "serial" });

const COURSE_CODE = "E2E-103";
const COURSE_TITLE = "E2E Computer Science 103";

let releaseSessionReportLock: (() => Promise<void>) | undefined;

test.beforeAll(async () => {
  releaseSessionReportLock = await acquireLecturerSessionReportFixturesLock();
});

test.afterAll(async () => {
  await releaseSessionReportLock?.();
});

async function loginAsLecturer(page: Page): Promise<void> {
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

async function getEndedSessionId(page: Page): Promise<number> {
  const response = await page.request.get("/api/lecturer/attendance-sessions");
  expect(response.status()).toBe(200);
  const data = (await response.json()) as {
    data: Array<{
      id: number;
      courseCode: string;
      status: string;
      currentState: string;
    }>;
  };
  const endedSession = data.data.find(
    (s) =>
      s.courseCode === COURSE_CODE &&
      (s.status === "ENDED" || s.currentState === "ENDED")
  );
  expect(
    endedSession,
    `an ended ${COURSE_CODE} session should exist for the main lecturer`
  ).toBeDefined();
  return endedSession!.id;
}

test("an unauthenticated user is redirected to the lecturer login page", async ({
  page,
}) => {
  await page.goto("/app/lecturer/attendance-reports/session/1");
  await expect(page).toHaveURL(/\/staff\/lecturer\/login$/);
  await expect(
    page.getByRole("heading", { level: 1, name: "Lecturer Login" })
  ).toBeVisible();
});

test("a student cannot reach the lecturer session report page", async ({
  page,
}) => {
  await page.goto("/login");
  await page.getByLabel("Matric Number").fill(E2E_STUDENT.matricNumber);
  await page.getByLabel("Password").fill(E2E_STUDENT.password);
  await withLoginMutex("student", async () => {
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page).toHaveURL(/\/app\/student$/);
  });
  await page.goto("/app/lecturer/attendance-reports/session/1");
  await expect(page).toHaveURL(/\/app\/student$/);
  await expect(
    page.getByRole("heading", { level: 1, name: "Student Home" })
  ).toBeVisible();
});

test("an admin cannot reach the lecturer session report page", async ({
  page,
}) => {
  await page.goto("/staff/admin/login");
  await page.getByLabel("Username").fill("e2e_admin");
  await page.getByLabel("Password").fill(E2E_LECTURER.password);
  await withLoginMutex("admin", async () => {
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page).toHaveURL(/\/app\/admin$/);
  });
  await page.goto("/app/lecturer/attendance-reports/session/1");
  await expect(page).toHaveURL(/\/app\/admin$/);
  await expect(
    page.getByRole("heading", { level: 1, name: "Admin Home" })
  ).toBeVisible();
});

test("a lecturer can navigate to a completed session report from the history", async ({
  page,
}) => {
  await loginAsLecturer(page);
  await page.goto("/app/lecturer/attendance");
  await expect(
    page.getByRole("heading", { level: 1, name: "Attendance sessions" })
  ).toBeVisible();

  const historyItem = page
    .locator(".session-list__item")
    .filter({ hasText: COURSE_TITLE });
  await expect(historyItem).toBeVisible();
  await historyItem.getByRole("link", { name: "View attendance report" }).click();

  await expect(page).toHaveURL(/\/app\/lecturer\/attendance-reports\/session\/\d+$/);
  await expect(
    page.getByRole("heading", { level: 1, name: "Session attendance report" })
  ).toBeVisible();
});

test("a lecturer can directly load the session report page", async ({
  page,
}) => {
  await loginAsLecturer(page);
  const sessionId = await getEndedSessionId(page);
  await page.goto(`/app/lecturer/attendance-reports/session/${sessionId}`);
  await expect(
    page.getByRole("heading", { level: 1, name: "Session attendance report" })
  ).toBeVisible();
  await expect(page.getByText(/Course: E2E-103/)).toBeVisible();
});

test("session metadata is displayed correctly", async ({
  page,
}) => {
  await loginAsLecturer(page);
  const sessionId = await getEndedSessionId(page);
  await page.goto(`/app/lecturer/attendance-reports/session/${sessionId}`);
  await expect(
    page.getByRole("heading", { level: 1, name: "Session attendance report" })
  ).toBeVisible();

  await expect(page.getByText(/Course: E2E-103/)).toBeVisible();
  await expect(page.getByText(/Academic session:/)).toBeVisible();
  await expect(page.getByText("Level 100")).toBeVisible();
  await expect(page.getByText(/Lecturer:/)).toBeVisible();
  await expect(page.getByText(/Attendance network:/)).toBeVisible();
  await expect(page.getByText(/Location:/)).toBeVisible();
});

test("PRESENT student is displayed", async ({
  page,
}) => {
  await loginAsLecturer(page);
  const sessionId = await getEndedSessionId(page);
  await page.goto(`/app/lecturer/attendance-reports/session/${sessionId}`);
  await expect(page.getByText("Present", { exact: true })).toBeVisible();
});

test("LATE student is displayed", async ({
  page,
}) => {
  await loginAsLecturer(page);
  const sessionId = await getEndedSessionId(page);
  await page.goto(`/app/lecturer/attendance-reports/session/${sessionId}`);
  await expect(page.getByText("Late", { exact: true })).toBeVisible();
});

test("ABSENT student is displayed", async ({
  page,
}) => {
  await loginAsLecturer(page);
  const sessionId = await getEndedSessionId(page);
  await page.goto(`/app/lecturer/attendance-reports/session/${sessionId}`);
  await expect(page.getByText("Absent", { exact: true })).toBeVisible();
});

test("marked-at time is displayed for marked students", async ({
  page,
}) => {
  await loginAsLecturer(page);
  const sessionId = await getEndedSessionId(page);
  await page.goto(`/app/lecturer/attendance-reports/session/${sessionId}`);
  await expect(page.getByText(/Marked at/i)).toBeVisible();
});

test("lecturer sees no correction/edit controls", async ({
  page,
}) => {
  await loginAsLecturer(page);
  const sessionId = await getEndedSessionId(page);
  await page.goto(`/app/lecturer/attendance-reports/session/${sessionId}`);
  await expect(page.getByRole("button", { name: /mark/i })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /correct/i })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /end session/i })).toHaveCount(0);
});

test("Excel download button is visible", async ({
  page,
}) => {
  await loginAsLecturer(page);
  const sessionId = await getEndedSessionId(page);
  await page.goto(`/app/lecturer/attendance-reports/session/${sessionId}`);
  await expect(page.getByRole("button", { name: /export/i })).toBeVisible();
});

test("Excel download succeeds and filename is correct", async ({
  page,
}) => {
  await loginAsLecturer(page);
  const sessionId = await getEndedSessionId(page);
  await page.goto(`/app/lecturer/attendance-reports/session/${sessionId}`);

  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: /export/i }).click(),
  ]);

  const suggestedFilename = download.suggestedFilename()!;
  expect(suggestedFilename).toContain("Attendance");
  expect(suggestedFilename).toMatch(/E2E-|CSC201/);
  expect(suggestedFilename).toMatch(/\.xlsx$/);
});

test("different/unassigned lecturer cannot access the session report", async ({
  page,
  browser,
}) => {
  const mainContext = await browser.newContext();
  const mainPage = await mainContext.newPage();
  await loginAsLecturer(mainPage);
  const sessionId = await getEndedSessionId(mainPage);

  const ownerRes = await mainPage.request.get(
    `/api/lecturer/attendance-reports/session/${sessionId}`
  );
  expect(ownerRes.status()).toBe(200);

  const monitorContext = await browser.newContext();
  const monitorPage = await monitorContext.newPage();
  await loginAsMonitorLecturer(monitorPage);

  const nonOwnerRes = await monitorPage.request.get(
    `/api/lecturer/attendance-reports/session/${sessionId}`
  );
  expect(nonOwnerRes.status()).toBe(404);

  await monitorContext.close();
  await mainContext.close();
});

test("the page is responsive on a mobile viewport without horizontal overflow", async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 667 });
  await loginAsLecturer(page);
  const sessionId = await getEndedSessionId(page);
  await page.goto(`/app/lecturer/attendance-reports/session/${sessionId}`);
  await expect(page.locator(".admin-table__row").first()).toBeVisible();
  await expect(page.locator(".history-status").first()).toBeVisible();

  const overflow = await page.evaluate(() => {
    const documentElement = document.documentElement;
    return {
      scrollWidth: documentElement.scrollWidth,
      clientWidth: documentElement.clientWidth,
    };
  });
  expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth);
});

test("session-by-session attendance details are displayed", async ({
  page,
}) => {
  await loginAsLecturer(page);
  const sessionId = await getEndedSessionId(page);
  await page.goto(`/app/lecturer/attendance-reports/session/${sessionId}`);

  const rows = page.locator(".admin-table__row");
  await expect(rows).toHaveCount(3);

  const presentRow = rows.filter({ hasText: "E2E/STU/0001" });
  await expect(presentRow.locator(".history-status")).toHaveText("Present");
  // Check the 4th column (Marked At timestamp) for the present student
  await expect(presentRow.locator("td").nth(3)).not.toHaveText("Not available");

  const lateRow = rows.filter({ hasText: "E2E/STU/0002" });
  await expect(lateRow.locator(".history-status")).toHaveText("Late");
  // Check the 4th column (Marked At timestamp) for the late student
  await expect(lateRow.locator("td").nth(3)).not.toHaveText("Not available");

  const absentRow = rows.filter({ hasText: "E2E/STU/0003" });
  await expect(absentRow.locator(".history-status")).toHaveText("Absent");
  // Absent student shows "Not available" in the Marked At column
  await expect(absentRow.locator("td").nth(3)).toHaveText("Not available");
});

test("report API response includes all required fields", async ({
  page,
}) => {
  await loginAsLecturer(page);
  const sessionId = await getEndedSessionId(page);
  await page.goto(`/app/lecturer/attendance-reports/session/${sessionId}`);

  const response = await page.request.get(`/api/lecturer/attendance-reports/session/${sessionId}`);
  expect(response.status()).toBe(200);
  const payload = (await response.json()) as {
    data: {
      session: {
        sessionId: number;
        courseCode: string;
        courseTitle: string;
        academicSession: string;
        semester: string;
        level: number;
        startTime: string;
        endTime: string;
        lateThresholdMinutes: number;
        endedAt: string;
        startedByLecturer: {
          id: number;
          staffId: string;
          name: string;
        };
      };
      students: Array<{
        studentId: number;
        matricNumber: string;
        studentName: string;
        status: string;
        markedAt: string | null;
      }>;
    };
  };

  const session = payload.data.session;
  expect(session.sessionId).toBe(sessionId);
  expect(session.courseCode).toBe(COURSE_CODE);
  expect(session.courseTitle).toBe(COURSE_TITLE);

  const students = payload.data.students;
  expect(students.length).toBe(3);
  const statuses = students.map((student) => student.status);
  expect(statuses.filter((status) => status === "PRESENT")).toHaveLength(1);
  expect(statuses.filter((status) => status === "LATE")).toHaveLength(1);
  expect(statuses.filter((status) => status === "ABSENT")).toHaveLength(1);
  for (const student of students) {
    expect(["PRESENT", "LATE", "ABSENT"]).toContain(student.status);
    expect(student.markedAt === null || typeof student.markedAt === "string").toBe(
      true
    );
    expect(typeof student.studentId).toBe("number");
    expect(typeof student.matricNumber).toBe("string");
    expect(typeof student.studentName).toBe("string");
  }
});

test("no internal user IDs leak in the session report", async ({
  page,
}) => {
  await loginAsLecturer(page);
  const sessionId = await getEndedSessionId(page);
  await page.goto(`/app/lecturer/attendance-reports/session/${sessionId}`);

  await page.waitForLoadState("networkidle");

  const pageContent = await page.content();
  expect(pageContent).not.toContain('"userId"');
  expect(pageContent).not.toContain('"lecturer_id"');
});

test("lecturer can navigate from lecturer home to session report", async ({
  page,
}) => {
  await loginAsLecturer(page);
  await page.getByRole("link", { name: "Manage attendance sessions" }).click();
  await expect(page).toHaveURL(/\/app\/lecturer\/attendance$/);

  const historyItem = page
    .locator(".session-list__item")
    .filter({ hasText: COURSE_TITLE });
  await expect(historyItem.first()).toBeVisible();
  await historyItem.first().getByRole("link", { name: "View attendance report" }).click();
  await expect(
    page.getByRole("heading", { level: 1, name: "Session attendance report" })
  ).toBeVisible();
});