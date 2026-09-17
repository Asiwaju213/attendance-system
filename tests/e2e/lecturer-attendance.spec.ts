import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
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

const OFFERING_OPTION = /E2E-101/;
const NETWORK_OPTION = /E2E-NET-001/;
const LOCATION_OPTION = /E2E Test Lecture Hall/;

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
  await loginAsLecturer(page);
  await page.goto("/app/lecturer/attendance");
  await expect(
    page.getByRole("heading", { level: 1, name: "Attendance Sessions" })
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

async function selectSessionOptions(page: Page): Promise<void> {
  await selectOptionByText(page.getByLabel("Course offering"), OFFERING_OPTION);
  await selectOptionByText(page.getByLabel("Attendance network"), NETWORK_OPTION);
  await selectOptionByText(page.getByLabel("Location"), LOCATION_OPTION);
}

async function endActiveSession(page: Page): Promise<void> {
  await page.getByRole("button", { name: "End session" }).click();
  await expect(page.getByText("End this session now?")).toBeVisible();
  await page.getByRole("button", { name: "Confirm end" }).click();
  await expect(page.getByText("No active session.")).toBeVisible();
}

test("an unauthenticated user is redirected to the lecturer login page", async ({
  page,
}) => {
  await page.goto("/app/lecturer/attendance");

  await expect(page).toHaveURL(/\/staff\/lecturer\/login$/);
  await expect(
    page.getByRole("heading", { level: 1, name: "Lecturer Login" })
  ).toBeVisible();
});

test("a student cannot reach the lecturer attendance page", async ({ page }) => {
  await withLoginMutex("student", async () => {
    await page.goto("/login");
    await page.getByLabel("Matric Number").fill(E2E_STUDENT.matricNumber);
    await page.getByLabel("Password").fill(E2E_STUDENT.password);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page).toHaveURL(/\/app\/student$/, { timeout: 15_000 });
  });

  await page.goto("/app/lecturer/attendance");

  await expect(page).toHaveURL(/\/app\/student$/);
  await expect(
    page.getByRole("heading", { level: 1, name: "Student Home" })
  ).toBeVisible();
});

test("the attendance page shows the start form with default presets", async ({
  page,
}) => {
  await openAttendancePage(page);

  await expect(
    page.getByRole("heading", { level: 2, name: "Start an Attendance Session" })
  ).toBeVisible();
  await expect(page.getByLabel("Course offering")).toBeVisible();
  await expect(page.getByLabel("Attendance network")).toBeVisible();
  await expect(page.getByLabel("Location")).toBeVisible();
  await expect(page.getByRole("radio", { name: "60 min", exact: true })).toBeChecked();
  await expect(page.getByRole("radio", { name: "5 min", exact: true })).toBeChecked();
  await expect(
    page.getByRole("button", { name: "Start session" })
  ).toBeVisible();
});

test("catalog options load and only open offerings appear", async ({ page }) => {
  await openAttendancePage(page);

  const offeringSelect = page.getByLabel("Course offering");
  await expect(offeringSelect).toContainText(OFFERING_OPTION);
  await expect(offeringSelect).toContainText("First Semester");
  await expect(offeringSelect).not.toContainText("Second Semester");

  await expect(page.getByLabel("Attendance network")).toContainText(
    NETWORK_OPTION
  );
  await expect(page.getByLabel("Location")).toContainText(LOCATION_OPTION);
});

test("client-side validation blocks an incomplete submission", async ({
  page,
}) => {
  await openAttendancePage(page);

  await page.getByRole("button", { name: "Start session" }).click();

  await expect(page.getByText("Please select a course offering.")).toBeVisible();
  await expect(page.getByText("Please select an attendance network.")).toBeVisible();
  await expect(page.getByText("Please select a location.")).toBeVisible();
  await expect(page).toHaveURL(/\/app\/lecturer\/attendance$/);
  await expect(page.getByText("No active session.")).toBeVisible();
});

test("a valid session can be started and appears as the current session", async ({
  page,
}) => {
  await openAttendancePage(page);
  await selectSessionOptions(page);

  await page.getByRole("button", { name: "Start session" }).click();

  await expect(
    page.getByText("E2E-101 — E2E Computer Science 101")
  ).toBeVisible();
  await expect(page.getByText("Active", { exact: true })).toBeVisible();
  await expect(page.getByText(/remaining/, { exact: false })).toBeVisible();
  await expect(page.getByText("No active session.")).toBeHidden();
});

test("another session cannot be started while one is active", async ({
  page,
}) => {
  await openAttendancePage(page);

  await expect(page.getByText("No active session.")).toBeHidden();
  await expect(
    page.getByText("You already have an active session. End it before starting a new one.")
  ).toBeVisible();
  await expect(page.getByLabel("Course offering")).toBeDisabled();
  await expect(page.getByRole("button", { name: "Start session" })).toBeDisabled();
});

test("ending requires confirmation and updates state and history", async ({
  page,
}) => {
  await openAttendancePage(page);

  await page.getByRole("button", { name: "End session" }).click();
  await expect(page.getByText("End this session now?")).toBeVisible();

  await page.getByRole("button", { name: "Confirm end" }).click();

  await expect(page.getByText("No active session.")).toBeVisible();
  const historyItem = page
    .locator(".session-list__item")
    .filter({ hasText: "E2E Computer Science 101" });
  await expect(historyItem).toContainText("Ended");
});

test("an active session started elsewhere is surfaced with a clear error", async ({
  page,
}) => {
  await openAttendancePage(page);
  await selectSessionOptions(page);

  const offerings = await (await page.request.get("/api/lecturer/course-offerings")).json();
  const networks = await (await page.request.get("/api/lecturer/attendance-networks")).json();
  const locations = await (await page.request.get("/api/lecturer/locations")).json();

  const created = await page.request.post("/api/lecturer/attendance-sessions", {
    data: {
      courseOfferingId: offerings.data[0].id,
      attendanceNetworkId: networks.data[0].id,
      locationId: locations.data[0].id,
      durationMinutes: 60,
      lateThresholdMinutes: 5,
    },
  });
  expect(created.status()).toBe(201);

  await page.getByRole("button", { name: "Start session" }).click();

  await expect(
    page.getByRole("alert").filter({ hasText: "You already have an active attendance session." })
  ).toBeVisible();

  await page.reload();
  await endActiveSession(page);
});