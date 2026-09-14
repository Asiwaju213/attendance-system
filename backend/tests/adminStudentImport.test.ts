import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { deflateRawSync } from "node:zlib";
import ExcelJS from "exceljs";
import { app } from "../src/app";
import { authConfig } from "../src/config/auth";
import { pool } from "../src/db/pool";
import { IMPORT_LIMITS } from "../src/lib/excel";
import { hashPassword } from "../src/lib/passwords";

const TEST_PASSWORD = "admin-import-test-password";
const ADMIN_USERNAME = "ADMIMP_ADMIN";
const STUDENT_MATRIC = "ADMIMP/STU";
const LECTURER_STAFF_ID = "ADMIMP/LEC";
const EXISTING_MATRIC = "ADMIMP/EXIST";

let server: Server;
let baseUrl: string;
let passwordHash: string;

let adminUserId = 0;
let studentUserId = 0;
let lecturerUserId = 0;

let facId = 0;
let dep1Id = 0;
let dep2InactiveId = 0;
let level100Id = 0;
let level200Id = 0;

let adminTokenValue = "";
let studentTokenValue = "";
let lecturerTokenValue = "";

function cookieFrom(res: globalThis.Response): string | null {
  const cookie = res.headers
    .getSetCookie()
    .find((c) => c.startsWith(`${authConfig.cookieName}=`));
  if (!cookie) {
    return null;
  }
  const eq = cookie.indexOf("=");
  const semi = cookie.indexOf(";");
  return cookie.slice(eq + 1, semi);
}

function cookieHeader(token: string): Record<string, string> {
  return { cookie: `${authConfig.cookieName}=${token}` };
}

async function postJson(path: string, body: unknown, headers: Record<string, string> = {}) {
  return fetch(baseUrl + path, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

async function get(path: string, headers: Record<string, string> = {}) {
  return fetch(baseUrl + path, { headers });
}

async function postMulti(
  path: string,
  token: string,
  fields: Record<string, string>,
  fileBuffer: Buffer,
  filename = "students.xlsx"
): Promise<globalThis.Response> {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    form.append(key, value);
  }
  form.append("file", new Blob([fileBuffer]), filename);
  return fetch(baseUrl + path, {
    method: "POST",
    headers: cookieHeader(token),
    body: form,
  });
}

async function parseBody(res: globalThis.Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

async function buildWorkbook(rows: Array<[string, string]>): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Students");
  sheet.addRow(["Student Name", "Matric Number"]);
  if (rows.length > 0) {
    sheet.addRows(rows);
  }
  const written = await workbook.xlsx.writeBuffer();
  return Buffer.from(written);
}

// Minimal zip writer used to synthesize a valid .xlsx that contains no worksheets.
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let crc = -1;
  for (let i = 0; i < buf.length; i++) {
    crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ -1) >>> 0;
}

function buildZip(entries: Array<{ name: string; data: string }>): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const raw = Buffer.from(entry.data, "utf8");
    const data = deflateRawSync(raw);
    const crc = crc32(raw);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    parts.push(local, name, data);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0, 8);
    cd.writeUInt16LE(8, 10);
    cd.writeUInt16LE(0, 12);
    cd.writeUInt16LE(0, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(data.length, 20);
    cd.writeUInt32LE(raw.length, 24);
    cd.writeUInt16LE(name.length, 28);
    cd.writeUInt16LE(0, 30);
    cd.writeUInt16LE(0, 32);
    cd.writeUInt16LE(0, 34);
    cd.writeUInt16LE(0, 36);
    cd.writeUInt32LE(0, 38);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, name);
    offset += 30 + name.length + data.length;
  }

  const centralBuffer = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuffer.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...parts, centralBuffer, eocd]);
}

function buildNoWorksheetWorkbook(): Buffer {
  return buildZip([
    {
      name: "[Content_Types].xml",
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></Types>`,
    },
    {
      name: "_rels/.rels",
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    },
    {
      name: "xl/workbook.xml",
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets/></workbook>`,
    },
    {
      name: "xl/_rels/workbook.xml.rels",
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>`,
    },
  ]);
}

async function buildColsWorkbook(headers: string[], rows: Array<[string, string]>): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Students");
  sheet.addRow(headers);
  if (rows.length > 0) {
    sheet.addRows(rows);
  }
  const written = await workbook.xlsx.writeBuffer();
  return Buffer.from(written);
}

async function preview(rows: Array<[string, string]>): Promise<{
  res: globalThis.Response;
  body: Record<string, unknown>;
}> {
  const buffer = await buildWorkbook(rows);
  const res = await postMulti(
    "/api/admin/students/import/preview",
    adminTokenValue,
    { departmentId: String(dep1Id), levelId: String(level100Id) },
    buffer
  );
  return { res, body: await parseBody(res) };
}

function assertError(body: Record<string, unknown>, error: string): void {
  assert.equal(body.error, error);
  assert.ok(typeof body.message === "string" && body.message.length > 0);
}

function findRow<T>(rows: T[], predicate: (row: T) => boolean): T {
  const row = rows.find(predicate);
  assert.ok(row, "expected row not found in preview");
  return row;
}

async function countMatrics(matrics: string[]): Promise<number> {
  const result = await pool.query(
    `SELECT count(*)::int AS count FROM students WHERE matric_number = ANY($1::TEXT[])`,
    [matrics]
  );
  return result.rows[0].count as number;
}

async function cleanupScopedData(): Promise<void> {
  await pool.query(`DELETE FROM student_import_previews`);
  await pool.query(
    `DELETE FROM sessions
     WHERE user_id IN (
       SELECT user_id FROM students WHERE matric_number LIKE 'ADMIMP%'
       UNION
       SELECT user_id FROM lecturers WHERE staff_id = 'ADMIMP/LEC'
       UNION
       SELECT id FROM users WHERE username = 'ADMIMP_ADMIN'
     )`
  );
  await pool.query(`DELETE FROM students WHERE matric_number LIKE 'ADMIMP%'`);
  await pool.query(`DELETE FROM lecturers WHERE staff_id = 'ADMIMP/LEC'`);
  await pool.query(
    `DELETE FROM users
     WHERE username = 'ADMIMP_ADMIN'
        OR id IN (
          SELECT user_id FROM students WHERE matric_number LIKE 'ADMIMP%'
          UNION
          SELECT user_id FROM lecturers WHERE staff_id = 'ADMIMP/LEC'
        )`
  );
  await pool.query(`DELETE FROM departments WHERE code LIKE 'ADMIMP%'`);
  await pool.query(`DELETE FROM faculties WHERE code LIKE 'ADMIMP%'`);
}

before(async () => {
  await cleanupScopedData();
  passwordHash = await hashPassword(TEST_PASSWORD);

  const admin = await pool.query(
    `INSERT INTO users (name, password_hash, role, status, username)
     VALUES ('Import Test Admin', $1, 'ADMIN', 'ACTIVE', $2)
     RETURNING id`,
    [passwordHash, ADMIN_USERNAME]
  );
  adminUserId = Number(admin.rows[0].id);

  const fac = await pool.query(
    `INSERT INTO faculties (name, code) VALUES ('Faculty of Import', 'ADMIMP-FAC') RETURNING id`
  );
  facId = Number(fac.rows[0].id);

  const dep1 = await pool.query(
    `INSERT INTO departments (name, code, faculty_id)
     VALUES ('Import Department Active', 'ADMIMP-DEP', $1) RETURNING id`,
    [facId]
  );
  dep1Id = Number(dep1.rows[0].id);

  const dep2 = await pool.query(
    `INSERT INTO departments (name, code, faculty_id, status)
     VALUES ('Import Department Inactive', 'ADMIMP-DEPI', $1, 'INACTIVE') RETURNING id`,
    [facId]
  );
  dep2InactiveId = Number(dep2.rows[0].id);

  const levelRes = await pool.query(`SELECT id, name FROM levels WHERE name IN (100, 200)`);
  const levelIds = new Map<number, number>();
  for (const row of levelRes.rows) {
    levelIds.set(Number(row.name), Number(row.id));
  }
  level100Id = levelIds.get(100)!;
  level200Id = levelIds.get(200)!;

  const student = await pool.query(
    `INSERT INTO users (name, password_hash, role, status, username)
     VALUES ('Import Test Student', $1, 'STUDENT', 'ACTIVE', NULL)
     RETURNING id`,
    [passwordHash]
  );
  studentUserId = Number(student.rows[0].id);
  await pool.query(
    `INSERT INTO students (user_id, matric_number, department_id, level_id)
     VALUES ($1, $2, $3, $4)`,
    [studentUserId, STUDENT_MATRIC, dep1Id, level100Id]
  );

  const lecturer = await pool.query(
    `INSERT INTO users (name, password_hash, role, status, username)
     VALUES ('Import Test Lecturer', $1, 'LECTURER', 'ACTIVE', NULL)
     RETURNING id`,
    [passwordHash]
  );
  lecturerUserId = Number(lecturer.rows[0].id);
  await pool.query(
    `INSERT INTO lecturers (user_id, staff_id, department_id)
     VALUES ($1, $2, $3)`,
    [lecturerUserId, LECTURER_STAFF_ID, dep1Id]
  );

  const existing = await pool.query(
    `INSERT INTO users (name, password_hash, role, status, username)
     VALUES ('Import Existing Student', $1, 'STUDENT', 'ACTIVE', NULL)
     RETURNING id`,
    [passwordHash]
  );
  const existingUserId = Number(existing.rows[0].id);
  await pool.query(
    `INSERT INTO students (user_id, matric_number, department_id, level_id)
     VALUES ($1, $2, $3, $4)`,
    [existingUserId, EXISTING_MATRIC, dep1Id, level100Id]
  );

  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;

  const studentLogin = await postJson("/api/auth/student/login", {
    matricNumber: STUDENT_MATRIC,
    password: TEST_PASSWORD,
  });
  assert.equal(studentLogin.status, 200);
  studentTokenValue = cookieFrom(studentLogin)!;

  const lecturerLogin = await postJson("/api/auth/lecturer/login", {
    staffId: LECTURER_STAFF_ID,
    password: TEST_PASSWORD,
  });
  assert.equal(lecturerLogin.status, 200);
  lecturerTokenValue = cookieFrom(lecturerLogin)!;

  const adminLogin = await postJson("/api/auth/admin/login", {
    username: ADMIN_USERNAME,
    password: TEST_PASSWORD,
  });
  assert.equal(adminLogin.status, 200);
  adminTokenValue = cookieFrom(adminLogin)!;
});

after(async () => {
  if (server) {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  }

  await cleanupScopedData();
  await pool.query(
    `DELETE FROM users WHERE id IN ($1, $2, $3)`,
    [adminUserId, studentUserId, lecturerUserId]
  );
  await pool.end();
});

test("migration 005 is applied: nullable password hash, PENDING status, previews table", async () => {
  const hashResult = await pool.query(
    `SELECT is_nullable FROM information_schema.columns
     WHERE table_name = 'users' AND column_name = 'password_hash'`
  );
  assert.equal(hashResult.rows[0].is_nullable, "YES");

  const statusResult = await pool.query(
    `SELECT pg_get_constraintdef(oid) AS def
     FROM pg_constraint
     WHERE conname = 'users_status_check'`
  );
  assert.ok(statusResult.rows[0].def.includes("PENDING"));

  const previewTable = await pool.query(
    `SELECT to_regclass('student_import_previews') AS table_name`
  );
  assert.ok(previewTable.rows[0].table_name);
});

test("authorization: unauthenticated requests are rejected on all import endpoints", async () => {
  const template = await get("/api/admin/students/import/template");
  assert.equal(template.status, 401);

  const buffer = await buildWorkbook([["Unauth Student", "ADMIMP/UNAUTH"]]);
  const previewRes = await postMulti(
    "/api/admin/students/import/preview",
    "no-token",
    { departmentId: String(dep1Id), levelId: String(level100Id) },
    buffer
  );
  assert.equal(previewRes.status, 401);

  const confirmRes = await postJson("/api/admin/students/import", {
    previewToken: "anything",
  });
  assert.equal(confirmRes.status, 401);
});

test("authorization: students are forbidden on all import endpoints", async () => {
  const template = await get(
    "/api/admin/students/import/template",
    cookieHeader(studentTokenValue)
  );
  assert.equal(template.status, 403);

  const buffer = await buildWorkbook([["Student User", "ADMIMP/STUFORB"]]);
  const previewRes = await postMulti(
    "/api/admin/students/import/preview",
    studentTokenValue,
    { departmentId: String(dep1Id), levelId: String(level100Id) },
    buffer
  );
  assert.equal(previewRes.status, 403);

  const confirmRes = await postJson(
    "/api/admin/students/import",
    { previewToken: "anything" },
    cookieHeader(studentTokenValue)
  );
  assert.equal(confirmRes.status, 403);
});

test("authorization: lecturers are forbidden on all import endpoints", async () => {
  const template = await get(
    "/api/admin/students/import/template",
    cookieHeader(lecturerTokenValue)
  );
  assert.equal(template.status, 403);

  const buffer = await buildWorkbook([["Lecturer User", "ADMIMP/LECFORB"]]);
  const previewRes = await postMulti(
    "/api/admin/students/import/preview",
    lecturerTokenValue,
    { departmentId: String(dep1Id), levelId: String(level100Id) },
    buffer
  );
  assert.equal(previewRes.status, 403);

  const confirmRes = await postJson(
    "/api/admin/students/import",
    { previewToken: "anything" },
    cookieHeader(lecturerTokenValue)
  );
  assert.equal(confirmRes.status, 403);
});

test("file validation: a valid workbook returns a preview", async () => {
  const { res, body } = await preview([
    ["Ada Import", "ADMIMP/001"],
    ["Bello Import", "ADMIMP/002"],
  ]);
  assert.equal(res.status, 200);
  const data = body.data as Record<string, unknown>;
  assert.equal(data.totalRows, 2);
  assert.equal(data.validRows, 2);
  assert.equal(data.invalidRows, 0);
  assert.equal((data.department as { name: string }).name, "Import Department Active");
  assert.equal((data.level as { name: number }).name, 100);
  assert.ok(typeof data.previewToken === "string" && data.previewToken.length > 0);
});

test("file validation: a missing file is rejected", async () => {
  const form = new FormData();
  form.append("departmentId", String(dep1Id));
  form.append("levelId", String(level100Id));
  const res = await fetch(baseUrl + "/api/admin/students/import/preview", {
    method: "POST",
    headers: cookieHeader(adminTokenValue),
    body: form,
  });
  assert.equal(res.status, 400);
  const body = await parseBody(res);
  assertError(body, "INVALID_REQUEST");
});

test("file validation: missing form fields are rejected", async () => {
  const buffer = await buildWorkbook([["Ada Import", "ADMIMP/001"]]);
  const res = await postMulti(
    "/api/admin/students/import/preview",
    adminTokenValue,
    { departmentId: String(dep1Id) },
    buffer
  );
  assert.equal(res.status, 400);
  const body = await parseBody(res);
  assertError(body, "INVALID_REQUEST");
});

test("file validation: a non-xlsx file extension is rejected", async () => {
  const buffer = await buildWorkbook([["Ada Import", "ADMIMP/001"]]);
  const res = await postMulti(
    "/api/admin/students/import/preview",
    adminTokenValue,
    { departmentId: String(dep1Id), levelId: String(level100Id) },
    buffer,
    "students.txt"
  );
  assert.equal(res.status, 400);
  const body = await parseBody(res);
  assertError(body, "UNSUPPORTED_FILE_TYPE");
});

test("file validation: an invalid xlsx buffer is rejected", async () => {
  const res = await postMulti(
    "/api/admin/students/import/preview",
    adminTokenValue,
    { departmentId: String(dep1Id), levelId: String(level100Id) },
    Buffer.from("this is definitely not an xlsx file"),
    "students.xlsx"
  );
  assert.equal(res.status, 400);
  const body = await parseBody(res);
  assertError(body, "INVALID_FILE");
});

test("file validation: no student data rows are rejected", async () => {
  const buffer = await buildWorkbook([]);
  const res = await postMulti(
    "/api/admin/students/import/preview",
    adminTokenValue,
    { departmentId: String(dep1Id), levelId: String(level100Id) },
    buffer
  );
  assert.equal(res.status, 400);
  const body = await parseBody(res);
  assertError(body, "EMPTY_FILE");
});

test("file validation: a workbook without worksheets is rejected", async () => {
  const buffer = buildNoWorksheetWorkbook();
  const res = await postMulti(
    "/api/admin/students/import/preview",
    adminTokenValue,
    { departmentId: String(dep1Id), levelId: String(level100Id) },
    buffer
  );
  assert.equal(res.status, 400);
  const body = await parseBody(res);
  assertError(body, "EMPTY_FILE");
});

test("file validation: missing required columns are rejected", async () => {
  const buffer = await buildColsWorkbook(["Student Name"], [["Ada Import", "ADMIMP/001"]]);
  const res = await postMulti(
    "/api/admin/students/import/preview",
    adminTokenValue,
    { departmentId: String(dep1Id), levelId: String(level100Id) },
    buffer
  );
  assert.equal(res.status, 400);
  const body = await parseBody(res);
  assertError(body, "MISSING_COLUMNS");
});

test("file validation: missing matric number column is rejected", async () => {
  const buffer = await buildColsWorkbook(["Matric Only"], [["ADMIMP/001", "x"]]);
  const res = await postMulti(
    "/api/admin/students/import/preview",
    adminTokenValue,
    { departmentId: String(dep1Id), levelId: String(level100Id) },
    buffer
  );
  assert.equal(res.status, 400);
  const body = await parseBody(res);
  assertError(body, "MISSING_COLUMNS");
});

test("file validation: oversized files are rejected", async () => {
  const res = await postMulti(
    "/api/admin/students/import/preview",
    adminTokenValue,
    { departmentId: String(dep1Id), levelId: String(level100Id) },
    Buffer.alloc(IMPORT_LIMITS.maxFileSizeBytes + 1),
    "students.xlsx"
  );
  assert.equal(res.status, 413);
  const body = await parseBody(res);
  assertError(body, "FILE_TOO_LARGE");
});

test("file validation: workbooks over the row limit are rejected", async () => {
  const rows: Array<[string, string]> = [];
  for (let i = 0; i < IMPORT_LIMITS.maxRows + 1; i++) {
    rows.push([`Student ${i}`, `ADMIMP/ROW${i}`]);
  }
  const buffer = await buildWorkbook(rows);
  const res = await postMulti(
    "/api/admin/students/import/preview",
    adminTokenValue,
    { departmentId: String(dep1Id), levelId: String(level100Id) },
    buffer
  );
  assert.equal(res.status, 400);
  const body = await parseBody(res);
  assertError(body, "TOO_MANY_ROWS");
});

test("row validation: names and matrics are trimmed and normalized", async () => {
  const { res, body } = await preview([
    ["  Ada   Import  ", "  admimp/001  "],
    ["Bello Import", "ADMIMP/002"],
  ]);
  assert.equal(res.status, 200);
  const data = body.data as { rows: Array<Record<string, unknown>> };
  const ada = findRow(data.rows, (r) => r.studentName === "Ada   Import");
  assert.equal(ada.matricNumber, "ADMIMP/001");
  assert.equal(ada.valid, true);
});

test("row validation: missing student name is reported", async () => {
  const { res, body } = await preview([
    ["", "ADMIMP/001"],
    ["Bello Import", "ADMIMP/002"],
  ]);
  assert.equal(res.status, 200);
  const data = body.data as { rows: Array<Record<string, unknown>> };
  const bad = findRow(data.rows, (r) => r.matricNumber === "ADMIMP/001");
  assert.equal(bad.valid, false);
  assert.deepEqual(bad.errors as string[], ["missing student name"]);
});

test("row validation: missing matric number is reported", async () => {
  const { res, body } = await preview([
    ["Ada Import", ""],
    ["Bello Import", "ADMIMP/002"],
  ]);
  assert.equal(res.status, 200);
  const data = body.data as { rows: Array<Record<string, unknown>> };
  const bad = findRow(data.rows, (r) => r.studentName === "Ada Import");
  assert.equal(bad.valid, false);
  assert.deepEqual(bad.errors as string[], ["missing matric number"]);
});

test("row validation: duplicate matrics within the file are reported", async () => {
  const { res, body } = await preview([
    ["Ada Import", "ADMIMP/001"],
    ["Second Ada", "ADMIMP/001"],
  ]);
  assert.equal(res.status, 200);
  const data = body.data as { rows: Array<Record<string, unknown>> };
  const dup = findRow(data.rows, (r) => r.studentName === "Second Ada");
  assert.equal(dup.valid, false);
  assert.deepEqual(dup.errors as string[], ["duplicate matric number in file"]);
  assert.equal(data.validRows, 1);
  assert.equal(data.invalidRows, 1);
});

test("row validation: matrics already in the database are reported", async () => {
  const { res, body } = await preview([
    ["Existing Person", EXISTING_MATRIC],
  ]);
  assert.equal(res.status, 200);
  const data = body.data as { rows: Array<Record<string, unknown>> };
  const bad = findRow(data.rows, (r) => r.matricNumber === EXISTING_MATRIC);
  assert.equal(bad.valid, false);
  assert.deepEqual(bad.errors as string[], ["matric number already exists"]);
});

test("row validation: multiple errors on one row are all reported", async () => {
  const tooLongName = "A".repeat(IMPORT_LIMITS.maxNameLength + 1);
  const { res, body } = await preview([
    [tooLongName, ""],
    ["Bello Import", "ADMIMP/002"],
  ]);
  assert.equal(res.status, 200);
  const data = body.data as { rows: Array<Record<string, unknown>> };
  const bad = data.rows[0];
  assert.equal(bad.valid, false);
  assert.deepEqual(
    (bad.errors as string[]).sort(),
    ["missing matric number", "student name exceeds 200 characters"].sort()
  );
});

test("department and level: nonexistent department is rejected", async () => {
  const buffer = await buildWorkbook([["Ada Import", "ADMIMP/001"]]);
  const res = await postMulti(
    "/api/admin/students/import/preview",
    adminTokenValue,
    { departmentId: "999999999", levelId: String(level100Id) },
    buffer
  );
  assert.equal(res.status, 404);
  const body = await parseBody(res);
  assertError(body, "DEPARTMENT_NOT_FOUND");
});

test("department and level: inactive department is rejected", async () => {
  const buffer = await buildWorkbook([["Ada Import", "ADMIMP/001"]]);
  const res = await postMulti(
    "/api/admin/students/import/preview",
    adminTokenValue,
    { departmentId: String(dep2InactiveId), levelId: String(level100Id) },
    buffer
  );
  assert.equal(res.status, 409);
  const body = await parseBody(res);
  assertError(body, "DEPARTMENT_NOT_ACTIVE");
});

test("department and level: nonexistent level is rejected", async () => {
  const buffer = await buildWorkbook([["Ada Import", "ADMIMP/001"]]);
  const res = await postMulti(
    "/api/admin/students/import/preview",
    adminTokenValue,
    { departmentId: String(dep1Id), levelId: "999999999" },
    buffer
  );
  assert.equal(res.status, 404);
  const body = await parseBody(res);
  assertError(body, "LEVEL_NOT_FOUND");
});

test("preview: valid previews create no records", async () => {
  const matrics = ["ADMIMP/001", "ADMIMP/002"];
  assert.equal(await countMatrics(matrics), 0);

  const { res } = await preview([
    ["Ada Import", "ADMIMP/001"],
    ["Bello Import", "ADMIMP/002"],
  ]);
  assert.equal(res.status, 200);

  assert.equal(await countMatrics(matrics), 0);
});

test("preview: invalid previews create no records and expose row numbers", async () => {
  const matrics = ["ADMIMP/001", "ADMIMP/002"];
  assert.equal(await countMatrics(matrics), 0);

  const { res, body } = await preview([
    ["Ada Import", "ADMIMP/001"],
    ["", "ADMIMP/002"],
  ]);
  assert.equal(res.status, 200);
  const data = body.data as { rows: Array<Record<string, unknown>> };
  assert.deepEqual(data.rows.map((r) => r.rowNumber), [2, 3]);

  assert.equal(await countMatrics(matrics), 0);
});

test("final import: a valid batch imports every row", async () => {
  const { res, body } = await preview([
    ["Ada Import", "ADMIMP/001"],
    ["Bello Import", "ADMIMP/002"],
    ["Chioma Import", "ADMIMP/003"],
  ]);
  assert.equal(res.status, 200);
  const data = body.data as { previewToken: string };

  const confirm = await postJson(
    "/api/admin/students/import",
    { previewToken: data.previewToken },
    cookieHeader(adminTokenValue)
  );
  assert.equal(confirm.status, 201);
  const confirmBody = await parseBody(confirm);
  assert.equal((confirmBody.data as { importedCount: number }).importedCount, 3);

  const students = await pool.query(
    `SELECT s.matric_number, s.department_id, s.level_id,
            u.name, u.role, u.status, u.password_hash
     FROM students s JOIN users u ON u.id = s.user_id
     WHERE s.matric_number = ANY($1::TEXT[])
     ORDER BY s.matric_number`,
    [["ADMIMP/001", "ADMIMP/002", "ADMIMP/003"]]
  );
  assert.equal(students.rowCount, 3);
  const byMatric = new Map(
    students.rows.map((row) => [row.matric_number as string, row])
  );
  for (const row of students.rows) {
    assert.equal(Number(row.department_id), dep1Id);
    assert.equal(Number(row.level_id), level100Id);
    assert.equal(row.role, "STUDENT");
    assert.equal(row.status, "PENDING");
    assert.equal(row.password_hash, null);
  }
  assert.equal(byMatric.get("ADMIMP/001").name, "Ada Import");
  assert.equal(byMatric.get("ADMIMP/002").name, "Bello Import");
  assert.equal(byMatric.get("ADMIMP/003").name, "Chioma Import");
});

test("final import: a consumed preview token cannot be reused", async () => {
  const { body } = await preview([["Rita Import", "ADMIMP/RITATOK"]]);
  const data = body.data as { previewToken: string };

  const first = await postJson(
    "/api/admin/students/import",
    { previewToken: data.previewToken },
    cookieHeader(adminTokenValue)
  );
  assert.equal(first.status, 201);

  const second = await postJson(
    "/api/admin/students/import",
    { previewToken: data.previewToken },
    cookieHeader(adminTokenValue)
  );
  assert.equal(second.status, 404);
  const secondBody = await parseBody(second);
  assertError(secondBody, "PREVIEW_NOT_FOUND");
});

test("final import: a batch with invalid rows creates zero records", async () => {
  const matrics = ["ADMIMP/INV1", "ADMIMP/INV2"];
  assert.equal(await countMatrics(matrics), 0);

  const { res, body } = await preview([
    ["Good Import", "ADMIMP/INV1"],
    ["", "ADMIMP/INV2"],
  ]);
  assert.equal(res.status, 200);
  const data = body.data as { previewToken: string };

  const confirm = await postJson(
    "/api/admin/students/import",
    { previewToken: data.previewToken },
    cookieHeader(adminTokenValue)
  );
  assert.equal(confirm.status, 409);
  const confirmBody = await parseBody(confirm);
  assertError(confirmBody, "INVALID_BATCH");

  assert.equal(await countMatrics(matrics), 0);
});

test("final import: a conflicting matric rolls back the entire batch", async () => {
  const batchMatrics = ["ADMIMP/RACE1", "ADMIMP/RACE2"];
  assert.equal(await countMatrics(batchMatrics), 0);

  const { res, body } = await preview([
    ["Race One", "ADMIMP/RACE1"],
    ["Race Two", "ADMIMP/RACE2"],
  ]);
  assert.equal(res.status, 200);
  const data = body.data as { previewToken: string };

  const raceUser = await pool.query(
    `INSERT INTO users (name, password_hash, role, status, username)
     VALUES ('Race Conflict User', $1, 'STUDENT', 'ACTIVE', NULL)
     RETURNING id`,
    [passwordHash]
  );
  await pool.query(
    `INSERT INTO students (user_id, matric_number, department_id, level_id)
     VALUES ($1, 'ADMIMP/RACE1', $2, $3)`,
    [Number(raceUser.rows[0].id), dep1Id, level100Id]
  );

  const confirm = await postJson(
    "/api/admin/students/import",
    { previewToken: data.previewToken },
    cookieHeader(adminTokenValue)
  );
  assert.equal(confirm.status, 409);
  const confirmBody = await parseBody(confirm);
  assertError(confirmBody, "CONFLICT");

  const after = await pool.query(
    `SELECT matric_number FROM students WHERE matric_number = ANY($1::TEXT[])`,
    [batchMatrics]
  );
  assert.deepEqual(
    after.rows.map((row) => row.matric_number as string).sort(),
    ["ADMIMP/RACE1"]
  );
});

test("department and level: imported students are attached to the chosen department and level", async () => {
  const buffer = await buildWorkbook([["Level Two Import", "ADMIMP/LEVEL200"]]);
  const res = await postMulti(
    "/api/admin/students/import/preview",
    adminTokenValue,
    { departmentId: String(dep1Id), levelId: String(level200Id) },
    buffer
  );
  const body2 = await parseBody(res);
  assert.equal(res.status, 200);
  const data2 = body2.data as { previewToken: string };
  assert.ok(data2.previewToken);

  const confirm = await postJson(
    "/api/admin/students/import",
    { previewToken: data2.previewToken },
    cookieHeader(adminTokenValue)
  );
  assert.equal(confirm.status, 201);

  const students = await pool.query(
    `SELECT department_id, level_id FROM students WHERE matric_number = 'ADMIMP/LEVEL200'`
  );
  assert.equal(students.rowCount, 1);
  assert.equal(Number(students.rows[0].department_id), dep1Id);
  assert.equal(Number(students.rows[0].level_id), level200Id);
});

test("template: the advertised template is a valid workbook with the expected columns", async () => {
  const res = await get(
    "/api/admin/students/import/template",
    cookieHeader(adminTokenValue)
  );
  assert.equal(res.status, 200);
  const contentType = res.headers.get("content-type") ?? "";
  assert.ok(contentType.includes("spreadsheetml"));

  const buffer = Buffer.from(await res.arrayBuffer());
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  assert.equal(workbook.worksheets.length, 1);
  const sheet = workbook.getWorksheet(1);
  assert.equal(sheet.name, "Students");
  assert.equal(sheet.getCell(1, 1).text, "Student Name");
  assert.equal(sheet.getCell(1, 2).text, "Matric Number");
  assert.equal(sheet.rowCount, 1);
});