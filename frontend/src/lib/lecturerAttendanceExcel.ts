import ExcelJS from "exceljs";
import type { Workbook, Worksheet } from "exceljs";
import type {
  LecturerAttendanceReport,
  LecturerSessionAttendanceReport,
} from "../types/attendance";

const SUMMARY_SHEET_NAME = "Attendance Summary";
const DETAILS_SHEET_NAME = "Session Details";
const SESSION_SHEET_NAME = "Session Attendance";

const SEMESTER_TITLE_ROWS = 7;
const SEMESTER_HEADER_ROW = SEMESTER_TITLE_ROWS + 2;
const SESSION_TITLE_ROWS = 12;
const SESSION_HEADER_ROW = SESSION_TITLE_ROWS + 2;
const DETAILS_HEADER_ROW = 1;

const XLSX_MIME_TYPE =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

type TitleCellValue = string | number | Date | null;

function sanitizeFilenamePart(value: string): string {
  return value
    .trim()
    .replace(/[^A-Za-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function sessionStartDate(startTime: string): string {
  return new Date(startTime).toISOString().slice(0, 10);
}

export function lecturerSemesterAttendanceFilename(
  report: LecturerAttendanceReport
): string {
  const { courseCode, academicSession, semester } = report.courseOffering;
  const base = [courseCode, academicSession, semester]
    .map(sanitizeFilenamePart)
    .filter((part) => part !== "")
    .join("-");
  const stem = base === "" ? "course-attendance" : base;
  return `${stem}-Attendance.xlsx`;
}

export function lecturerSessionAttendanceFilename(
  report: LecturerSessionAttendanceReport
): string {
  const { courseCode, academicSession, semester, startTime } = report.session;
  const base = [courseCode, academicSession, semester, "Session", sessionStartDate(startTime)]
    .map(sanitizeFilenamePart)
    .filter((part) => part !== "")
    .join("-");
  const stem = base === "" ? "session-attendance" : base;
  return `${stem}-Attendance.xlsx`;
}

function writeTitleRow(
  sheet: Worksheet,
  row: number,
  label: string,
  value: TitleCellValue
): void {
  const labelCell = sheet.getCell(row, 1);
  labelCell.value = label;
  labelCell.font = { bold: true };
  sheet.getCell(row, 2).value = value;
}

function writeTitleDateRow(
  sheet: Worksheet,
  row: number,
  label: string,
  value: string
): void {
  writeTitleRow(sheet, row, label, new Date(value));
  const cell = sheet.getCell(row, 2);
  cell.numFmt = "yyyy-mm-dd hh:mm";
}

function writeHeaderRow(
  sheet: Worksheet,
  rowNumber: number,
  headers: string[]
): void {
  const row = sheet.getRow(rowNumber);
  headers.forEach((header, index) => {
    const cell = row.getCell(index + 1);
    cell.value = header;
    cell.font = { bold: true };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE8EEF4" } };
    cell.border = {
      bottom: { style: "thin", color: { argb: "FFB0B7C0" } },
    };
  });
}

function writeDateTimeCell(sheet: Worksheet, row: number, column: number, value: string | null): void {
  if (value === null) {
    return;
  }
  const cell = sheet.getRow(row).getCell(column);
  cell.value = new Date(value);
  cell.numFmt = "yyyy-mm-dd hh:mm";
}

export function buildLecturerSemesterAttendanceWorkbook(
  report: LecturerAttendanceReport
): Workbook {
  const { courseOffering, students } = report;

  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Attendance System";
  workbook.created = new Date();

  const summary = workbook.addWorksheet(SUMMARY_SHEET_NAME);
  summary.columns = [
    { width: 32 },
    { width: 24 },
    { width: 12 },
    { width: 12 },
    { width: 12 },
    { width: 24 },
    { width: 20 },
  ];

  writeTitleRow(summary, 1, "Course Code", courseOffering.courseCode);
  writeTitleRow(summary, 2, "Course Title", courseOffering.courseTitle);
  writeTitleRow(summary, 3, "Academic Session", courseOffering.academicSession);
  writeTitleRow(summary, 4, "Semester", courseOffering.semester);
  writeTitleRow(summary, 5, "Level", `Level ${courseOffering.level}`);
  writeTitleRow(
    summary,
    6,
    "Lecturer(s)",
    `${courseOffering.lecturer.name} (${courseOffering.lecturer.staffId})`
  );
  writeTitleRow(summary, 7, "Completed Sessions", courseOffering.totalCompletedSessions);

  writeHeaderRow(summary, SEMESTER_HEADER_ROW, [
    "Student Name",
    "Matric Number",
    "Present",
    "Late",
    "Absent",
    "Total Completed Sessions",
    "Attendance Percentage",
  ]);

  students.forEach((student, index) => {
    const row = summary.getRow(SEMESTER_HEADER_ROW + 1 + index);
    row.getCell(1).value = student.studentName;
    row.getCell(2).value = student.matricNumber;
    row.getCell(3).value = student.presentCount;
    row.getCell(4).value = student.lateCount;
    row.getCell(5).value = student.absentCount;
    row.getCell(6).value = student.totalCompletedSessions;
    if (student.attendancePercentage !== null) {
      const percentageCell = row.getCell(7);
      percentageCell.value = student.attendancePercentage;
      percentageCell.numFmt = '0.00"%"';
    }
  });

  summary.views = [{ state: "frozen", ySplit: SEMESTER_HEADER_ROW }];

  const details = workbook.addWorksheet(DETAILS_SHEET_NAME);
  details.columns = [
    { width: 32 },
    { width: 24 },
    { width: 16 },
    { width: 20 },
    { width: 20 },
    { width: 12 },
    { width: 20 },
    { width: 28 },
    { width: 28 },
  ];

  writeHeaderRow(details, DETAILS_HEADER_ROW, [
    "Student Name",
    "Matric Number",
    "Session Date",
    "Session Start",
    "Session End",
    "Status",
    "Marked At",
  ]);

  let detailsRow = DETAILS_HEADER_ROW + 1;
  for (const student of students) {
    for (const session of student.sessions) {
      const row = details.getRow(detailsRow);
      row.getCell(1).value = student.studentName;
      row.getCell(2).value = student.matricNumber;
      const dateCell = row.getCell(3);
      dateCell.value = new Date(session.startTime);
      dateCell.numFmt = "yyyy-mm-dd";
      writeDateTimeCell(details, detailsRow, 4, session.startTime);
      writeDateTimeCell(details, detailsRow, 5, session.endTime);
      row.getCell(6).value = session.status;
      writeDateTimeCell(details, detailsRow, 7, session.markedAt);
      detailsRow += 1;
    }
  }

  details.views = [{ state: "frozen", ySplit: DETAILS_HEADER_ROW }];

  return workbook;
}

export function buildLecturerSessionAttendanceWorkbook(
  report: LecturerSessionAttendanceReport
): Workbook {
  const { session, students } = report;

  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Attendance System";
  workbook.created = new Date();

  const sheet = workbook.addWorksheet(SESSION_SHEET_NAME);
  sheet.columns = [
    { width: 32 },
    { width: 24 },
    { width: 14 },
    { width: 20 },
  ];

  writeTitleRow(sheet, 1, "Course Code", session.courseCode);
  writeTitleRow(sheet, 2, "Course Title", session.courseTitle);
  writeTitleRow(sheet, 3, "Academic Session", session.academicSession);
  writeTitleRow(sheet, 4, "Semester", session.semester);
  writeTitleRow(sheet, 5, "Level", `Level ${session.level}`);
  writeTitleRow(
    sheet,
    6,
    "Lecturer",
    `${session.startedByLecturer.name} (${session.startedByLecturer.staffId})`
  );
  writeTitleDateRow(sheet, 7, "Session Start", session.startTime);
  writeTitleDateRow(sheet, 8, "Session End", session.endTime);
  writeTitleRow(sheet, 9, "Late Threshold (Minutes)", session.lateThresholdMinutes);
  writeTitleDateRow(sheet, 10, "Ended At", session.endedAt);

  writeHeaderRow(sheet, SESSION_HEADER_ROW, [
    "Student Name",
    "Matric Number",
    "Status",
    "Marked At",
  ]);

  students.forEach((student, index) => {
    const row = sheet.getRow(SESSION_HEADER_ROW + 1 + index);
    row.getCell(1).value = student.studentName;
    row.getCell(2).value = student.matricNumber;
    row.getCell(3).value = student.status;
    writeDateTimeCell(sheet, SESSION_HEADER_ROW + 1 + index, 4, student.markedAt);
  });

  sheet.views = [{ state: "frozen", ySplit: SESSION_HEADER_ROW }];

  return workbook;
}

async function downloadWorkbook(workbook: Workbook, filename: string): Promise<void> {
  const data = await workbook.xlsx.writeBuffer();
  const blob = new Blob([data as unknown as BlobPart], {
    type: XLSX_MIME_TYPE,
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function downloadLecturerSemesterAttendanceReport(
  report: LecturerAttendanceReport
): Promise<void> {
  await downloadWorkbook(
    buildLecturerSemesterAttendanceWorkbook(report),
    lecturerSemesterAttendanceFilename(report)
  );
}

export async function downloadLecturerSessionAttendanceReport(
  report: LecturerSessionAttendanceReport
): Promise<void> {
  await downloadWorkbook(
    buildLecturerSessionAttendanceWorkbook(report),
    lecturerSessionAttendanceFilename(report)
  );
}
