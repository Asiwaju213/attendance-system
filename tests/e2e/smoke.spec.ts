import { test, expect } from "@playwright/test";

test("frontend loads with a meaningful title and visible content", async ({
  page,
}) => {
  await page.goto("/login");

  await expect(page).toHaveTitle("OOU Attendance System");

  const heading = page.getByRole("heading", { level: 1 });
  await expect(heading).toBeVisible();
  await expect(heading).toHaveText("Student Login");
});