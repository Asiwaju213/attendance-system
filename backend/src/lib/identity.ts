export const MAX_MATRIC_LENGTH = 100;

export function normalizeMatric(value: string): string {
  return value.trim().toUpperCase();
}