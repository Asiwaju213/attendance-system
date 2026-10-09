import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import {
  E2E_STUDENT,
  E2E_STUDENT_NO_COURSES,
  E2E_STUDENT_TWO,
} from "./constants";
import { withLoginMutex } from "./helpers/login-mutex";
import {
  acquireE2E102RegistrationFixturesLock,
  resetE2E102Registrations,
} from "./helpers/attendance-fixture-mutex";

type StoredCookie = { name: string; value: string; domain: string; path: string };

let studentCookies: StoredCookie[] = [];
let studentTwoCookies: StoredCookie[] = [];
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

async function loginAsStudent(
  page: Page,
  student: { matricNumber: string; password: string }
): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("Matric Number").fill(student.matricNumber);
  await page.getByLabel("Password").fill(student.password);
  await withLoginMutex("student", async () => {
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page).toHaveURL(/\/app\/student$/, { timeout: 15_000 });
  });
}

async function captureSessionCookie(page: Page): Promise<StoredCookie> {
  const cookies = await page.context().cookies();
  const session = cookies.find((cookie) => cookie.name === "oou_session");
  if (!session) {
    throw new Error("Expected the session cookie to be set.");
  }
  return {
    name: session.name,
    value: session.value,
    domain: session.domain,
    path: session.path,
  };
}

async function restoreSession(page: Page, cookies: StoredCookie[]): Promise<void> {
  await page.context().addCookies(cookies);
}

function courseSection(page: Page, courseCode: string) {
  return page.locator("section.app-card").filter({ hasText: courseCode });
}

test.describe.configure({ mode: "serial" });

test.describe("Student Course Registration", () => {
  test("unauthenticated visitors are redirected to the student login page", async ({
    page,
  }) => {
    await page.goto("/app/student/registration");
    await expect(page).toHaveURL(/\/login$/);
    await expect(
      page.getByRole("heading", { level: 1, name: "Course registration" })
    ).toHaveCount(0);
  });

  test("student home links to course registration and back", async ({ page }) => {
    await loginAsStudent(page, E2E_STUDENT);
    studentCookies = [await captureSessionCookie(page)];

    await page.getByRole("link", { name: "Course registration" }).click();
    await expect(page).toHaveURL(/\/app\/student\/registration$/);
    await expect(
      page.getByRole("heading", { level: 1, name: "Course registration" })
    ).toBeVisible();

    await page.getByRole("link", { name: "Home" }).click();
    await expect(page).toHaveURL(/\/app\/student$/);
  });

  test("the page loads eligible courses with the active academic session", async ({
    page,
  }) => {
    await restoreSession(page, studentCookies);
    await page.goto("/app/student/registration");

    await expect(
      page.getByRole("heading", { level: 1, name: "Course registration" })
    ).toBeVisible();
    await expect(page.getByText("E2E-2026/2027")).toBeVisible();

    for (const courseCode of ["E2E-101", "E2E-102", "E2E-103"]) {
      await expect(
        page.getByRole("heading", { level: 2, name: new RegExp(courseCode) })
      ).toBeVisible();
    }
  });

  test("course metadata is displayed", async ({ page }) => {
    await restoreSession(page, studentCookies);
    await page.goto("/app/student/registration");

    const courseThree = courseSection(page, "E2E-103");
    await expect(
      courseThree.getByRole("heading", { level: 2 })
    ).toContainText("E2E Computer Science 103");
    await expect(courseThree.getByText("Level 100")).toBeVisible();
    await expect(courseThree.getByText("First Semester")).toBeVisible();
    await expect(courseThree.getByText("E2E Test Department")).toBeVisible();
    await expect(courseThree.getByText("E2E Lecturer")).toBeVisible();
  });

  test("eligible courses offer an enrollment action while enrolled ones show ENROLLED", async ({
    page,
  }) => {
    await restoreSession(page, studentCookies);
    await page.goto("/app/student/registration");

    await expect(courseSection(page, "E2E-101").getByText("Enrolled")).toBeVisible();
    await expect(
      courseSection(page, "E2E-101").getByRole("button", { name: "Enroll" })
    ).toHaveCount(0);

    await expect(courseSection(page, "E2E-102").getByRole("button", { name: "Enroll" })).toBeVisible();
    await expect(courseSection(page, "E2E-102").getByText("Enrolled")).toHaveCount(0);

    await expect(courseSection(page, "E2E-103").getByText("Enrolled")).toBeVisible();
    await expect(
      courseSection(page, "E2E-103").getByRole("button", { name: "Enroll" })
    ).toHaveCount(0);
  });

  test("course registrations are isolated per student", async ({ page }) => {
    await loginAsStudent(page, E2E_STUDENT_TWO);
    studentTwoCookies = [await captureSessionCookie(page)];
    await page.goto("/app/student/registration");

    // E2E/STU/0001 is enrolled in E2E-101, but E2E/STU/0002 must not see it.
    await expect(
      courseSection(page, "E2E-101").getByRole("button", { name: "Enroll" })
    ).toBeVisible();
    await expect(courseSection(page, "E2E-101").getByText("Enrolled")).toHaveCount(0);

    // E2E/STU/0002 is enrolled in E2E-103.
    await expect(courseSection(page, "E2E-103").getByText("Enrolled")).toBeVisible();

    // E2E-102 remains eligible for E2E/STU/0002.
    await expect(
      courseSection(page, "E2E-102").getByRole("button", { name: "Enroll" })
    ).toBeVisible();
  });

  test("a failed enrollment shows a clean error without losing the list", async ({
    page,
  }) => {
    await restoreSession(page, studentCookies);

    await page.route("**/api/student/registration/courses", async (route) => {
      if (route.request().method() === "POST") {
        await route.fulfill({
          status: 409,
          contentType: "application/json",
          body: JSON.stringify({
            error: "INVALID_COURSE_SELECTION",
            message: "One or more selected courses are not available for registration.",
          }),
        });
      } else {
        await route.continue();
      }
    });

    await page.goto("/app/student/registration");

    const courseTwo = courseSection(page, "E2E-102");
    await courseTwo.getByRole("button", { name: "Enroll" }).click();

    await expect(courseTwo.getByRole("alert")).toContainText(
      "no longer available",
      { timeout: 10_000 }
    );

    // The rest of the list and previously enrolled state are preserved.
    await expect(courseSection(page, "E2E-103").getByText("Enrolled")).toBeVisible();
    await expect(courseSection(page, "E2E-101").getByText("Enrolled")).toBeVisible();
    await expect(courseTwo.getByRole("button", { name: "Enroll" })).toBeEnabled();
  });

  test("enrolling applies immediately and persists across a full reload", async ({
    page,
  }) => {
    await restoreSession(page, studentCookies);
    await page.goto("/app/student/registration");

    const courseTwo = courseSection(page, "E2E-102");
    await courseTwo.getByRole("button", { name: "Enroll" }).click();
    await expect(courseTwo.getByText("Enrolled")).toBeVisible({ timeout: 10_000 });
    await expect(courseTwo.getByRole("button", { name: "Enroll" })).toHaveCount(0);

    await page.reload();
    const reloadedCourseTwo = courseSection(page, "E2E-102");
    await expect(reloadedCourseTwo.getByText("Enrolled")).toBeVisible();
    await expect(reloadedCourseTwo.getByRole("button", { name: "Enroll" })).toHaveCount(0);
  });

  test("the enrollment action cannot be double submitted while pending", async ({
    page,
  }) => {
    await restoreSession(page, studentTwoCookies);

    let releaseRequest: () => void = () => {};
    const inFlight = new Promise<void>((resolve) => {
      releaseRequest = resolve;
    });
    let postsSeen = 0;

    await page.route("**/api/student/registration/courses", async (route) => {
      if (route.request().method() === "POST") {
        postsSeen += 1;
        await inFlight;
      }
      await route.continue();
    });

    await page.goto("/app/student/registration");

    // E2E-102 is the dedicated enrollment fixture; E2E-101's roster stays
    // exactly E2E/STU/0001 so the admin/lecturer report fixtures stay stable.
    const courseTwo = courseSection(page, "E2E-102");
    await courseTwo.getByRole("button", { name: "Enroll" }).click();

    const busyButton = courseTwo.getByRole("button", { name: "Enrolling…" });
    await expect(busyButton).toBeDisabled();
    await expect(busyButton).toHaveAttribute("aria-busy", "true");
    await expect(
      courseTwo.getByRole("button", { name: "Enroll", exact: true })
    ).toHaveCount(0);

    releaseRequest();
    await expect(courseTwo.getByText("Enrolled")).toBeVisible({ timeout: 10_000 });

    expect(postsSeen).toBe(1);
  });

  test("a student with no eligible courses sees the empty state", async ({
    page,
  }) => {
    await loginAsStudent(page, E2E_STUDENT_NO_COURSES);
    await page.goto("/app/student/registration");

    await expect(page.getByRole("status")).toContainText(
      "No courses are currently available for registration."
    );
    await expect(
      page.getByRole("heading", { level: 2, name: new RegExp("E2E-1") })
    ).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Enroll" })).toHaveCount(0);
  });

  test("mobile layout has no horizontal overflow", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 });
    await restoreSession(page, studentCookies);
    await page.goto("/app/student/registration");

    await expect(courseSection(page, "E2E-101")).toBeVisible();

    const overflow = await page.evaluate(() => {
      const element = document.documentElement;
      return { scrollWidth: element.scrollWidth, clientWidth: element.clientWidth };
    });
    expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth);
  });

  test("enrollment state is never stored in browser storage", async ({ page }) => {
    await restoreSession(page, studentCookies);
    await page.goto("/app/student/registration");

    await expect(courseSection(page, "E2E-101")).toBeVisible();

    const storageDump = () =>
      page.evaluate(() =>
        JSON.stringify({
          local: { ...localStorage },
          session: { ...sessionStorage },
        })
      );

    expect(await storageDump()).not.toContain("offeringIds");
    expect(await storageDump()).not.toContain("isRegistered");
    expect(await storageDump()).not.toContain("E2E-102");
  });

  test("the page separates available courses from my courses", async ({
    page,
  }) => {
    // Serial state: E2E/STU/0001 is enrolled in E2E-101, E2E-102, and E2E-103,
    // while any other eligible course (e.g. one created by the admin course
    // management spec) remains available.
    await restoreSession(page, studentCookies);
    await page.goto("/app/student/registration");

    await expect(
      page.getByRole("heading", { level: 2, name: "Available courses" })
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { level: 2, name: "My courses" })
    ).toBeVisible();

    // Enrolled seed courses appear exactly once each (in My Courses), show the
    // Enrolled badge, and offer no enrollment action · they are not duplicated
    // in the available list.
    for (const courseCode of ["E2E-101", "E2E-102", "E2E-103"]) {
      const section = courseSection(page, courseCode);
      await expect(section).toHaveCount(1);
      await expect(section.getByText("Enrolled")).toBeVisible();
      await expect(
        section.getByRole("button", { name: "Enroll" })
      ).toHaveCount(0);
    }

    // Exactly the three seed courses are marked Enrolled, and none of those
    // cards also offers an Enroll action.
    const enrolledCards = page
      .locator("section.app-card")
      .filter({ hasText: "Enrolled" });
    await expect(enrolledCards).toHaveCount(3);
    await expect(
      enrolledCards.getByRole("button", { name: "Enroll" })
    ).toHaveCount(0);

    // The active session is shown exactly once · in the page header · and is
    // not duplicated inside the enrolled course cards.
    await expect(page.getByText("E2E-2026/2027")).toHaveCount(1);
  });

  test("my courses is reachable at the /app/student/courses route", async ({
    page,
  }) => {
    await restoreSession(page, studentCookies);
    await page.goto("/app/student/courses");

    await expect(
      page.getByRole("heading", { level: 1, name: "Course registration" })
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { level: 2, name: "My courses" })
    ).toBeVisible();
    await expect(courseSection(page, "E2E-101")).toBeVisible();
  });
});