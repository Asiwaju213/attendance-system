import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
import {
  E2E_ADMIN,
  E2E_IMPORT_DEPARTMENT,
  E2E_IMPORT_STUDENTS,
  E2E_LECTURER,
  E2E_STUDENT,
  E2E_STUDENT_ACTIVE_MANAGEMENT,
} from "./constants";
import { withLoginMutex } from "./helpers/login-mutex";
import {
  buildStudentImportWorkbook,
  IMPORT_TEMPLATE_HEADERS,
  IMPORT_TEMPLATE_SHEET,
  readImportWorkbook,
} from "./helpers/student-import-workbook";

test.describe.configure({ mode: "serial" });

const MULTIPART_XLSX =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

const activeManagementMatric = E2E_STUDENT_ACTIVE_MANAGEMENT.matricNumber;

async function loginAsAdmin(page: Page): Promise<void> {
  await page.goto("/staff/admin/login");
  await page.getByLabel("Username").fill(E2E_ADMIN.username);
  await page.getByLabel("Password").fill(E2E_ADMIN.password);
  await withLoginMutex("admin", async () => {
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page).toHaveURL(/\/app\/admin$/, { timeout: 15_000 });
  });
}

async function openImportPage(page: Page): Promise<void> {
  await loginAsAdmin(page);
  await page.goto("/app/admin/students/import");
  await expect(
    page.getByRole("heading", { level: 1, name: "Student import" })
  ).toBeVisible();
}

function fileInput(page: Page): Locator {
  return page.locator('input[type="file"]');
}

function setWorkbook(
  page: Page,
  buffer: Buffer,
  name = "students.xlsx"
): Promise<void> {
  return fileInput(page).setInputFiles({ name, mimeType: MULTIPART_XLSX, buffer });
}

async function chooseImportTarget(page: Page): Promise<void> {
  await page.getByLabel("Department").selectOption({
    label: E2E_IMPORT_DEPARTMENT.label,
  });
  await page.getByLabel("Level").selectOption({ label: "Level 100" });
}

async function previewFile(page: Page, buffer: Buffer, name = "students.xlsx"): Promise<void> {
  await chooseImportTarget(page);
  await setWorkbook(page, buffer, name);
  await page.getByRole("button", { name: "Preview import" }).click();
}

function importSummaryStat(page: Page, label: string): Locator {
  return page.locator(".import-summary__stat").filter({ hasText: label });
}

async function countStudentsMatching(
  page: Page,
  matricNumber: string
): Promise<number> {
  const response = await page.request.get(
    `/api/admin/students?matricNumber=${encodeURIComponent(matricNumber)}`
  );
  expect(response.ok()).toBeTruthy();
  const payload = (await response.json()) as {
    data: { items: unknown[] };
  };
  return payload.data.items.length;
}

async function bufferFromDownload(
  download: {
    suggestedFilename(): string;
    createReadStream(): Promise<NodeJS.ReadableStream>;
  }
): Promise<Buffer> {
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

test("an unauthenticated user is redirected to the admin login page", async ({ page }) => {
  await page.goto("/app/admin/students/import");

  await expect(page).toHaveURL(/\/staff\/admin\/login$/);
  await expect(
    page.getByRole("heading", { level: 1, name: "Administrator Login" })
  ).toBeVisible();
});

test("a student cannot reach the student import page", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("Matric Number").fill(E2E_STUDENT.matricNumber);
  await page.getByLabel("Password").fill(E2E_STUDENT.password);
  await withLoginMutex("student", async () => {
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page).toHaveURL(/\/app\/student$/, { timeout: 15_000 });
  });

  await page.goto("/app/admin/students/import");

  await expect(page).toHaveURL(/\/app\/student$/);
  await expect(
    page.getByRole("heading", { level: 1, name: "Student Home" })
  ).toBeVisible();
});

test("a lecturer cannot reach the student import page", async ({ page }) => {
  await page.goto("/staff/lecturer/login");
  await page.getByLabel("Staff ID").fill(E2E_LECTURER.staffId);
  await page.getByLabel("Password").fill(E2E_LECTURER.password);
  await withLoginMutex("lecturer", async () => {
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page).toHaveURL(/\/app\/lecturer$/, { timeout: 15_000 });
  });

  await page.goto("/app/admin/students/import");

  await expect(page).toHaveURL(/\/app\/lecturer$/);
  await expect(
    page.getByRole("heading", { level: 1, name: "Lecturer Home" })
  ).toBeVisible();
});

test("the admin home links to student import and the page renders", async ({
  page,
}) => {
  await loginAsAdmin(page);

  const link = page.getByRole("link", { name: "Student import" });
  await expect(link).toBeVisible();
  await expect(link).toHaveAttribute("href", "/app/admin/students/import");

  await link.click();

  await expect(page).toHaveURL(/\/app\/admin\/students\/import$/);
  await expect(
    page.getByRole("heading", { level: 1, name: "Student import" })
  ).toBeVisible();
  await expect(
    page.getByText("Create student accounts in bulk from a workbook.")
  ).toBeVisible();
  await expect(page.getByText("Back to Admin Home")).toBeVisible();
  await expect(page.getByRole("button", { name: "Download template" })).toBeVisible();
  await expect(page.getByLabel("Department")).toBeVisible();
  await expect(page.getByLabel("Level")).toBeVisible();
  await expect(page.getByRole("button", { name: "Choose .xlsx file" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Preview import" })).toBeVisible();
});

test("the template download yields a valid student-import workbook", async ({
  page,
}) => {
  await openImportPage(page);

  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download template" }).click();
  const download = await downloadPromise;

  expect(download.suggestedFilename()).toBe("students-import-template.xlsx");

  const buffer = await bufferFromDownload(download);
  expect(buffer.length).toBeGreaterThan(0);

  const parsed = await readImportWorkbook(buffer);
  expect(parsed.sheetName).toBe(IMPORT_TEMPLATE_SHEET);
  expect(parsed.headers).toEqual(IMPORT_TEMPLATE_HEADERS);
  expect(parsed.rowCount).toBe(1);
});

test("the department, level, and file are required before previewing", async ({
  page,
}) => {
  await openImportPage(page);

  await page.getByRole("button", { name: "Preview import" }).click();
  await expect(
    page.getByText("Select a department to import into.")
  ).toBeVisible();

  await chooseImportTarget(page);
  await page.getByRole("button", { name: "Preview import" }).click();
  await expect(page.getByText("Select a level for the imported students.")).toHaveCount(0);
  await expect(page.getByText("Choose a .xlsx workbook to import.")).toBeVisible();
});

test("an unsupported file extension is rejected with obvious feedback", async ({
  page,
}) => {
  await openImportPage(page);

  await chooseImportTarget(page);
  await fileInput(page).setInputFiles({
    name: "students.csv",
    mimeType: "text/csv",
    buffer: Buffer.from("Student Name,Matric Number\nAda,E2E/IMP/0999\n"),
  });

  await expect(
    page.getByText("Choose a .xlsx workbook. Files saved in other formats cannot be imported.")
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Choose .xlsx file" })).toBeVisible();
});

test("an oversized workbook shows the backend upload limit message", async ({
  page,
}) => {
  await openImportPage(page);

  const oversized = Buffer.alloc(10 * 1024 * 1024 + 1, 0);
  await previewFile(page, oversized, "oversized.xlsx");

  await expect(page.getByText("The uploaded file exceeds the 10 MB limit.")).toBeVisible();
  await expect(importSummaryStat(page, "Total rows")).toHaveCount(0);
});

test("an unreadable workbook shows the backend invalid-file message", async ({
  page,
}) => {
  await openImportPage(page);

  await previewFile(page, Buffer.from("this is definitely not an xlsx file"));

  await expect(
    page.getByText("The uploaded file could not be read as an .xlsx workbook.")
  ).toBeVisible();
});

test("a network failure while previewing shows a friendly message", async ({
  page,
}) => {
  await openImportPage(page);

  await page.route("**/api/admin/students/import/preview", (route) =>
    route.abort("internetdisconnected")
  );

  const buffer = await buildStudentImportWorkbook([
    ["Ada Import", "E2E/IMP/0001"],
  ]);
  await previewFile(page, buffer);

  await expect(
    page.getByText("Unable to reach the server. Check your connection and try again.")
  ).toBeVisible();
});

test("a preview server error shows a friendly message and retry recovers", async ({
  page,
}) => {
  await openImportPage(page);

  await page.route("**/api/admin/students/import/preview", (route) =>
    route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({
        error: "INTERNAL_ERROR",
        message: "An internal error occurred.",
      }),
    })
  );

  const buffer = await buildStudentImportWorkbook([
    ["Ada Import", "E2E/IMP/0001"],
  ]);
  await previewFile(page, buffer);

  await expect(page.getByText("An internal error occurred.")).toBeVisible();

  await page.unroute("**/api/admin/students/import/preview");
  await page.getByRole("button", { name: "Retry" }).click();

  await expect(importSummaryStat(page, "Total rows")).toBeVisible();
  await expect(importSummaryStat(page, "Total rows")).toContainText("1");
});

test("a valid workbook is previewed and previewing creates no records", async ({
  page,
}) => {
  await openImportPage(page);

  for (const student of E2E_IMPORT_STUDENTS) {
    expect(await countStudentsMatching(page, student.matricNumber)).toBe(0);
  }

  const buffer = await buildStudentImportWorkbook(
    E2E_IMPORT_STUDENTS.map((student) => [student.name, student.matricNumber])
  );
  await previewFile(page, buffer);

  await expect(importSummaryStat(page, "Total rows")).toContainText("3");
  await expect(importSummaryStat(page, "Ready to import")).toContainText("3");
  await expect(importSummaryStat(page, "Need attention")).toContainText("0");
  await expect(page.locator(".admin-table__row")).toHaveCount(3);

  for (const student of E2E_IMPORT_STUDENTS) {
    const row = page
      .locator(".admin-table__row")
      .filter({ hasText: student.matricNumber });
    await expect(row).toContainText(student.name);
    await expect(row.locator(".import-row-valid")).toBeVisible();
  }

  for (const student of E2E_IMPORT_STUDENTS) {
    expect(await countStudentsMatching(page, student.matricNumber)).toBe(0);
  }
});

test("invalid rows are flagged with their reasons and confirmation is unavailable", async ({
  page,
}) => {
  await openImportPage(page);

  const buffer = await buildStudentImportWorkbook([
    ["Good Import", "E2E/IMP/0401"],
    ["", "E2E/IMP/0402"],
    ["Missing Matric", ""],
    ["Dup Name", "E2E/IMP/0401"],
  ]);
  await previewFile(page, buffer);

  await expect(importSummaryStat(page, "Total rows")).toContainText("4");
  await expect(importSummaryStat(page, "Ready to import")).toContainText("1");
  await expect(importSummaryStat(page, "Need attention")).toContainText("3");

  const missingNameRow = page
    .locator(".admin-table__row")
    .filter({ hasText: "E2E/IMP/0402" });
  await expect(missingNameRow.locator(".import-row-invalid")).toBeVisible();
  await expect(missingNameRow.getByText("missing student name")).toBeVisible();

  const missingMatricRow = page
    .locator(".admin-table__row")
    .filter({ hasText: "Missing Matric" });
  await expect(missingMatricRow.locator(".import-row-invalid")).toBeVisible();
  await expect(missingMatricRow.getByText("missing matric number")).toBeVisible();

  const duplicateRow = page
    .locator(".admin-table__row")
    .filter({ hasText: "Dup Name" });
  await expect(duplicateRow.locator(".import-row-invalid")).toBeVisible();
  await expect(
    duplicateRow.getByText("duplicate matric number in file")
  ).toBeVisible();

  await expect(
    page.getByText("Fix the 3 rows marked in the workbook")
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Confirm import" })).toHaveCount(0);
});

test("a matric number that already exists is reported on its row", async ({
  page,
}) => {
  await openImportPage(page);

  const buffer = await buildStudentImportWorkbook([
    ["Existing Person", activeManagementMatric],
  ]);
  await previewFile(page, buffer);

  const row = page
    .locator(".admin-table__row")
    .filter({ hasText: activeManagementMatric });
  await expect(row.locator(".import-row-invalid")).toBeVisible();
  await expect(row.getByText("matric number already exists")).toBeVisible();
  await expect(importSummaryStat(page, "Need attention")).toContainText("1");
  await expect(page.getByRole("button", { name: "Confirm import" })).toHaveCount(0);
});

test("confirming a valid preview imports every row and cannot double-submit", async ({
  page,
}) => {
  await loginAsAdmin(page);

  const buffer = await buildStudentImportWorkbook(
    E2E_IMPORT_STUDENTS.map((student) => [student.name, student.matricNumber])
  );
  await page.goto("/app/admin/students/import");
  await chooseImportTarget(page);
  await setWorkbook(page, buffer);
  await page.getByRole("button", { name: "Preview import" }).click();
  await expect(importSummaryStat(page, "Ready to import")).toContainText("3");
  await expect(
    page.getByText(/Importing 3 students into E2E Test Department at Level 100/)
  ).toBeVisible();

  await page.route("**/api/admin/students/import", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    await route.continue();
  });

  const confirmButton = page.locator(".confirm-actions button.auth-submit");
  await confirmButton.click();
  await expect(confirmButton).toBeDisabled();
  await expect(confirmButton).toHaveText("Importing…");

  await expect(
    page.getByText("3 students imported successfully.")
  ).toBeVisible({ timeout: 15_000 });

  await expect(
    page.getByRole("button", { name: "Confirm import" })
  ).toHaveCount(0);
  await expect(page.getByText("Import another file")).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Return to student management" })
  ).toBeVisible();
});

test("a consumed or expired preview token surfaces as a friendly error", async ({
  page,
}) => {
  await openImportPage(page);

  const buffer = await buildStudentImportWorkbook([
    ["Rita Import", "E2E/IMP/0201"],
    ["Sola Import", "E2E/IMP/0202"],
  ]);
  await previewFile(page, buffer);
  await expect(importSummaryStat(page, "Ready to import")).toContainText("2");

  await page.route("**/api/admin/students/import", (route) =>
    route.fulfill({
      status: 404,
      contentType: "application/json",
      body: JSON.stringify({
        error: "PREVIEW_NOT_FOUND",
        message: "The preview is invalid, expired, or already used.",
      }),
    })
  );

  await page.getByRole("button", { name: "Confirm import" }).click();

  await expect(
    page.getByText("The preview is invalid, expired, or already used.")
  ).toBeVisible();

  await page.unroute("**/api/admin/students/import");

  for (const matric of ["E2E/IMP/0201", "E2E/IMP/0202"]) {
    expect(await countStudentsMatching(page, matric)).toBe(0);
  }
});

test("imported students appear in student management as PENDING", async ({
  page,
}) => {
  await openImportPage(page);
  await page.goto("/app/admin/students");

  for (const student of E2E_IMPORT_STUDENTS) {
    const row = page
      .locator(".admin-table__row")
      .filter({ hasText: student.matricNumber });
    await expect(row).toBeVisible();
    await expect(row).toContainText(student.name);
    await expect(row).toContainText("E2E Test Department");
    await expect(row).toContainText("Level 100");
    await expect(row.locator(".student-status").first()).toHaveText("PENDING");
  }
});

test("import another file resets the flow and the return link navigates to management", async ({
  page,
}) => {
  await openImportPage(page);
  await chooseImportTarget(page);

  const departmentValue = await page.getByLabel("Department").inputValue();
  const levelValue = await page.getByLabel("Level").inputValue();

  const buffer = await buildStudentImportWorkbook([
    ["Fresh Import", "E2E/IMP/0501"],
    ["Second Fresh", "E2E/IMP/0502"],
  ]);
  await setWorkbook(page, buffer);
  await page.getByRole("button", { name: "Preview import" }).click();
  await expect(importSummaryStat(page, "Total rows")).toContainText("2");

  await page.getByRole("button", { name: "Confirm import" }).click();
  await expect(
    page.getByText("2 students imported successfully.")
  ).toBeVisible({ timeout: 15_000 });

  await page.getByRole("button", { name: "Import another file" }).click();

  await expect(page.getByText("Import complete")).toHaveCount(0);
  await expect(importSummaryStat(page, "Total rows")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Choose .xlsx file" })).toBeVisible();
  await expect(page.getByLabel("Department")).toHaveValue(departmentValue);
  await expect(page.getByLabel("Level")).toHaveValue(levelValue);

  const freshBuffer = await buildStudentImportWorkbook([
    ["Third Fresh", "E2E/IMP/0503"],
  ]);
  await setWorkbook(page, freshBuffer, "second.xlsx");
  await page.getByRole("button", { name: "Preview import" }).click();
  await expect(importSummaryStat(page, "Total rows")).toContainText("1");

  await page.getByRole("button", { name: "Confirm import" }).click();
  await expect(
    page.getByText("1 student imported successfully.")
  ).toBeVisible({ timeout: 15_000 });

  await page.getByRole("link", { name: "Return to student management" }).click();
  await expect(page).toHaveURL(/\/app\/admin\/students$/);
  await expect(
    page.getByRole("heading", { level: 1, name: "Student management" })
  ).toBeVisible();
});