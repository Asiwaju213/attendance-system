export interface ImportFormInput {
  departmentId: number;
  levelId: number;
}

function parseIdString(value: unknown): number | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) {
    return null;
  }
  const parsed = Number(trimmed);
  return Number.isSafeInteger(parsed) && parsed >= 1 ? parsed : null;
}

export function parseImportFormFields(fields: Record<string, unknown>): ImportFormInput | null {
  const departmentId = parseIdString(fields.departmentId);
  const levelId = parseIdString(fields.levelId);
  if (!departmentId || !levelId) {
    return null;
  }
  return { departmentId, levelId };
}

export function parsePreviewToken(body: unknown): string | null {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return null;
  }
  const token = (body as Record<string, unknown>).previewToken;
  if (typeof token !== "string") {
    return null;
  }
  const trimmed = token.trim();
  if (trimmed.length === 0 || trimmed.length > 200) {
    return null;
  }
  return trimmed;
}