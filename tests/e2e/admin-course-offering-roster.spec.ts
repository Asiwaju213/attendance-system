import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import {
  E2E_ADMIN,
  E2E_STUDENT,
  E2E_STUDENT_NO_COURSES,
  E2E_STUDENT_THREE,
  E2E_STUDENT_TWO,
} from "./constants";
import { withLoginMutex } from "./helpers/login-mutex";
import {
  acquireE2E102RegistrationFixturesLock,
  resetE2E102Registrations,
} from "./helpers/attendance-fixture-mutex";

test.describe.configure({ mode: "serial" });

const ROSTER_PAGE = "/app/admin/course-offerings";

let releaseRegistrationLock: (() => Promise<void>) | undefined;

test.beforeAll(async () => {
  releaseRegistrationLock = await acquireE2E102RegistrationFixturesLock();
  resetE2E102Registrations();
});

test.afterAll(async () => {
  try {
    resetE2E102Registrations();
  } finally {
    await releaseRegistrationLock?.();
  }
});

async function loginAsAdmin(page: Page): Promise<void> {
  await page.goto("/staff/admin/login");
  await page.getByLabel("Username").fill(E2E_ADMIN.username);
  await page.getByLabel("Password").fill(E2E_ADMIN.password);
  await withLoginMutex("admin", async () => {
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page).toHaveURL(/\/app\/admin$/, { timeout: 15_000 });
  });
}

async function openRosterPage(page: Page, offeringId: number): Promise<void> {
  await page.goto(`${ROSTER_PAGE}/${offeringId}/roster`);
  await expect(page.getByRole("heading", { level: 1, name: "Course Offering Roster" })).toBeVisible();
}

async function getOpenOfferingId(page: Page, courseCode: string): Promise<number> {
  const response = await page.request.get("/api/admin/course-offerings");
  expect(response.ok()).toBeTruthy();
  const payload = (await response.json()) as { data: Array<{ id: number; courseCode: string; status: string }> };
  const offering = payload.data.find((o) => o.courseCode === courseCode && o.status === "OPEN");
  expect(offering).toBeDefined();
  return offering!.id;
}

async function openEnrollPanel(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Enroll Student" }).click();
  await expect(page.getByLabel("Search students")).toBeVisible();
}

async function pickStudent(page: Page, matricNumber: string): Promise<void> {
  const searchRow = page
    .locator(".confirm-row--block .admin-table__row")
    .filter({ hasText: matricNumber });
  await expect(searchRow).toBeVisible({ timeout: 10_000 });
  await searchRow.getByRole("button", { name: "Select" }).click();
}

test("Admin can open the course-offering roster", async ({ page }) => {
  await loginAsAdmin(page);
  const offeringId = await getOpenOfferingId(page, "E2E-102");
  await openRosterPage(page, offeringId);
});

test("Offering context renders in the roster", async ({ page }) => {
  await loginAsAdmin(page);
  const offeringId = await getOpenOfferingId(page, "E2E-102");
  await openRosterPage(page, offeringId);
  await expect(page.getByText(/Course:\s*E2E-102 — E2E Computer Science 102/)).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText(/Academic session:\s*E2E-2026\/2027/)).toBeVisible();
  await expect(page.getByText(/Semester:\s*First Semester/)).toBeVisible();
  await expect(page.getByText(/Level:\s*Level 100/)).toBeVisible();
  await expect(page.getByText(/Status:\s*OPEN/)).toBeVisible();
});

test("Roster rows render", async ({ page }) => {
  await loginAsAdmin(page);
  const offeringId = await getOpenOfferingId(page, "E2E-101");
  await openRosterPage(page, offeringId);
  const row = page.locator(".admin-table__row").filter({ hasText: "E2E/STU/0001" });
  await expect(row).toBeVisible({ timeout: 10_000 });
});

test("Matric search works", async ({ page }) => {
  await loginAsAdmin(page);
  const offeringId = await getOpenOfferingId(page, "E2E-101");
  await openRosterPage(page, offeringId);
  await page.getByLabel("Matric number").fill("E2E/STU/0001");
  const row = page.locator(".admin-table__row").filter({ hasText: "E2E/STU/0001" });
  await expect(row).toBeVisible();
});

test("Student-name search works", async ({ page }) => {
  await loginAsAdmin(page);
  const offeringId = await getOpenOfferingId(page, "E2E-101");
  await openRosterPage(page, offeringId);
  await page.getByLabel("Student name").fill("E2E Student");
  const row = page.locator(".admin-table__row").filter({ hasText: "E2E Student" });
  await expect(row).toBeVisible();
});

test("Status filter works", async ({ page }) => {
  await loginAsAdmin(page);
  const offeringId = await getOpenOfferingId(page, "E2E-101");
  await openRosterPage(page, offeringId);
  await page.getByLabel("Status").selectOption("ENROLLED");
  const row = page.locator(".admin-table__row").filter({ hasText: "E2E/STU/0001" });
  await expect(row).toBeVisible({ timeout: 10_000 });
});

test("Pagination controls work", async ({ page }) => {
  await loginAsAdmin(page);
  const offeringId = await getOpenOfferingId(page, "E2E-101");
  await openRosterPage(page, offeringId);
  await expect(page.getByRole("button", { name: "Previous" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Next" })).toBeVisible();
});

test("Empty state works for an offering with no registrations", async ({ page }) => {
  await loginAsAdmin(page);
  const offeringId = await getOpenOfferingId(page, "E2E-102");
  await openRosterPage(page, offeringId);
  await expect(page.getByText(/No registrations/i)).toBeVisible({ timeout: 10_000 });
});

test("Enrollment UI opens", async ({ page }) => {
  await loginAsAdmin(page);
  const offeringId = await getOpenOfferingId(page, "E2E-102");
  await openRosterPage(page, offeringId);
  await openEnrollPanel(page);
  await expect(page.getByText("Enroll a student by searching for their name or matric number.")).toBeVisible();
});

test("Eligible student can be enrolled", async ({ page }) => {
  await loginAsAdmin(page);
  const offeringId = await getOpenOfferingId(page, "E2E-102");
  await openRosterPage(page, offeringId);
  await openEnrollPanel(page);
  await page.getByLabel("Search students").fill(E2E_STUDENT_TWO.name);
  await pickStudent(page, E2E_STUDENT_TWO.matricNumber);
  await expect(page.getByText("Confirm Enrollment")).toBeVisible();
  await page.getByRole("button", { name: "Confirm Enrollment" }).click();
  await expect(page.getByText("Student enrolled successfully.")).toBeVisible();
});

test("Enrollment appears in roster after refresh", async ({ page }) => {
  await loginAsAdmin(page);
  const offeringId = await getOpenOfferingId(page, "E2E-102");
  await openRosterPage(page, offeringId);
  await openEnrollPanel(page);
  await page.getByLabel("Search students").fill(E2E_STUDENT_THREE.name);
  await pickStudent(page, E2E_STUDENT_THREE.matricNumber);
  await page.getByRole("button", { name: "Confirm Enrollment" }).click();
  await expect(page.getByText("Student enrolled successfully.")).toBeVisible();
  // Refresh roster
  await page.reload();
  const row = page.locator(".admin-table__row").filter({ hasText: E2E_STUDENT_THREE.matricNumber });
  await expect(row).toBeVisible({ timeout: 10_000 });
});

test("Duplicate enrollment displays a useful error", async ({ page }) => {
  await loginAsAdmin(page);
  const offeringId = await getOpenOfferingId(page, "E2E-101");
  await openRosterPage(page, offeringId);
  await openEnrollPanel(page);
  await page.getByLabel("Search students").fill("E2E/STU/0001");
  await pickStudent(page, "E2E/STU/0001");
  await page.getByRole("button", { name: "Confirm Enrollment" }).click();
  await expect(page.getByText("This student is already enrolled in this offering.")).toBeVisible();
});

test("Invalid/ineligible student displays backend validation error", async ({ page }) => {
  await loginAsAdmin(page);
  const offeringId = await getOpenOfferingId(page, "E2E-102");
  await openRosterPage(page, offeringId);
  await openEnrollPanel(page);
  // E2E/STU/0005 is level 300, E2E-102 is level 100 -> wrong level
  await page.getByLabel("Search students").fill(E2E_STUDENT_NO_COURSES.name);
  await pickStudent(page, E2E_STUDENT_NO_COURSES.matricNumber);
  await page.getByRole("button", { name: "Confirm Enrollment" }).click();
  await expect(page.getByText("This student's level does not match the course level.")).toBeVisible();
});

test("Non-admin cannot access the roster page", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("Matric Number").fill(E2E_STUDENT.matricNumber);
  await page.getByLabel("Password").fill(E2E_STUDENT.password);
  await withLoginMutex("student", async () => {
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page).toHaveURL(/\/app\/student$/, { timeout: 15_000 });
  });
  await page.goto(`${ROSTER_PAGE}/1/roster`);
  await expect(page).toHaveURL(/\/app\/student$/);
});