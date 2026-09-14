import path from "node:path";
import { NextFunction, Request, Response, Router } from "express";
import multer from "multer";
import { buildStudentImportTemplate, IMPORT_LIMITS } from "../lib/excel";
import { requireAdmin, requireAuth } from "../middleware/authenticate";
import { ImportErrorCode } from "../services/studentImportStore";
import { confirmImport, previewImport } from "../services/studentImportStore";
import { parseImportFormFields, parsePreviewToken } from "../validation/studentImportValidation";

const router = Router();

router.use(requireAuth, requireAdmin);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: IMPORT_LIMITS.maxFileSizeBytes, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (path.extname(file.originalname).toLowerCase() !== ".xlsx") {
      cb(new Error("UNSUPPORTED_FILE_TYPE"));
      return;
    }
    cb(null, true);
  },
});

function uploadSingleFile(): (req: Request, res: Response, next: NextFunction) => void {
  const middleware = upload.single("file");
  return (req, res, next) => {
    middleware(req, res, (err: unknown) => {
      if (err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE") {
        res.status(413).json({
          error: "FILE_TOO_LARGE",
          message: `The uploaded file exceeds the ${Math.floor(IMPORT_LIMITS.maxFileSizeBytes / (1024 * 1024))} MB limit.`,
        });
        return;
      }
      if (err instanceof Error && err.message === "UNSUPPORTED_FILE_TYPE") {
        res.status(400).json({
          error: "UNSUPPORTED_FILE_TYPE",
          message: "The uploaded file must be an .xlsx workbook.",
        });
        return;
      }
      if (err) {
        res.status(400).json({
          error: "INVALID_REQUEST",
          message: "Could not read the uploaded file.",
        });
        return;
      }
      next();
    });
  };
}

function sendInvalidRequest(res: Response, message: string): void {
  res.status(400).json({ error: "INVALID_REQUEST", message });
}

function sendErrorCode(res: Response, code: ImportErrorCode): void {
  switch (code) {
    case "DEPARTMENT_NOT_FOUND":
      res.status(404).json({ error: "DEPARTMENT_NOT_FOUND", message: "The department does not exist." });
      return;
    case "DEPARTMENT_NOT_ACTIVE":
      res
        .status(409)
        .json({ error: "DEPARTMENT_NOT_ACTIVE", message: "An inactive department cannot receive new students." });
      return;
    case "LEVEL_NOT_FOUND":
      res.status(404).json({ error: "LEVEL_NOT_FOUND", message: "The level does not exist." });
      return;
    case "INVALID_FILE":
      res
        .status(400)
        .json({ error: "INVALID_FILE", message: "The uploaded file could not be read as an .xlsx workbook." });
      return;
    case "EMPTY_FILE":
      res.status(400).json({ error: "EMPTY_FILE", message: "The workbook contains no worksheets or student data." });
      return;
    case "MISSING_COLUMNS":
      res
        .status(400)
        .json({
          error: "MISSING_COLUMNS",
          message: "The workbook must contain 'Student Name' and 'Matric Number' columns as the first row.",
        });
      return;
    case "TOO_MANY_ROWS":
      res
        .status(400)
        .json({
          error: "TOO_MANY_ROWS",
          message: `The workbook exceeds the ${IMPORT_LIMITS.maxRows} student row limit.`,
        });
      return;
    case "PREVIEW_NOT_FOUND":
      res
        .status(404)
        .json({ error: "PREVIEW_NOT_FOUND", message: "The preview is invalid, expired, or already used." });
      return;
    case "INVALID_BATCH":
      res
        .status(409)
        .json({
          error: "INVALID_BATCH",
          message: "The import contains invalid student rows. Fix the file and re-upload it.",
        });
      return;
    case "CONFLICT":
      res
        .status(409)
        .json({ error: "CONFLICT", message: "At least one matric number already belongs to another student." });
      return;
  }
}

router.get("/students/import/template", async (_req: Request, res: Response) => {
  const buffer = await buildStudentImportTemplate();
  res
    .status(200)
    .set("content-type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
    .set("content-disposition", "attachment; filename=students-import-template.xlsx")
    .send(buffer);
});

router.post("/students/import/preview", uploadSingleFile(), async (req: Request, res: Response) => {
  const form = parseImportFormFields(req.body as Record<string, unknown>);
  if (!form) {
    sendInvalidRequest(res, "A valid departmentId and levelId are required.");
    return;
  }
  if (!req.file) {
    sendInvalidRequest(res, "An .xlsx file is required.");
    return;
  }

  const result = await previewImport(form.departmentId, form.levelId, req.file.buffer);
  if (!result.ok) {
    sendErrorCode(res, result.code);
    return;
  }

  res.status(200).json({ data: result.data });
});

router.post("/students/import", async (req: Request, res: Response) => {
  const previewToken = parsePreviewToken(req.body);
  if (!previewToken) {
    sendInvalidRequest(res, "A valid previewToken is required.");
    return;
  }

  const result = await confirmImport(previewToken);
  if (!result.ok) {
    sendErrorCode(res, result.code);
    return;
  }

  res.status(201).json({ data: result.data });
});

export default router;