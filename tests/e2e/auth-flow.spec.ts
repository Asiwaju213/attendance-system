import { expect, test } from "@playwright/test";
import { E2E_ADMIN, E2E_LECTURER, E2E_STUDENT } from "./constants";
import { withLoginMutex } from "./helpers/login-mutex";

async function loginAsStudent(page: import("@playwright/test").Page): Promise<void> {
  await withLoginMutex("student", async () => {
    await page.goto("/login");
    await page.getByLabel("Matric Number").fill(E2E_STUDENT.matricNumber);
    await page.getByLabel("Password").fill(E2E_STUDENT.password);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page).toHaveURL(/\/app\/student$/, { timeout: 15_000 });
  });
}

async function loginAsLecturer(page: import("@playwright/test").Page): Promise<void> {
  await withLoginMutex("lecturer", async () => {
    await page.goto("/staff/lecturer/login");
    await page.getByLabel("Staff ID").fill(E2E_LECTURER.staffId);
    await page.getByLabel("Password").fill(E2E_LECTURER.password);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page).toHaveURL(/\/app\/lecturer$/, { timeout: 15_000 });
  });
}

async function loginAsAdmin(page: import("@playwright/test").Page): Promise<void> {
  await withLoginMutex("admin", async () => {
    await page.goto("/staff/admin/login");
    await page.getByLabel("Username").fill(E2E_ADMIN.username);
    await page.getByLabel("Password").fill(E2E_ADMIN.password);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page).toHaveURL(/\/app\/admin$/, { timeout: 15_000 });
  });
}

test("successful student login reaches the authenticated state", async ({
  page,
}) => {
  await loginAsStudent(page);

  await expect(page.getByText(E2E_STUDENT.name)).toBeVisible();
  await expect(page.getByText("Role: STUDENT")).toBeVisible();
  await expect(page.getByText(E2E_STUDENT.matricNumber)).toBeVisible();
});

test("successful lecturer login reaches the authenticated state", async ({
  page,
}) => {
  await loginAsLecturer(page);

  await expect(page.getByText(E2E_LECTURER.name)).toBeVisible();
  await expect(page.getByText("Role: LECTURER")).toBeVisible();
  await expect(page.getByText(E2E_LECTURER.staffId)).toBeVisible();
});

test("successful admin login reaches the authenticated state", async ({
  page,
}) => {
  await loginAsAdmin(page);

  await expect(page.getByText(E2E_ADMIN.name)).toBeVisible();
  await expect(page.getByText("Role: ADMIN")).toBeVisible();
  await expect(page.getByText(E2E_ADMIN.username)).toBeVisible();
});

test("invalid credentials show a generic error and stay on the login page", async ({
  page,
}) => {
  await page.goto("/login");
  await page.getByLabel("Matric Number").fill(E2E_STUDENT.matricNumber);
  await page.getByLabel("Password").fill("definitely-wrong-password");
  await page.getByRole("button", { name: "Sign in" }).click();

  await expect(page.getByRole("alert")).toBeVisible();
  await expect(page).toHaveURL(/\/login$/);
});

test("logging out returns to the unauthenticated state", async ({ page }) => {
  await loginAsStudent(page);

  await page.getByRole("button", { name: "Log out" }).click();

  await expect(page).toHaveURL(/\/login$/);
  await expect(
    page.getByRole("heading", { level: 1, name: "Student Login" })
  ).toBeVisible();
});

test("an unauthenticated user is sent to the student login page", async ({
  page,
}) => {
  await page.goto("/app/student");

  await expect(page).toHaveURL(/\/login$/);
  await expect(
    page.getByRole("heading", { level: 1, name: "Student Login" })
  ).toBeVisible();
});

test("a logged-in lecturer cannot reach the admin area", async ({ page }) => {
  await loginAsLecturer(page);

  await page.goto("/app/admin");
  await expect(page).toHaveURL(/\/app\/lecturer$/);
});