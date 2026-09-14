const MIN_DURATION_MINUTES = 1;
const MAX_DURATION_MINUTES = 480;
const MIN_LATE_THRESHOLD_MINUTES = 0;
const MAX_LATE_THRESHOLD_MINUTES = 120;

export interface CreateAttendanceSessionInput {
  courseOfferingId: number;
  attendanceNetworkId: number;
  locationId: number;
  durationMinutes: number;
  lateThresholdMinutes: number;
}

function asObject(body: unknown): Record<string, unknown> | null {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return null;
  }
  return body as Record<string, unknown>;
}

function parseIntegerField(
  value: unknown,
  min: number,
  max: number
): number | null {
  if (typeof value === "number") {
    if (!Number.isInteger(value) || value < min || value > max) {
      return null;
    }
    return value;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!/^\d+$/.test(trimmed)) {
      return null;
    }
    const parsed = Number(trimmed);
    if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
      return null;
    }
    return parsed;
  }
  return null;
}

export function parseIdParam(value: unknown): number | null {
  return parseIntegerField(value, 1, Number.MAX_SAFE_INTEGER);
}

export function parseCreateAttendanceSession(
  body: unknown
): CreateAttendanceSessionInput | null {
  const obj = asObject(body);
  if (!obj) {
    return null;
  }

  const courseOfferingId = parseIntegerField(
    obj.courseOfferingId,
    1,
    Number.MAX_SAFE_INTEGER
  );
  const attendanceNetworkId = parseIntegerField(
    obj.attendanceNetworkId,
    1,
    Number.MAX_SAFE_INTEGER
  );
  const locationId = parseIntegerField(
    obj.locationId,
    1,
    Number.MAX_SAFE_INTEGER
  );
  const durationMinutes = parseIntegerField(
    obj.durationMinutes,
    MIN_DURATION_MINUTES,
    MAX_DURATION_MINUTES
  );
  const lateThresholdMinutes = parseIntegerField(
    obj.lateThresholdMinutes,
    MIN_LATE_THRESHOLD_MINUTES,
    MAX_LATE_THRESHOLD_MINUTES
  );

  if (
    courseOfferingId === null ||
    attendanceNetworkId === null ||
    locationId === null ||
    durationMinutes === null ||
    lateThresholdMinutes === null
  ) {
    return null;
  }

  if (lateThresholdMinutes > durationMinutes) {
    return null;
  }

  return {
    courseOfferingId,
    attendanceNetworkId,
    locationId,
    durationMinutes,
    lateThresholdMinutes,
  };
}