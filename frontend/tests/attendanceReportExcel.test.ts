import { test } from "node:test";
import assert from "node:assert/strict";
import {
  attendanceReportFilename,
  buildAttendanceReportWorkbook,
} from "../src/lib/attendanceReportExcel";
import type { CourseOfferingAttendanceReport } from "../src/types/attendance";

function sampleReport(
  overrides?: Partial<CourseOfferingAttendanceReport["courseOffering"]>
): CourseOfferingAttendanceReport {
  return {
    courseOffering: {
      id: 7,
      courseId: 1,
      courseCode: "CSC401",
      courseTitle: "Compiler Construction",
      academicSessionId: 2,
      academicSessionName: "2025/2026",
      semesterId: 1,
      semesterName: "Second Semester",
      levelId: 400,
      levelName: 400,
      lecturers: [
        { id: 1, userId: 10, staffId: "STF/001", name: "Ada Obi" },
        { id: 2, userId: 11, staffId: "STF/002", name: "Ben Musa" },
      ],
      totalCompletedSessions: 4,
      ...overrides,
    },
    students: [
      {
        studentId: 1,
        userId: 20,
        matricNumber: "19/52HA001",
        studentName: "Student Alpha",
        totalCompletedSessions: 4,
        presentCount: 3,
        lateCount: 1,
        absentCount: 0,
        attendancePercentage: 100,
      },
      {
        studentId: 2,
        userId: 21,
        matricNumber: "19/52HA002",
        studentName: "Student Beta",
        totalCompletedSessions: 4,
        presentCount: 1,
        lateCount: 0,
        absentCount: 3,
        attendancePercentage: 25,
      },
      {
        studentId: 3,
        userId: 22,
        matricNumber: "19/52HA003",
        studentName: "Student Gamma",
        totalCompletedSessions: 4,
        presentCount: 0,
        lateCount: 0,
        absentCount: 4,
        attendancePercentage: null,
      },
    ],
  };
}

test("generates a workbook successfully with a single worksheet", () => {
  const workbook = buildAttendanceReportWorkbook(sampleReport());
  assert.ok(workbook);
  assert.equal(workbook.worksheets.length, 1);
});

test("the worksheet is named Attendance Report", () => {
  const workbook = buildAttendanceReportWorkbook(sampleReport());
  assert.equal(workbook.worksheets[0].name, "Attendance Report");
});

test("report metadata appears in the header", () => {
  const sheet = buildAttendanceReportWorkbook(sampleReport()).worksheets[0];
  assert.equal(sheet.getCell(1, 1).value, "Course Code");
  assert.equal(sheet.getCell(1, 2).value, "CSC401");
  assert.equal(sheet.getCell(2, 1).value, "Course Title");
  assert.equal(sheet.getCell(2, 2).value, "Compiler Construction");
  assert.equal(sheet.getCell(3, 1).value, "Academic Session");
  assert.equal(sheet.getCell(3, 2).value, "2025/2026");
  assert.equal(sheet.getCell(4, 1).value, "Semester");
  assert.equal(sheet.getCell(4, 2).value, "Second Semester");
  assert.equal(sheet.getCell(5, 1).value, "Level");
  assert.equal(sheet.getCell(5, 2).value, "Level 400");
  assert.equal(sheet.getCell(7, 1).value, "Completed Sessions");
  assert.equal(sheet.getCell(7, 2).value, 4);
});

test("student rows appear below the table header", () => {
  const sheet = buildAttendanceReportWorkbook(sampleReport()).worksheets[0];
  assert.equal(sheet.getCell(9, 1).value, "Student");
  assert.equal(sheet.getCell(9, 6).value, "Absent");
  assert.equal(sheet.getCell(10, 1).value, "Student Alpha");
  assert.equal(sheet.getCell(11, 1).value, "Student Beta");
  assert.equal(sheet.getCell(12, 1).value, "Student Gamma");
  assert.equal(sheet.getCell(12, 2).value, "19/52HA003");
});

test("PRESENT, LATE and ABSENT values are preserved as numbers", () => {
  const sheet = buildAttendanceReportWorkbook(sampleReport()).worksheets[0];
  assert.equal(sheet.getCell(10, 3).value, 4);
  assert.equal(sheet.getCell(10, 4).value, 3);
  assert.equal(sheet.getCell(10, 5).value, 1);
  assert.equal(sheet.getCell(10, 6).value, 0);
  assert.equal(sheet.getCell(11, 4).value, 1);
  assert.equal(sheet.getCell(11, 5).value, 0);
  assert.equal(sheet.getCell(11, 6).value, 3);
});

test("attendance percentage is preserved as the API value", () => {
  const sheet = buildAttendanceReportWorkbook(sampleReport()).worksheets[0];
  assert.equal(sheet.getCell(10, 7).value, 100);
  assert.equal(sheet.getCell(11, 7).value, 25);
});

test("a null percentage leaves the cell blank", () => {
  const sheet = buildAttendanceReportWorkbook(sampleReport()).worksheets[0];
  const cell = sheet.getCell(12, 7);
  assert.equal(cell.value, null);
});

test("multiple lecturers are represented in the Lecturer(s) cell", () => {
  const sheet = buildAttendanceReportWorkbook(sampleReport()).worksheets[0];
  assert.equal(
    sheet.getCell(6, 2).value,
    "Ada Obi (STF/001), Ben Musa (STF/002)"
  );
});

test("the report header row is frozen", () => {
  const sheet = buildAttendanceReportWorkbook(sampleReport()).worksheets[0];
  assert.equal(sheet.views.length, 1);
  assert.equal(sheet.views[0].state, "frozen");
  assert.equal(sheet.views[0].ySplit, 9);
});

test("filename follows the course and academic period pattern", () => {
  assert.equal(
    attendanceReportFilename(sampleReport()),
    "CSC401-2025-2026-Second-Semester-Attendance.xlsx"
  );
});

test("filename sanitizes reserved characters from every part", () => {
  const report = sampleReport({
    courseCode: "E2E 101 /x",
    academicSessionName: "2025/2026",
    semesterName: "  First  Semester!! ",
  });
  assert.equal(
    attendanceReportFilename(report),
    "E2E-101-x-2025-2026-First-Semester-Attendance.xlsx"
  );
});

test("filename falls back when every part sanitizes to empty", () => {
  const report = sampleReport({
    courseCode: "///",
    academicSessionName: "...",
    semesterName: "   ",
  });
  assert.equal(attendanceReportFilename(report), "course-attendance-Attendance.xlsx");
});

test("the workbook can be serialized to an xlsx buffer", async () => {
  const workbook = buildAttendanceReportWorkbook(sampleReport());
  const buffer = await workbook.xlsx.writeBuffer();
  assert.ok(buffer);
  assert.ok(buffer instanceof Uint8Array || buffer instanceof ArrayBuffer);
});