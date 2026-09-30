import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { E2E_ADMIN, E2E_LECTURER, E2E_STUDENT } from "./constants";
import { withLoginMutex } from "./helpers/login-mutex";

const INDEX_PAGE = "/app/admin/course-offerings";

async function loginAsAdmin(page: Page): Promise<void> {
  await page.goto("/staff/admin/login");
  await page.getByLabel("Username").fill(E2E_ADMIN.username);
  await page.getByLabel("Password").fill(E2E_ADMIN.password);
  await withLoginMutex("admin", async () => {
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page).toHaveURL(/\/app\/admin$/, { timeout: 15_000 });
  });
}

async function openIndexPage(page: Page): Promise<void> {
  await loginAsAdmin(page);
  await page.goto(INDEX_PAGE);
  await expect(
    page.getByRole("heading", { level: 1, name: "Course Offerings" })
  ).toBeVisible();
}

test("an unauthenticated user is redirected to the admin login page", async ({
  page,
}) => {
  await page.goto(INDEX_PAGE);

  await expect(page).toHaveURL(/\/staff\/admin\/login$/);
  await expect(
    page.getByRole("heading", { level: 1, name: "Admin Login" })
  ).toBeVisible();
});

test("a student cannot reach the course offerings page", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("Matric Number").fill(E2E_STUDENT.matricNumber);
  await page.getByLabel("Password").fill(E2E_STUDENT.password);
  await withLoginMutex("student", async () => {
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page).toHaveURL(/\/app\/student$/, { timeout: 15_000 });
  });

  await page.goto(INDEX_PAGE);

  await expect(page).toHaveURL(/\/app\/student$/);
  await expect(
    page.getByRole("heading", { level: 1, name: "Student Home" })
  ).toBeVisible();
});

test("a lecturer cannot reach the course offerings page", async ({ page }) => {
  await page.goto("/staff/lecturer/login");
  await page.getByLabel("Staff ID").fill(E2E_LECTURER.staffId);
  await page.getByLabel("Password").fill(E2E_LECTURER.password);
  await withLoginMutex("lecturer", async () => {
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page).toHaveURL(/\/app\/lecturer$/, { timeout: 15_000 });
  });

  await page.goto(INDEX_PAGE);

  await expect(page).toHaveURL(/\/app\/lecturer$/);
  await expect(
    page.getByRole("heading", { level: 1, name: "Lecturer Home" })
  ).toBeVisible();
});

test("Admin can navigate from Admin Home to Course Offerings", async ({
  page,
}) => {
  await loginAsAdmin(page);
  await page.getByRole("link", { name: "Course Offerings" }).click();

  await expect(page).toHaveURL(new RegExp(`${INDEX_PAGE}$`));
  await expect(
    page.getByRole("heading", { level: 1, name: "Course Offerings" })
  ).toBeVisible();
});

test("Course Offerings page no longer renders the 404 page", async ({
  page,
}) => {
  await openIndexPage(page);

  await expect(page.getByRole("heading", { name: "Page Not Found" })).toHaveCount(0);
});

test("offerings are displayed with session, semester, and status context", async ({
  page,
}) => {
  await openIndexPage(page);

  const rows = page.locator(".admin-table__row");
  await expect(rows.filter({ hasText: "E2E-101" }).first()).toBeVisible();
  await expect(rows.filter({ hasText: "E2E-102" }).first()).toBeVisible();
  await expect(rows.filter({ hasText: "E2E-103" }).first()).toBeVisible();
  await expect(page.getByText("E2E Computer Science 101").first()).toBeVisible();
  await expect(page.getByText("E2E-2026/2027").first()).toBeVisible();
  await expect(page.getByText("First Semester").first()).toBeVisible();
  await expect(page.getByText("Level 100").first()).toBeVisible();
  await expect(page.getByText("OPEN").first()).toBeVisible();
  await expect(page.getByText("CLOSED").first()).toBeVisible();
});

test("each offering row provides a roster action/link", async ({ page }) => {
  await openIndexPage(page);

  const row = page
    .locator(".admin-table__row")
    .filter({ hasText: "E2E-102" })
    .first();
  const rosterLink = row.getByRole("link", { name: "View roster" });
  await expect(rosterLink).toBeVisible();
  await expect(rosterLink).toHaveAttribute("href", /\/roster$/);
});

test("clicking the roster action reaches the roster page", async ({ page }) => {
  await openIndexPage(page);

  await page
    .locator(".admin-table__row")
    .filter({ hasText: "E2E-102" })
    .first()
    .getByRole("link", { name: "View roster" })
    .click();

  await expect(page).toHaveURL(/\/app\/admin\/course-offerings\/\d+\/roster$/);
  await expect(
    page.getByRole("heading", { level: 1, name: "Course Offering Roster" })
  ).toBeVisible();
});

test("empty state is shown when there are no offerings", async ({ page }) => {
  await loginAsAdmin(page);
  await page.route("**/api/admin/course-offerings", (route) => {
    void route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ data: [] }),
    });
  });
  await page.goto(INDEX_PAGE);

  await expect(
    page.getByRole("heading", { level: 1, name: "Course Offerings" })
  ).toBeVisible();
  await expect(page.getByText("No course offerings found.")).toBeVisible();
  await expect(page.locator(".admin-table__row")).toHaveCount(0);
});

test("an API error shows a message and retry recovers", async ({ page }) => {
  await loginAsAdmin(page);
  let fail = true;
  await page.route("**/api/admin/course-offerings", (route) => {
    if (fail) {
      void route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ error: "INTERNAL_ERROR", message: "boom" }),
      });
      return;
    }
    void route.fallback();
  });
  await page.goto(INDEX_PAGE);

  await expect(
    page.getByText("The course offerings could not be loaded. Please try again.")
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();

  fail = false;
  await page.getByRole("button", { name: "Retry" }).click();
  await expect(
    page.locator(".admin-table__row").filter({ hasText: "E2E-101" }).first()
  ).toBeVisible();
});