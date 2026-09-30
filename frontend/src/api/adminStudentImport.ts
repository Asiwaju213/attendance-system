import { ApiError } from "./client";
import type {
  StudentImportPreview,
  StudentImportResult,
} from "../types/adminStudentImport";

const TEMPLATE_FILENAME = "students-import-template.xlsx";

/**
 * An ApiError that also surfaces the server-provided message (when present).
 * The import endpoints return user-visible messages that carry authoritative
 * constraints (for example the exact upload limit), so the page prefers them
 * over locally-invented text.
 */
export class StudentImportApiError extends ApiError {
  readonly serverMessage: string | null;

  constructor(status: number, code: string | null, serverMessage: string | null = null) {
    super(status, code);
    this.name = "StudentImportApiError";
    this.serverMessage = serverMessage;
  }
}

async function throwImportError(response: Response): Promise<never> {
  let code: string | null = null;
  let serverMessage: string | null = null;
  try {
    const payload = (await response.json()) as { error?: unknown; message?: unknown };
    if (typeof payload.error === "string" && payload.error.length > 0) {
      code = payload.error;
    }
    if (typeof payload.message === "string" && payload.message.length > 0) {
      serverMessage = payload.message;
    }
  } catch {
    // Non-JSON error bodies carry no code or message.
  }
  throw new StudentImportApiError(response.status, code, serverMessage);
}

export async function downloadStudentImportTemplate(): Promise<void> {
  const response = await fetch("/api/admin/students/import/template", {
    credentials: "include",
  });
  if (!response.ok) {
    await throwImportError(response);
  }

  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  try {
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = TEMPLATE_FILENAME;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  } finally {
    URL.revokeObjectURL(url);
  }
}

export interface StudentImportPreviewRequest {
  departmentId: string;
  levelId: string;
  file: File;
}

export async function previewStudentImport(
  request: StudentImportPreviewRequest
): Promise<{ data: StudentImportPreview }> {
  const form = new FormData();
  form.append("departmentId", request.departmentId);
  form.append("levelId", request.levelId);
  form.append("file", request.file, request.file.name);

  const response = await fetch("/api/admin/students/import/preview", {
    method: "POST",
    credentials: "include",
    body: form,
  });
  if (!response.ok) {
    await throwImportError(response);
  }
  return (await response.json()) as { data: StudentImportPreview };
}

export async function confirmStudentImport(
  previewToken: string
): Promise<{ data: StudentImportResult }> {
  const response = await fetch("/api/admin/students/import", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ previewToken }),
  });
  if (!response.ok) {
    await throwImportError(response);
  }
  return (await response.json()) as { data: StudentImportResult };
}