import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildLecturerSemesterAttendanceWorkbook,
  buildLecturerSessionAttendanceWorkbook,
  lecturerSemesterAttendanceFilename,
  lecturerSessionAttendanceFilename,
} from "../src/lib/lecturerAttendanceExcel";
import type {
  LecturerAttendanceReport,
  LecturerSessionAttendanceReport,
} from "../src/types/attendance";

function sessionDetail(
  sessionId: number,
  day: string,
  status: "PRESENT" | "LATE" | "ABSENT",
  markedAt: string | null
) {
  return {
    sessionId,
    startTime: `2026-02-${day}T09:00:00.000Z`,
    endTime: `2026-02-${day}T10:30:00.000Z`,
    lecturerName: "Ada Obi",
    locationName: "LT1",
    attendanceNetworkName: "HallNet",
    status,
    markedAt,
  };
}

function sessionReport(
  overrides?: Partial<LecturerSessionAttendanceReport["session"]>
): LecturerSessionAttendanceReport {
  return {
    session: {
      sessionId: 42,
      courseCode: "CSC401",
      courseTitle: "Compiler Construction",
      academicSession: "2025/2026",
      semester: "Second Semester",
      level: 400,
      attendanceNetworkName: "HallNet",
      locationName: "LT1",
      startTime: "2026-02-10T09:00:00.000Z",
      endTime: "2026-02-10T10:30:00.000Z",
      lateThresholdMinutes: 5,
      endedAt: "2026-02-10T10:45:00.000Z",
      startedByLecturer: { id: 1, staffId: "STF/001", name: "Ada Obi" },
      ...overrides,
    },
    students: [
      {
        studentId: 1,
        matricNumber: "19/52HA001",
        studentName: "Student Alpha",
        status: "PRESENT",
        markedAt: "2026-02-10T09:10:00.000Z",
      },
      {
        studentId: 2,
        matricNumber: "19/52HA002",
        studentName: "Student Beta",
        status: "LATE",
        markedAt: "2026-02-10T09:40:00.000Z",
      },
      {
        studentId: 3,
        matricNumber: "19/52HA003",
        studentName: "Student Gamma",
        status: "ABSENT",
        markedAt: null,
      },
    ],
  };
}

function semesterReport(
  overrides?: Partial<LecturerAttendanceReport["courseOffering"]>
): LecturerAttendanceReport {
  return {
    courseOffering: {
      courseOfferingId: 7,
      courseId: 1,
      courseCode: "CSC401",
      courseTitle: "Compiler Construction",
      academicSession: "2025/2026",
      semester: "Second Semester",
      level: 400,
      lecturer: { id: 1, staffId: "STF/001", name: "Ada Obi" },
      totalCompletedSessions: 2,
      ...overrides,
    },
    students: [
      {
        studentId: 1,
        matricNumber: "19/52HA001",
        studentName: "Student Alpha",
        totalCompletedSessions: 2,
        presentCount: 2,
        lateCount: 0,
        absentCount: 0,
        attendancePercentage: 100,
        sessions: [
          sessionDetail(9001, "10", "PRESENT", "2026-02-10T09:10:00.000Z"),
          sessionDetail(9002, "12", "PRESENT", "2026-02-12T09:05:00.000Z"),
        ],
      },
      {
        studentId: 2,
        matricNumber: "19/52HA002",
        studentName: "Student Beta",
        totalCompletedSessions: 2,
        presentCount: 0,
        lateCount: 1,
        absentCount: 1,
        attendancePercentage: 50,
        sessions: [
          sessionDetail(9001, "10", "LATE", "2026-02-10T09:40:00.000Z"),
          sessionDetail(9002, "12", "ABSENT", null),
        ],
      },
      {
        studentId: 3,
        matricNumber: "19/52HA003",
        studentName: "Student Gamma",
        totalCompletedSessions: 2,
        presentCount: 0,
        lateCount: 0,
        absentCount: 2,
        attendancePercentage: null,
        sessions: [
          sessionDetail(9001, "10", "ABSENT", null),
          sessionDetail(9002, "12", "ABSENT", null),
        ],
      },
    ],
  };
}

test("a session workbook is generated with a single worksheet", () => {
  const workbook = buildLecturerSessionAttendanceWorkbook(sessionReport());
  assert.ok(workbook);
  assert.equal(workbook.worksheets.length, 1);
});

test("the session worksheet is named Session Attendance", () => {
  const sheet =
    buildLecturerSessionAttendanceWorkbook(sessionReport()).worksheets[0];
  assert.equal(sheet.name, "Session Attendance");
});

test("session metadata appears in the session sheet title", () => {
  const sheet =
    buildLecturerSessionAttendanceWorkbook(sessionReport()).worksheets[0];
  assert.equal(sheet.getCell(1, 1).value, "Course Code");
  assert.equal(sheet.getCell(1, 2).value, "CSC401");
  assert.equal(sheet.getCell(2, 2).value, "Compiler Construction");
  assert.equal(sheet.getCell(3, 2).value, "2025/2026");
  assert.equal(sheet.getCell(4, 2).value, "Second Semester");
  assert.equal(sheet.getCell(5, 2).value, "Level 400");
  assert.equal(sheet.getCell(6, 2).value, "Ada Obi (STF/001)");
  assert.equal(sheet.getCell(7, 2).value, "HallNet");
  assert.equal(sheet.getCell(8, 2).value, "LT1");
  assert.equal(sheet.getCell(9, 1).value, "Session Start");
  assert.ok(sheet.getCell(9, 2).value instanceof Date);
  assert.equal(sheet.getCell(10, 1).value, "Session End");
  assert.ok(sheet.getCell(10, 2).value instanceof Date);
  assert.equal(sheet.getCell(11, 2).value, 5);
  assert.equal(sheet.getCell(12, 1).value, "Ended At");
  assert.ok(sheet.getCell(12, 2).value instanceof Date);
});

test("session student rows appear below the table header with statuses", () => {
  const sheet =
    buildLecturerSessionAttendanceWorkbook(sessionReport()).worksheets[0];
  assert.equal(sheet.getCell(14, 1).value, "Student Name");
  assert.equal(sheet.getCell(14, 2).value, "Matric Number");
  assert.equal(sheet.getCell(14, 3).value, "Status");
  assert.equal(sheet.getCell(14, 4).value, "Marked At");

  assert.equal(sheet.getCell(15, 1).value, "Student Alpha");
  assert.equal(sheet.getCell(15, 3).value, "PRESENT");
  assert.equal(sheet.getCell(16, 1).value, "Student Beta");
  assert.equal(sheet.getCell(16, 3).value, "LATE");
  assert.equal(sheet.getCell(17, 1).value, "Student Gamma");
  assert.equal(sheet.getCell(17, 3).value, "ABSENT");
});

test("session marked-at stays blank for ABSENT students", () => {
  const sheet =
    buildLecturerSessionAttendanceWorkbook(sessionReport()).worksheets[0];
  assert.ok(sheet.getCell(15, 4).value instanceof Date);
  assert.ok(sheet.getCell(16, 4).value instanceof Date);
  assert.equal(sheet.getCell(17, 4).value, null);
});

test("the session sheet header row is frozen", () => {
  const sheet =
    buildLecturerSessionAttendanceWorkbook(sessionReport()).worksheets[0];
  assert.equal(sheet.views.length, 1);
  assert.equal(sheet.views[0].state, "frozen");
  assert.equal(sheet.views[0].ySplit, 14);
});

test("session filename follows the course, period and session pattern", () => {
  assert.equal(
    lecturerSessionAttendanceFilename(sessionReport()),
    "CSC401-2025-2026-Second-Semester-Session-2026-02-10-Attendance.xlsx"
  );
});

test("session filename sanitizes reserved characters", () => {
  const report = sessionReport({
    courseCode: "E2E 101 /x",
    academicSession: "2025/2026",
    semester: "First Semester!!",
  });
  assert.equal(
    lecturerSessionAttendanceFilename(report),
    "E2E-101-x-2025-2026-First-Semester-Session-2026-02-10-Attendance.xlsx"
  );
});

test("session filename falls back when every part sanitizes to empty", () => {
  const report = sessionReport({
    courseCode: "///",
    academicSession: "...",
    semester: "   ",
  });
  assert.equal(
    lecturerSessionAttendanceFilename(report),
    "Session-2026-02-10-Attendance.xlsx"
  );
});

test("a semester workbook is generated with summary and details sheets", () => {
  const workbook = buildLecturerSemesterAttendanceWorkbook(semesterReport());
  assert.ok(workbook);
  assert.equal(workbook.worksheets.length, 2);
  assert.equal(workbook.worksheets[0].name, "Attendance Summary");
  assert.equal(workbook.worksheets[1].name, "Session Details");
});

test("semester metadata appears in the summary sheet title", () => {
  const sheet = buildLecturerSemesterAttendanceWorkbook(
    semesterReport()
  ).worksheets[0];
  assert.equal(sheet.getCell(1, 1).value, "Course Code");
  assert.equal(sheet.getCell(1, 2).value, "CSC401");
  assert.equal(sheet.getCell(2, 2).value, "Compiler Construction");
  assert.equal(sheet.getCell(3, 2).value, "2025/2026");
  assert.equal(sheet.getCell(4, 2).value, "Second Semester");
  assert.equal(sheet.getCell(5, 2).value, "Level 400");
  assert.equal(sheet.getCell(6, 2).value, "Ada Obi (STF/001)");
  assert.equal(sheet.getCell(7, 2).value, 2);
});

test("semester summary student rows preserve counts and percentage", () => {
  const workbook = buildLecturerSemesterAttendanceWorkbook(semesterReport());
  const summary = workbook.worksheets[0];

  assert.equal(summary.getCell(9, 1).value, "Student Name");
  assert.equal(summary.getCell(9, 3).value, "Present");
  assert.equal(summary.getCell(9, 6).value, "Total Completed Sessions");
  assert.equal(summary.getCell(9, 7).value, "Attendance Percentage");

  assert.equal(summary.getCell(10, 1).value, "Student Alpha");
  assert.equal(summary.getCell(10, 2).value, "19/52HA001");
  assert.equal(summary.getCell(10, 3).value, 2);
  assert.equal(summary.getCell(10, 4).value, 0);
  assert.equal(summary.getCell(10, 5).value, 0);
  assert.equal(summary.getCell(10, 6).value, 2);
  assert.equal(summary.getCell(10, 7).value, 100);

  assert.equal(summary.getCell(11, 1).value, "Student Beta");
  assert.equal(summary.getCell(11, 3).value, 0);
  assert.equal(summary.getCell(11, 4).value, 1);
  assert.equal(summary.getCell(11, 5).value, 1);
  assert.equal(summary.getCell(11, 7).value, 50);
});

test("a null attendance percentage leaves the summary cell blank", () => {
  const summary = buildLecturerSemesterAttendanceWorkbook(
    semesterReport()
  ).worksheets[0];
  assert.equal(summary.getCell(12, 7).value, null);
});

test("the semester summary header row is frozen", () => {
  const summary = buildLecturerSemesterAttendanceWorkbook(
    semesterReport()
  ).worksheets[0];
  assert.equal(summary.views.length, 1);
  assert.equal(summary.views[0].state, "frozen");
  assert.equal(summary.views[0].ySplit, 9);
});

test("the session details sheet lists every student session with metadata", () => {
  const details = buildLecturerSemesterAttendanceWorkbook(
    semesterReport()
  ).worksheets[1];

  assert.equal(details.getCell(1, 1).value, "Student Name");
  assert.equal(details.getCell(1, 6).value, "Status");
  assert.equal(details.getCell(1, 8).value, "Location");
  assert.equal(details.getCell(1, 9).value, "Attendance Network");

  assert.equal(details.getCell(2, 1).value, "Student Alpha");
  assert.equal(details.getCell(2, 2).value, "19/52HA001");
  assert.equal(details.getCell(2, 6).value, "PRESENT");
  assert.ok(details.getCell(2, 7).value instanceof Date);
  assert.equal(details.getCell(3, 1).value, "Student Alpha");
  assert.equal(details.getCell(3, 6).value, "PRESENT");

  assert.equal(details.getCell(4, 1).value, "Student Beta");
  assert.equal(details.getCell(4, 6).value, "LATE");
  assert.equal(details.getCell(5, 6).value, "ABSENT");
  assert.equal(details.getCell(5, 7).value, null);

  assert.equal(details.getCell(6, 1).value, "Student Gamma");
  assert.equal(details.getCell(6, 6).value, "ABSENT");
  assert.equal(details.getCell(7, 6).value, "ABSENT");
});

test("the details sheet header row is frozen", () => {
  const details = buildLecturerSemesterAttendanceWorkbook(
    semesterReport()
  ).worksheets[1];
  assert.equal(details.views.length, 1);
  assert.equal(details.views[0].state, "frozen");
  assert.equal(details.views[0].ySplit, 1);
});

test("semester filename follows the course and academic period pattern", () => {
  assert.equal(
    lecturerSemesterAttendanceFilename(semesterReport()),
    "CSC401-2025-2026-Second-Semester-Attendance.xlsx"
  );
});

test("semester filename falls back when every part sanitizes to empty", () => {
  const report = semesterReport({
    courseCode: "///",
    academicSession: "...",
    semester: "   ",
  });
  assert.equal(
    lecturerSemesterAttendanceFilename(report),
    "course-attendance-Attendance.xlsx"
  );
});

test("the session workbook can be serialized to an xlsx buffer", async () => {
  const workbook = buildLecturerSessionAttendanceWorkbook(sessionReport());
  const buffer = await workbook.xlsx.writeBuffer();
  assert.ok(buffer);
  assert.ok(buffer instanceof Uint8Array || buffer instanceof ArrayBuffer);
});

test("the semester workbook can be serialized to an xlsx buffer", async () => {
  const workbook = buildLecturerSemesterAttendanceWorkbook(semesterReport());
  const buffer = await workbook.xlsx.writeBuffer();
  assert.ok(buffer);
  assert.ok(buffer instanceof Uint8Array || buffer instanceof ArrayBuffer);
});