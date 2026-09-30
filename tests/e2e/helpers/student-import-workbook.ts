import path from "node:path";
import { createRequire } from "node:module";

// ExcelJS ships as a backend dependency. This helper scopes a require to the
// backend node_modules (Playwright runs from the repo root), so the E2E specs
// can synthesise real .xlsx fixtures with the same library the backend uses to
// parse them, without duplicating the dependency at the repo root.
const require = createRequire(
  path.join(
    __dirname,
    "..",
    "..",
    "..",
    "backend",
    "node_modules",
    "exceljs",
    "package.json"
  )
);

type Workbook = {
  addWorksheet(name: string): {
    addRow(values: string[]): unknown;
    addRows(values: string[][]): unknown;
  };
  xlsx: {
    writeBuffer(): Promise<unknown>;
    load(buffer: Buffer): Promise<void>;
  };
  worksheets: Array<{ name: string; rowCount: number }>;
  getWorksheet(index: number): {
    name: string;
    rowCount: number;
    getCell(row: number, column: number): { text: string };
  };
};

// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
const ExcelJS = require("exceljs") as {
  Workbook: new () => Workbook;
};

export const IMPORT_TEMPLATE_SHEET = "Students";
export const IMPORT_TEMPLATE_HEADERS = ["Student Name", "Matric Number"];

export async function buildStudentImportWorkbook(
  rows: ReadonlyArray<readonly [string, string]>
): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet(IMPORT_TEMPLATE_SHEET);
  sheet.addRow(IMPORT_TEMPLATE_HEADERS);
  if (rows.length > 0) {
    sheet.addRows(rows.map(([name, matric]) => [name, matric]));
  }
  const written = await workbook.xlsx.writeBuffer();
  if (written instanceof ArrayBuffer) {
    return Buffer.from(written);
  }
  return Buffer.from(written as ArrayBufferLike);
}

export async function readImportWorkbook(
  buffer: Buffer
): Promise<{
  sheetName: string;
  headers: string[];
  rowCount: number;
}> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const sheet = workbook.getWorksheet(1);
  return {
    sheetName: sheet.name,
    headers: [
      sheet.getCell(1, 1).text,
      sheet.getCell(1, 2).text,
    ],
    rowCount: sheet.rowCount,
  };
}