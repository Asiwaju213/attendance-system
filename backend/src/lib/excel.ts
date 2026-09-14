import ExcelJS from "exceljs";
import { MAX_MATRIC_LENGTH, normalizeMatric } from "./identity";
import { ImportedStudentRow } from "../types/studentImport";

export const IMPORT_LIMITS = {
  maxFileSizeBytes: 10 * 1024 * 1024,
  maxRows: 2000,
  maxNameLength: 200,
  maxMatricLength: MAX_MATRIC_LENGTH,
} as const;

export const PREVIEW_LIFETIME_MS = 15 * 60 * 1000;

export type ParseFailureCode = "INVALID_FILE" | "EMPTY_FILE" | "MISSING_COLUMNS" | "TOO_MANY_ROWS";

export type ParseResult =
  | {
      ok: true;
      rows: ImportedStudentRow[];
      totalRows: number;
      validRows: number;
      invalidRows: number;
    }
  | { ok: false; code: ParseFailureCode; message: string };

const STUDENT_NAME_HEADER = "student name";
const MATRIC_NUMBER_HEADER = "matric number";

function normalizeHeader(value: string): string {
  return value.trim().toLowerCase();
}

function normalizeName(value: string): string {
  return value.trim();
}

function cellText(cell: ExcelJS.Cell): string {
  const text = cell.text;
  return text === null || text === undefined ? "" : String(text);
}

function countValid(rows: ImportedStudentRow[]): number {
  return rows.reduce((count, row) => (row.valid ? count + 1 : count), 0);
}

export function buildRowsWithExistingMatrics(
  rows: ImportedStudentRow[],
  existingMatrics: Set<string>
): void {
  for (const row of rows) {
    if (row.valid && existingMatrics.has(row.matricNumber)) {
      row.valid = false;
      row.errors.push("matric number already exists");
    }
  }
}

export function recalcValidCounts(rows: ImportedStudentRow[]): {
  validRows: number;
  invalidRows: number;
} {
  const validRows = countValid(rows);
  return { validRows, invalidRows: rows.length - validRows };
}

export async function parseAndValidateWorkbook(buffer: Buffer): Promise<ParseResult> {
  if (buffer.length < 4 || buffer[0] !== 0x50 || buffer[1] !== 0x4b) {
    return {
      ok: false,
      code: "INVALID_FILE",
      message: "The uploaded file is not a valid .xlsx workbook.",
    };
  }

  let workbook: ExcelJS.Workbook;
  try {
    workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer as unknown as ExcelJS.Buffer);
  } catch {
    return {
      ok: false,
      code: "INVALID_FILE",
      message: "The uploaded file is not a valid .xlsx workbook.",
    };
  }

  const sheets = workbook.worksheets;
  if (sheets.length === 0) {
    return {
      ok: false,
      code: "EMPTY_FILE",
      message: "The workbook contains no worksheets.",
    };
  }

  const sheet = sheets[0];

  const headerRow = sheet.getRow(1);
  let studentNameCol = 0;
  let matricNumberCol = 0;

  headerRow.eachCell({ includeEmpty: false }, (cell, colNumber) => {
    const header = normalizeHeader(cellText(cell));
    if (header === STUDENT_NAME_HEADER && studentNameCol === 0) {
      studentNameCol = colNumber;
    } else if (header === MATRIC_NUMBER_HEADER && matricNumberCol === 0) {
      matricNumberCol = colNumber;
    }
  });

  if (studentNameCol === 0 || matricNumberCol === 0) {
    return {
      ok: false,
      code: "MISSING_COLUMNS",
      message:
        "The workbook must contain a 'Student Name' column and a 'Matric Number' column as the first row.",
    };
  }

  const rows: ImportedStudentRow[] = [];
  const seenMatrics = new Set<string>();

  const lastRow = sheet.rowCount;

  for (let rowNumber = 2; rowNumber <= lastRow; rowNumber++) {
    const row = sheet.getRow(rowNumber);
    const nameRaw = cellText(row.getCell(studentNameCol));
    const matricRaw = cellText(row.getCell(matricNumberCol));

    const studentName = normalizeName(nameRaw);
    const matricNumber = normalizeMatric(matricRaw);

    if (!studentName && !matricNumber) {
      continue;
    }

    if (rows.length >= IMPORT_LIMITS.maxRows) {
      return {
        ok: false,
        code: "TOO_MANY_ROWS",
        message: `The workbook contains more than ${IMPORT_LIMITS.maxRows} student rows.`,
      };
    }

    const errors: string[] = [];
    if (!studentName) {
      errors.push("missing student name");
    } else if (studentName.length > IMPORT_LIMITS.maxNameLength) {
      errors.push(`student name exceeds ${IMPORT_LIMITS.maxNameLength} characters`);
    }
    if (!matricNumber) {
      errors.push("missing matric number");
    } else if (matricNumber.length > IMPORT_LIMITS.maxMatricLength) {
      errors.push(`matric number exceeds ${IMPORT_LIMITS.maxMatricLength} characters`);
    } else if (seenMatrics.has(matricNumber)) {
      errors.push("duplicate matric number in file");
    } else {
      seenMatrics.add(matricNumber);
    }

    rows.push({
      rowNumber,
      studentName,
      matricNumber,
      valid: errors.length === 0,
      errors,
    });
  }

  if (rows.length === 0) {
    return {
      ok: false,
      code: "EMPTY_FILE",
      message: "The workbook contains no student data rows.",
    };
  }

  const counts = recalcValidCounts(rows);
  return {
    ok: true,
    rows,
    totalRows: rows.length,
    validRows: counts.validRows,
    invalidRows: counts.invalidRows,
  };
}

export async function buildStudentImportTemplate(): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Students");
  sheet.addRow(["Student Name", "Matric Number"]);
  const written = await workbook.xlsx.writeBuffer();
  return Buffer.from(written);
}