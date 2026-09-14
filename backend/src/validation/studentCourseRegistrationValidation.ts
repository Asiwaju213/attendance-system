export interface RegistrationSelectionInput {
  offeringIds: number[];
}

export function parseRegistrationSelection(
  body: unknown
): RegistrationSelectionInput | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return null;
  }
  const obj = body as Record<string, unknown>;
  if (!Array.isArray(obj.offeringIds)) {
    return null;
  }
  if (obj.offeringIds.length === 0) {
    return null;
  }

  const seen = new Set<number>();
  for (const value of obj.offeringIds) {
    if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
      return null;
    }
    if (seen.has(value)) {
      return null;
    }
    seen.add(value);
  }

  return { offeringIds: [...seen] };
}