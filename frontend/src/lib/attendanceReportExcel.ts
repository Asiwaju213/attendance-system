import ExcelJS from "exceljs";
import type { Workbook } from "exceljs";
import type { CourseOfferingAttendanceReport } from "../types/attendance";

const WORKSHEET_NAME = "Attendance Report";

const REPORT_TITLE_ROWS = 7;
const TABLE_HEADER_ROW = REPORT_TITLE_ROWS + 2;

const XLSX_MIME_TYPE =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

function sanitizeFilenamePart(value: string): string {
  return value
    .trim()
    .replace(/[^A-Za-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function attendanceReportFilename(
  report: CourseOfferingAttendanceReport
): string {
  const { courseCode, academicSessionName, semesterName } =
    report.courseOffering;
  const base = [courseCode, academicSessionName, semesterName]
    .map(sanitizeFilenamePart)
    .filter((part) => part !== "")
    .join("-");
  const stem = base === "" ? "course-attendance" : base;
  return `${stem}-Attendance.xlsx`;
}

export function buildAttendanceReportWorkbook(
  report: CourseOfferingAttendanceReport
): Workbook {
  const { courseOffering, students } = report;

  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Attendance System";
  workbook.created = new Date();

  const sheet = workbook.addWorksheet(WORKSHEET_NAME);
  sheet.columns = [
    { width: 32 },
    { width: 22 },
    { width: 12 },
    { width: 12 },
    { width: 12 },
    { width: 12 },
    { width: 16 },
  ];

  sheet.getCell(1, 1).value = "Course Code";
  sheet.getCell(1, 2).value = courseOffering.courseCode;
  sheet.getCell(2, 1).value = "Course Title";
  sheet.getCell(2, 2).value = courseOffering.courseTitle;
  sheet.getCell(3, 1).value = "Academic Session";
  sheet.getCell(3, 2).value = courseOffering.academicSessionName;
  sheet.getCell(4, 1).value = "Semester";
  sheet.getCell(4, 2).value = courseOffering.semesterName;
  sheet.getCell(5, 1).value = "Level";
  sheet.getCell(5, 2).value = `Level ${courseOffering.levelName}`;
  sheet.getCell(6, 1).value = "Lecturer(s)";
  sheet.getCell(6, 2).value = courseOffering.lecturers
    .map((lecturer) => `${lecturer.name} (${lecturer.staffId})`)
    .join(", ");
  sheet.getCell(7, 1).value = "Completed Sessions";
  sheet.getCell(7, 2).value = courseOffering.totalCompletedSessions;

  for (let row = 1; row <= REPORT_TITLE_ROWS; row += 1) {
    sheet.getCell(row, 1).font = { bold: true };
  }

  const headers = [
    "Student",
    "Matric Number",
    "Sessions",
    "Present",
    "Late",
    "Absent",
    "Attendance %",
  ];
  const headerRow = sheet.getRow(TABLE_HEADER_ROW);
  headers.forEach((header, index) => {
    const cell = headerRow.getCell(index + 1);
    cell.value = header;
    cell.font = { bold: true };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE8EEF4" } };
    cell.border = {
      bottom: { style: "thin", color: { argb: "FFB0B7C0" } },
    };
  });

  students.forEach((student, index) => {
    const row = sheet.getRow(TABLE_HEADER_ROW + 1 + index);
    row.getCell(1).value = student.studentName;
    row.getCell(2).value = student.matricNumber;
    row.getCell(3).value = student.totalCompletedSessions;
    row.getCell(4).value = student.presentCount;
    row.getCell(5).value = student.lateCount;
    row.getCell(6).value = student.absentCount;
    if (student.attendancePercentage !== null) {
      const percentageCell = row.getCell(7);
      percentageCell.value = student.attendancePercentage;
      percentageCell.numFmt = '0.00"%"';
    }
  });

  sheet.views = [{ state: "frozen", ySplit: TABLE_HEADER_ROW }];

  return workbook;
}

export async function downloadAttendanceReport(
  report: CourseOfferingAttendanceReport
): Promise<void> {
  const workbook = buildAttendanceReportWorkbook(report);
  const data = await workbook.xlsx.writeBuffer();
  const blob = new Blob([data as unknown as BlobPart], {
    type: XLSX_MIME_TYPE,
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = attendanceReportFilename(report);
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}