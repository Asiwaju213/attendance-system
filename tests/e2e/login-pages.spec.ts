import { expect, test } from "@playwright/test";

test("student login page exists at /login", async ({ page }) => {
  await page.goto("/login");

  await expect(page).toHaveTitle("OOU Attendance System");
  await expect(
    page.getByRole("heading", { level: 1, name: "Student Login" })
  ).toBeVisible();
});

test("student login page has matric number and password fields", async ({
  page,
}) => {
  await page.goto("/login");

  await expect(page.getByLabel("Matric Number")).toBeVisible();
  await expect(page.getByLabel("Password")).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
});

test("student login page does not contain a role selector", async ({ page }) => {
  await page.goto("/login");

  await expect(page.getByRole("combobox")).toHaveCount(0);
  await expect(page.getByRole("radio")).toHaveCount(0);
  await expect(page.getByRole("option")).toHaveCount(0);
});

test("student login page links to registration and staff login", async ({
  page,
}) => {
  await page.goto("/login");

  await expect(page.getByRole("link", { name: /register/i })).toBeVisible();
  const staffLink = page.getByRole("link", { name: "Staff login" });
  await expect(staffLink).toBeVisible();

  await staffLink.click();
  await expect(page).toHaveURL(/\/staff\/login$/);
});

test("staff login page exists at /staff/login", async ({ page }) => {
  await page.goto("/staff/login");

  await expect(
    page.getByRole("heading", { level: 1, name: "Staff Login" })
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: /lecturer login/i })
  ).toBeVisible();
  await expect(page.getByRole("link", { name: /admin login/i })).toBeVisible();
});

test("lecturer login page exists at /staff/lecturer/login", async ({ page }) => {
  await page.goto("/staff/lecturer/login");

  await expect(
    page.getByRole("heading", { level: 1, name: "Lecturer Login" })
  ).toBeVisible();
  await expect(page.getByLabel("Staff ID")).toBeVisible();
  await expect(page.getByLabel("Password")).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
});

test("admin login page exists at /staff/admin/login", async ({ page }) => {
  await page.goto("/staff/admin/login");

  await expect(
    page.getByRole("heading", { level: 1, name: "Admin Login" })
  ).toBeVisible();
  await expect(page.getByLabel("Username")).toBeVisible();
  await expect(page.getByLabel("Password")).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
});