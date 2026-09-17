import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
import { E2E_ADMIN, E2E_LECTURER, E2E_STUDENT } from "./constants";
import { withLoginMutex } from "./helpers/login-mutex";

test.describe.configure({ mode: "serial" });

const SEEDED_SESSION = "E2E-2026/2027";
const CREATED_SESSION = "E2E-AP 2030/2031";
const RENAMED_SESSION = "E2E-AP 2031/2032";
const EXTERNAL_SESSION = "E2E-AP External 2050/2051";
const SAVE_STATE_SESSION = "E2E-AP Save State 2060/2061";

let createdSessionName: string | null = null;
let renamedSessionName: string | null = null;

async function loginAsAdmin(page: Page): Promise<void> {
  await withLoginMutex("admin", async () => {
    await page.goto("/staff/admin/login");
    await page.getByLabel("Username").fill(E2E_ADMIN.username);
    await page.getByLabel("Password").fill(E2E_ADMIN.password);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page).toHaveURL(/\/app\/admin$/, { timeout: 15_000 });
  });
}

async function openAcademicPeriodsPage(page: Page): Promise<void> {
  await loginAsAdmin(page);
  await page.goto("/app/admin/academic-periods");
  await expect(
    page.getByRole("heading", { level: 1, name: /Academic Sessions/ })
  ).toBeVisible();
}

function sessionStatusBadge(row: Locator) {
  return row.locator(".session-status");
}

test("an unauthenticated user is redirected to the admin login page", async ({
  page,
}) => {
  await page.goto("/app/admin/academic-periods");

  await expect(page).toHaveURL(/\/staff\/admin\/login$/);
  await expect(
    page.getByRole("heading", { level: 1, name: "Admin Login" })
  ).toBeVisible();
});

test("a student cannot reach the academic periods page", async ({ page }) => {
  await withLoginMutex("student", async () => {
    await page.goto("/login");
    await page.getByLabel("Matric Number").fill(E2E_STUDENT.matricNumber);
    await page.getByLabel("Password").fill(E2E_STUDENT.password);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page).toHaveURL(/\/app\/student$/, { timeout: 15_000 });
  });

  await page.goto("/app/admin/academic-periods");

  await expect(page).toHaveURL(/\/app\/student$/);
  await expect(
    page.getByRole("heading", { level: 1, name: "Student Home" })
  ).toBeVisible();
});

test("a lecturer cannot reach the academic periods page", async ({ page }) => {
  await withLoginMutex("lecturer", async () => {
    await page.goto("/staff/lecturer/login");
    await page.getByLabel("Staff ID").fill(E2E_LECTURER.staffId);
    await page.getByLabel("Password").fill(E2E_LECTURER.password);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page).toHaveURL(/\/app\/lecturer$/, { timeout: 15_000 });
  });

  await page.goto("/app/admin/academic-periods");

  await expect(page).toHaveURL(/\/app\/lecturer$/);
  await expect(
    page.getByRole("heading", { level: 1, name: "Lecturer Home" })
  ).toBeVisible();
});

test("an admin can open the page from Admin Home and see the active session", async ({
  page,
}) => {
  await loginAsAdmin(page);

  await page
    .getByRole("link", { name: "Academic Sessions & Semesters" })
    .click();

  await expect(page).toHaveURL(/\/app\/admin\/academic-periods$/);
  const seededRow = page.getByRole("row").filter({ hasText: SEEDED_SESSION });
  await expect(seededRow).toBeVisible();
  await expect(sessionStatusBadge(seededRow)).toHaveText("Active");
});

test("the session list shows a loading state before rendering rows", async ({
  page,
}) => {
  await loginAsAdmin(page);
  await page.route("**/api/admin/academic-sessions", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    await route.continue();
  });

  await page.goto("/app/admin/academic-periods");

  await expect(page.getByText(/Loading academic sessions/)).toBeVisible({
    timeout: 10_000,
  });
  await expect(
    page.getByRole("row").filter({ hasText: SEEDED_SESSION })
  ).toBeVisible();
});

test("an admin can create an academic session and it appears as inactive", async ({
  page,
}) => {
  await openAcademicPeriodsPage(page);
  createdSessionName = `${CREATED_SESSION} ${Date.now()}`;

  await page
    .getByLabel("New academic session name", { exact: true })
    .fill(createdSessionName);
  await page.getByRole("button", { name: "Add session", exact: true }).click();

  const row = page.getByRole("row").filter({ hasText: createdSessionName });
  await expect(row).toBeVisible();
  await expect(sessionStatusBadge(row)).toHaveText("Inactive");
  await expect(
    page.getByLabel("New academic session name", { exact: true })
  ).toHaveValue("");
});

test("creating a session shows a saving state on the button", async ({
  page,
}) => {
  await openAcademicPeriodsPage(page);
  await page.route("**/api/admin/academic-sessions", async (route) => {
    if (route.request().method() === "POST") {
      await new Promise((resolve) => setTimeout(resolve, 700));
    }
    await route.continue();
  });

  await page
    .getByLabel("New academic session name", { exact: true })
    .fill(SAVE_STATE_SESSION);
  await page.getByRole("button", { name: "Add session", exact: true }).click();

  await expect(page.getByRole("button", { name: /Adding/ })).toBeVisible();
  await expect(
    page.getByRole("row").filter({ hasText: SAVE_STATE_SESSION })
  ).toBeVisible();
});

test("creating a duplicate session name shows a conflict error", async ({
  page,
}) => {
  await openAcademicPeriodsPage(page);
  const uniqueName = `${CREATED_SESSION} ${Date.now()}`;

  await page
    .getByLabel("New academic session name", { exact: true })
    .fill(uniqueName);
  await page.getByRole("button", { name: "Add session", exact: true }).click();

  await expect(
    page.getByRole("row").filter({ hasText: uniqueName })
  ).toBeVisible();

  await page
    .getByLabel("New academic session name", { exact: true })
    .fill(uniqueName);
  await page.getByRole("button", { name: "Add session", exact: true }).click();

  await expect(
    page.getByRole("alert").filter({ hasText: /already exists/ })
  ).toBeVisible();
});

test("an empty session name is rejected without a request", async ({ page }) => {
  await openAcademicPeriodsPage(page);

  await page.getByRole("button", { name: "Add session", exact: true }).click();

  await expect(
    page.getByText("Please enter an academic session name.")
  ).toBeVisible();
});

test("an admin can rename an academic session", async ({ page }) => {
  await openAcademicPeriodsPage(page);

  expect(createdSessionName).not.toBeNull();
  const row = page.getByRole("row").filter({ hasText: createdSessionName! });
  await row.getByRole("button", { name: "Edit", exact: true }).click();
  await page
    .getByLabel("Academic session name", { exact: true })
    .fill(RENAMED_SESSION);
  await page.getByRole("button", { name: "Save", exact: true }).click();

  await expect(
    page.getByRole("row").filter({ hasText: RENAMED_SESSION })
  ).toBeVisible();
  await expect(
    page.getByRole("row").filter({ hasText: createdSessionName! })
  ).toHaveCount(0);
  renamedSessionName = RENAMED_SESSION;
});

test("activating a session deactivates the previous active session", async ({
  page,
}) => {
  await openAcademicPeriodsPage(page);

  expect(renamedSessionName).not.toBeNull();
  const row = page.getByRole("row").filter({ hasText: renamedSessionName! });
  await row.getByRole("button", { name: "Activate", exact: true }).click();

  await expect(sessionStatusBadge(row)).toHaveText("Active");
  const seededRow = page.getByRole("row").filter({ hasText: SEEDED_SESSION });
  await expect(sessionStatusBadge(seededRow)).toHaveText("Inactive");
});

test("deactivating the active session leaves the list with clear statuses", async ({
  page,
}) => {
  await openAcademicPeriodsPage(page);

  expect(renamedSessionName).not.toBeNull();
  const row = page.getByRole("row").filter({ hasText: renamedSessionName! });
  await row.getByRole("button", { name: "Deactivate", exact: true }).click();

  await expect(sessionStatusBadge(row)).toHaveText("Inactive");
  const seededRow = page.getByRole("row").filter({ hasText: SEEDED_SESSION });
  await expect(sessionStatusBadge(seededRow)).toHaveText("Inactive");
});

test("a failed activation shows an error and does not change the status", async ({
  page,
}) => {
  await openAcademicPeriodsPage(page);
  await page.route("**/api/admin/academic-sessions/*", (route) =>
    route.abort()
  );

  expect(renamedSessionName).not.toBeNull();
  const row = page.getByRole("row").filter({ hasText: renamedSessionName! });
  await row.getByRole("button", { name: "Activate", exact: true }).click();

  await expect(
    page.getByRole("alert").filter({ hasText: /Something went wrong/ })
  ).toBeVisible();
  await expect(sessionStatusBadge(row)).toHaveText("Inactive");
});

test("a failed list load shows an error and Retry recovers", async ({
  page,
}) => {
  await loginAsAdmin(page);
  await page.route("**/api/admin/academic-sessions", (route) => route.abort());

  await page.goto("/app/admin/academic-periods");

  await expect(
    page.getByRole("alert").filter({ hasText: /Something went wrong/ })
  ).toBeVisible();
  await page.unroute("**/api/admin/academic-sessions");
  await page.getByRole("button", { name: "Retry", exact: true }).first().click();

  await expect(
    page.getByRole("row").filter({ hasText: SEEDED_SESSION })
  ).toBeVisible();
});

test("changes made outside the page are shown after a reload", async ({
  page,
}) => {
  await loginAsAdmin(page);
  const externalName = `${EXTERNAL_SESSION} ${Date.now()}`;
  const response = await page.request.post("/api/admin/academic-sessions", {
    data: { name: externalName },
  });
  expect(response.status()).toBe(201);

  await page.goto("/app/admin/academic-periods");

  await expect(
    page.getByRole("row").filter({ hasText: externalName })
  ).toBeVisible();
});

test("academic sessions cannot be deleted from the page", async ({ page }) => {
  await openAcademicPeriodsPage(page);

  await expect(page.getByRole("button", { name: /delete/i })).toHaveCount(0);
});

test("the seeded session can be re-activated to restore the previous state", async ({
  page,
}) => {
  await openAcademicPeriodsPage(page);

  const seededRow = page.getByRole("row").filter({ hasText: SEEDED_SESSION });
  await seededRow
    .getByRole("button", { name: "Activate", exact: true })
    .click();

  await expect(sessionStatusBadge(seededRow)).toHaveText("Active");
  expect(renamedSessionName).not.toBeNull();
  await expect(
    sessionStatusBadge(page.getByRole("row").filter({ hasText: renamedSessionName! }))
  ).toHaveText("Inactive");
});

test("both supported semesters are listed for editing", async ({ page }) => {
  await openAcademicPeriodsPage(page);

  await expect(
    page.getByRole("row").filter({ hasText: "First Semester" })
  ).toBeVisible();
  await expect(
    page.getByRole("row").filter({ hasText: "Second Semester" })
  ).toBeVisible();
});

test("renaming a semester to an unsupported name is blocked with a clear message", async ({
  page,
}) => {
  await openAcademicPeriodsPage(page);

  const row = page.getByRole("row").filter({ hasText: "Second Semester" });
  await row.getByRole("button", { name: "Edit", exact: true }).click();
  await page
    .getByLabel("Semester name", { exact: true })
    .fill("E2E-AP Not A Semester");
  await page.getByRole("button", { name: "Save", exact: true }).click();

  await expect(
    page.getByText(/must be 'First Semester' or 'Second Semester'/)
  ).toBeVisible();

  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(
    page.getByRole("row").filter({ hasText: "Second Semester" })
  ).toBeVisible();
});

test("saving a semester with a supported name succeeds", async ({ page }) => {
  await openAcademicPeriodsPage(page);

  const row = page.getByRole("row").filter({ hasText: "Second Semester" });
  await row.getByRole("button", { name: "Edit", exact: true }).click();
  await page
    .getByLabel("Semester name", { exact: true })
    .fill("Second Semester");
  await page.getByRole("button", { name: "Save", exact: true }).click();

  await expect(page.getByLabel("Semester name", { exact: true })).toHaveCount(0);
  await expect(
    page.getByRole("row").filter({ hasText: "Second Semester" })
  ).toContainText("Second Semester");
});

test("renaming a semester to the other supported name shows a conflict error", async ({
  page,
}) => {
  await openAcademicPeriodsPage(page);

  const row = page.getByRole("row").filter({ hasText: "Second Semester" });
  await row.getByRole("button", { name: "Edit", exact: true }).click();
  await page
    .getByLabel("Semester name", { exact: true })
    .fill("First Semester");
  await page.getByRole("button", { name: "Save", exact: true }).click();

  await expect(
    page.getByRole("alert").filter({ hasText: /already exists/ })
  ).toBeVisible();

  await page.getByRole("button", { name: "Cancel", exact: true }).click();
});