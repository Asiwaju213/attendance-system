import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
import {
  E2E_ADMIN,
  E2E_LECTURER,
  E2E_STUDENT_TWO,
} from "./constants";
import { withLoginMutex } from "./helpers/login-mutex";

test.describe.configure({ mode: "serial" });

const DEVICE_LABEL_ONE = "E2E Device One";
const DEVICE_LABEL_TWO = "E2E Device Two";

let firstCredentialLabel: string | null = null;

async function loginAsAdmin(page: Page): Promise<void> {
  await withLoginMutex("admin", async () => {
    await page.goto("/staff/admin/login");
    await page.getByLabel("Username").fill(E2E_ADMIN.username);
    await page.getByLabel("Password").fill(E2E_ADMIN.password);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page).toHaveURL(/\/app\/admin$/, { timeout: 15_000 });
  });
}

async function loginAsDeviceStudent(page: Page): Promise<void> {
  await withLoginMutex("student", async () => {
    await page.goto("/login");
    await page.getByLabel("Matric Number").fill(E2E_STUDENT_TWO.matricNumber);
    await page.getByLabel("Password").fill(E2E_STUDENT_TWO.password);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page).toHaveURL(/\/app\/student$/, { timeout: 15_000 });
  });
}

async function openDeviceAdminPage(page: Page): Promise<void> {
  await loginAsAdmin(page);
  await page.goto("/app/admin/student-devices");
  await expect(
    page.getByRole("heading", { level: 1, name: "Student Device Administration" })
  ).toBeVisible();
}

function deviceRow(page: Page): Locator {
  return page
    .locator(".admin-table__row")
    .filter({ hasText: E2E_STUDENT_TWO.matricNumber });
}

async function filterToDeviceStudent(page: Page): Promise<void> {
  await page.getByLabel("Matric Number").fill(E2E_STUDENT_TWO.matricNumber);
  await expect(deviceRow(page)).toBeVisible();
}

/**
 * Attach a Chromium virtual authenticator to the page so the real WebAuthn
 * enrollment ceremony runs against the real backend. Test-only: production
 * code and the cryptographic verification path are untouched.
 */
async function addVirtualAuthenticator(page: Page): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("WebAuthn.enable", { enableUI: false });
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      ctap2Version: "ctap2_1",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
}

async function enrollDeviceViaUi(page: Page, label: string): Promise<void> {
  await page.goto("/app/student/device");
  await expect(
    page.getByRole("heading", { level: 1, name: "Device Enrollment" })
  ).toBeVisible();
  await expect(page.locator(".device-status--none")).toContainText(
    "No Active Device"
  );

  await page.getByLabel("Device Label (optional)").fill(label);
  await page.getByRole("button", { name: "Register This Device" }).click();

  await expect(page.locator(".device-enrolled")).toContainText("Device Active", {
    timeout: 15_000,
  });
  await expect(page.locator(".device-details")).toContainText(label);
}

test("an unauthenticated user is redirected to the admin login page", async ({
  page,
}) => {
  await page.goto("/app/admin/student-devices");

  await expect(page).toHaveURL(/\/staff\/admin\/login$/);
  await expect(
    page.getByRole("heading", { level: 1, name: "Admin Login" })
  ).toBeVisible();
});

test("a student cannot reach the student device admin page", async ({ page }) => {
  await loginAsDeviceStudent(page);

  await page.goto("/app/admin/student-devices");

  await expect(page).toHaveURL(/\/app\/student$/);
  await expect(
    page.getByRole("heading", { level: 1, name: "Student Home" })
  ).toBeVisible();
});

test("a lecturer cannot reach the student device admin page", async ({
  page,
}) => {
  await withLoginMutex("lecturer", async () => {
    await page.goto("/staff/lecturer/login");
    await page.getByLabel("Staff ID").fill(E2E_LECTURER.staffId);
    await page.getByLabel("Password").fill(E2E_LECTURER.password);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page).toHaveURL(/\/app\/lecturer$/, { timeout: 15_000 });
  });

  await page.goto("/app/admin/student-devices");

  await expect(page).toHaveURL(/\/app\/lecturer$/);
  await expect(
    page.getByRole("heading", { level: 1, name: "Lecturer Home" })
  ).toBeVisible();
});

test("an admin sees a filtered student with no device", async ({ page }) => {
  await openDeviceAdminPage(page);
  await filterToDeviceStudent(page);

  await expect(deviceRow(page)).toContainText(E2E_STUDENT_TWO.name);
  await expect(deviceRow(page).locator(".device-status--none")).toBeVisible();
  await expect(
    deviceRow(page).getByRole("button", { name: "Reset Device" })
  ).toHaveCount(0);
});

test("a filter with no matches shows the empty state", async ({ page }) => {
  await openDeviceAdminPage(page);
  await page.getByLabel("Matric Number").fill("E2E/STU/DOES-NOT-EXIST");

  await expect(
    page.getByText("No students match the current filters.")
  ).toBeVisible();
  await expect(page.locator(".admin-table__row")).toHaveCount(0);
});

test("a student can enroll a device through the real WebAuthn ceremony", async ({
  page,
}) => {
  await loginAsDeviceStudent(page);
  await addVirtualAuthenticator(page);
  await enrollDeviceViaUi(page, DEVICE_LABEL_ONE);
});

test("the admin then sees the enrolled device as active", async ({ page }) => {
  await openDeviceAdminPage(page);
  await filterToDeviceStudent(page);

  await expect(deviceRow(page).locator(".device-status--active")).toBeVisible();
  await expect(
    deviceRow(page).getByRole("button", { name: "Reset Device" })
  ).toBeVisible();

  firstCredentialLabel =
    (await deviceRow(page).locator(".credential-id").textContent()) ?? null;
  expect(firstCredentialLabel).not.toBeNull();
});

test("an admin can reset the active device", async ({ page }) => {
  await openDeviceAdminPage(page);
  await filterToDeviceStudent(page);
  await expect(deviceRow(page).locator(".device-status--active")).toBeVisible();

  await deviceRow(page).getByRole("button", { name: "Reset Device" }).click();
  await expect(deviceRow(page).locator(".confirm-message")).toContainText(
    "revoke the student's active device"
  );

  await deviceRow(page)
    .getByRole("button", { name: "Confirm Reset" })
    .click();

  await expect(page.locator(".resource-success")).toContainText(
    "Device has been revoked. The student must enroll a new device."
  );
  await expect(deviceRow(page).locator(".device-status--revoked")).toBeVisible();
  await expect(
    deviceRow(page).getByRole("button", { name: "Reset Device" })
  ).toHaveCount(0);
});

test("a student can enroll a replacement device after the reset", async ({
  page,
}) => {
  await loginAsDeviceStudent(page);
  await addVirtualAuthenticator(page);
  await enrollDeviceViaUi(page, DEVICE_LABEL_TWO);
});

test("the admin sees the replacement device as active again", async ({
  page,
}) => {
  await openDeviceAdminPage(page);
  await filterToDeviceStudent(page);

  await expect(deviceRow(page).locator(".device-status--active")).toBeVisible();

  const replacementCredentialLabel =
    (await deviceRow(page).locator(".credential-id").textContent()) ?? null;
  expect(replacementCredentialLabel).not.toBeNull();
  expect(replacementCredentialLabel).not.toBe(firstCredentialLabel);
});
