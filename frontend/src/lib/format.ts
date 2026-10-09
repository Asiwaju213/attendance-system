/**
 * Shared display formatting.
 *
 * Dates, counts, percentages and status values are rendered on many pages.
 * Keeping the rules here stops one page from drifting into its own variant of
 * the same formatting.
 */

/** Stands in for a value the server has not recorded. */
export const NOT_AVAILABLE = "Not available";

export function formatDateTime(value: string): string {
  return new Date(value).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

export function formatTimeOnly(value: string): string {
  return new Date(value).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Formats a timestamp, or `NOT_AVAILABLE` when the value is missing. */
export function formatDateTimeOrNotAvailable(value: string | null): string {
  return value === null ? NOT_AVAILABLE : formatDateTime(value);
}

/**
 * Renders an API status value for a person, so `INACTIVE` reads as "Inactive"
 * and `NOT_MARKED` reads as "Not marked".
 */
export function statusLabel(status: string): string {
  const [first = "", ...rest] = status.toLowerCase().split("_");
  const head = first.charAt(0).toUpperCase() + first.slice(1);
  return [head, ...rest].join(" ");
}

export function countLabel(
  count: number,
  singular: string,
  plural: string
): string {
  return count === 1 ? `1 ${singular}` : `${count} ${plural}`;
}

/**
 * Formats an attendance percentage, or `NOT_AVAILABLE` when there is no
 * completed session to calculate it from.
 */
export function formatPercentage(value: number | null): string {
  return value === null ? NOT_AVAILABLE : `${value.toFixed(2)}%`;
}