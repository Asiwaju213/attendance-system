import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { E2E_ADMIN, E2E_LECTURER, E2E_STUDENT } from "./constants";
import { withLoginMutex } from "./helpers/login-mutex";

const COURSES_PAGE = "/app/admin/courses";

const MANAGEMENT_COURSE_CODE = "E2EMGMT-101";
const MANAGEMENT_COURSE_TITLE = "E2E Management Computer Science 101";
const MANAGEMENT_COURSE_TITLE_UPDATED = "E2E Management Computer Science 101 Rev.";
const E2E_DEPARTMENT_LABEL = "E2E Test Department (E2EFLOW)";
const E2E_LECTURER_LABEL = "E2E Lecturer (E2E/LEC/0001) · E2E Test Department";

async function loginAsAdmin(page: Page): Promise<void> {
  await page.goto("/staff/admin/login");
  await page.getByLabel("Username").fill(E2E_ADMIN.username);
  await page.getByLabel("Password").fill(E2E_ADMIN.password);
  await withLoginMutex("admin", async () => {
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page).toHaveURL(/\/app\/admin$/, { timeout: 15_000 });
  });
}

async function openCoursesPage(page: Page): Promise<void> {
  await loginAsAdmin(page);
  await page.goto(COURSES_PAGE);
  await expect(
    page.getByRole("heading", { level: 1, name: "Course management" })
  ).toBeVisible();
}

test.describe.configure({ mode: "serial" });

test("an unauthenticated user is redirected to the admin login page", async ({
  page,
}) => {
  await page.goto(COURSES_PAGE);

  await expect(page).toHaveURL(/\/staff\/admin\/login$/);
  await expect(
    page.getByRole("heading", { level: 1, name: "Administrator Login" })
  ).toBeVisible();
});

test("a student cannot reach the course management page", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("Matric Number").fill(E2E_STUDENT.matricNumber);
  await page.getByLabel("Password").fill(E2E_STUDENT.password);
  await withLoginMutex("student", async () => {
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page).toHaveURL(/\/app\/student$/, { timeout: 15_000 });
  });

  await page.goto(COURSES_PAGE);

  await expect(page).toHaveURL(/\/app\/student$/);
  await expect(
    page.getByRole("heading", { level: 1, name: "Student Home" })
  ).toBeVisible();
});

test("a lecturer cannot reach the course management page", async ({ page }) => {
  await page.goto("/staff/lecturer/login");
  await page.getByLabel("Staff ID").fill(E2E_LECTURER.staffId);
  await page.getByLabel("Password").fill(E2E_LECTURER.password);
  await withLoginMutex("lecturer", async () => {
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page).toHaveURL(/\/app\/lecturer$/, { timeout: 15_000 });
  });

  await page.goto(COURSES_PAGE);

  await expect(page).toHaveURL(/\/app\/lecturer$/);
  await expect(
    page.getByRole("heading", { level: 1, name: "Lecturer Home" })
  ).toBeVisible();
});

test("Admin can navigate from Admin Home to Course Management", async ({
  page,
}) => {
  await loginAsAdmin(page);
  await page.getByRole("link", { name: "Course management" }).click();

  await expect(page).toHaveURL(new RegExp(`${COURSES_PAGE}$`));
  await expect(
    page.getByRole("heading", { level: 1, name: "Course management" })
  ).toBeVisible();
});

test("Course Management page no longer renders the 404 page", async ({
  page,
}) => {
  await openCoursesPage(page);

  await expect(page.getByRole("heading", { name: "Page Not Found" })).toHaveCount(0);
});

test("Admin can create a course and the course appears in the list", async ({
  page,
}) => {
  await openCoursesPage(page);

  await page.getByLabel("Course code").fill(MANAGEMENT_COURSE_CODE);
  await page.getByLabel("Course title").fill(MANAGEMENT_COURSE_TITLE);
  await page.getByLabel("Level").selectOption({ label: "Level 100" });
  await page.getByLabel("Owner type").selectOption("DEPARTMENT");
  await page
    .getByLabel("Department")
    .selectOption({ label: E2E_DEPARTMENT_LABEL });
  await page.getByRole("button", { name: "Add course" }).click();

  const row = page
    .locator(".admin-table__row")
    .filter({ hasText: MANAGEMENT_COURSE_CODE })
    .first();
  await expect(row).toBeVisible();
  await expect(row.getByText(MANAGEMENT_COURSE_TITLE)).toBeVisible();
  await expect(row.getByText("Level 100")).toBeVisible();
  await expect(row.getByText("E2E Test Department")).toBeVisible();
  await expect(row.getByText("Active")).toBeVisible();
});

test("attempting to reuse a course code shows a conflict error", async ({
  page,
}) => {
  await openCoursesPage(page);

  await page.getByLabel("Course code").fill(MANAGEMENT_COURSE_CODE);
  await page.getByLabel("Course title").fill(MANAGEMENT_COURSE_TITLE);
  await page.getByLabel("Level").selectOption({ label: "Level 100" });
  await page.getByLabel("Owner type").selectOption("DEPARTMENT");
  await page
    .getByLabel("Department")
    .selectOption({ label: E2E_DEPARTMENT_LABEL });
  await page.getByRole("button", { name: "Add course" }).click();

  await expect(
    page.getByText("A course with this code already exists.")
  ).toBeVisible();
});

test("Admin can edit a course and the change is reflected", async ({ page }) => {
  await openCoursesPage(page);

  const row = page
    .locator(".admin-table__row")
    .filter({ hasText: MANAGEMENT_COURSE_CODE })
    .first();
  await expect(row).toBeVisible();
  await row.getByRole("button", { name: "Edit" }).click();

  const editPanel = page.locator('section[aria-labelledby="edit-course-heading"]');
  await expect(editPanel).toBeVisible();
  await editPanel.getByLabel("Course title").fill(MANAGEMENT_COURSE_TITLE_UPDATED);
  await editPanel.getByRole("button", { name: "Save changes" }).click();

  await expect(
    page
      .locator(".admin-table__row")
      .filter({ hasText: MANAGEMENT_COURSE_CODE })
      .getByText(MANAGEMENT_COURSE_TITLE_UPDATED)
  ).toBeVisible();
});

test("Admin can deactivate and reactivate a course", async ({ page }) => {
  await openCoursesPage(page);

  const row = page
    .locator(".admin-table__row")
    .filter({ hasText: MANAGEMENT_COURSE_CODE })
    .first();
  await expect(row.getByText("Active")).toBeVisible();

  await row.getByRole("button", { name: "Deactivate" }).click();
  await expect(row.getByText("Inactive")).toBeVisible();

  await row.getByRole("button", { name: "Activate" }).click();
  await expect(row.getByText("Active")).toBeVisible();
});

test("Admin can create an offering and manage its lecturers", async ({
  page,
}) => {
  await loginAsAdmin(page);
  await page.goto("/app/admin/course-offerings");
  await expect(
    page.getByRole("heading", { level: 1, name: "Course offerings" })
  ).toBeVisible();

  const offeringOptionLabel = `${MANAGEMENT_COURSE_CODE} · ${MANAGEMENT_COURSE_TITLE_UPDATED} (Level 100)`;
  await page
    .getByLabel("Course", { exact: true })
    .selectOption({ label: offeringOptionLabel });
  const sessionSelect = page.getByLabel("Academic session");
  const sessionLabels = await sessionSelect.locator("option").allTextContents();
  const sessionLabel = sessionLabels
    .map((text) => text.trim())
    .find((text) => text.startsWith("E2E-2026/2027"));
  expect(sessionLabel, "expected the E2E academic session option").toBeTruthy();
  await sessionSelect.selectOption({ label: sessionLabel as string });
  await page
    .getByLabel("Semester")
    .selectOption({ label: "First Semester" });
  await page.getByRole("button", { name: "Create offering" }).click();

  await expect(page.getByText("Course offering created.")).toBeVisible();

  const offeringRow = page
    .locator(".admin-table__row")
    .filter({ hasText: MANAGEMENT_COURSE_CODE })
    .first();
  await expect(offeringRow).toBeVisible();
  await expect(offeringRow.getByText("Open")).toBeVisible();

  await offeringRow.getByRole("button", { name: "Lecturers" }).click();
  await expect(
    page.getByText("No lecturers assigned yet.")
  ).toBeVisible();

  const assignSelect = page.getByLabel("Assign a lecturer");
  await assignSelect.selectOption({ label: E2E_LECTURER_LABEL });
  await page.getByRole("button", { name: "Assign lecturer" }).click();

  const assignedRow = page
    .locator(".admin-table__row")
    .filter({ hasText: "E2E Lecturer" })
    .first();
  await expect(assignedRow.getByText(E2E_LECTURER.staffId)).toBeVisible();
  await expect(page.getByText("Lecturer assigned.")).toBeVisible();

  await expect(
    assignSelect.locator("option", { hasText: "E2E Lecturer" })
  ).toHaveCount(0);

  await assignedRow.getByRole("button", { name: "Remove" }).click();
  await expect(page.getByText("Lecturer removed.")).toBeVisible();
  await expect(page.getByText("No lecturers assigned yet.")).toBeVisible();
  await expect(
    assignSelect.locator("option", { hasText: "E2E Lecturer" })
  ).toHaveCount(1);
});