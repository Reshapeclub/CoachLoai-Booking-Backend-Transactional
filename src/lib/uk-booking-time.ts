import { DateTime } from "luxon";
import { HttpError } from "./http-error.js";

/** All member-facing booking windows and cutoffs use UK local (London) time. */
export const UK_BOOKING_TIMEZONE = "Europe/London";

export function ukBookingNow(): DateTime {
  return DateTime.now().setZone(UK_BOOKING_TIMEZONE);
}

export function ukBookingNowIso(): string {
  const iso = ukBookingNow().toUTC().toISO();
  if (!iso) throw new HttpError(500, "Failed to resolve current UK time");
  return iso;
}

/** Start of the current calendar day in UK (London), as UTC ISO for DB queries. */
export function ukTodayStartUtcIso(): string {
  const iso = ukBookingNow().startOf("day").toUTC().toISO();
  if (!iso) throw new HttpError(500, "Failed to resolve UK today start");
  return iso;
}

export function parseUkDateYmd(ymd: string): DateTime | null {
  const dt = DateTime.fromISO(ymd, { zone: UK_BOOKING_TIMEZONE }).startOf("day");
  return dt.isValid ? dt : null;
}

/** UTC ISO bounds for a calendar day in Europe/London (for DB timestamptz queries). */
export function ukDayBoundsUtcIso(ymd: string): { from: string; to: string } | null {
  const day = parseUkDateYmd(ymd);
  if (!day) return null;
  const from = day.toUTC().toISO();
  const to = day.plus({ days: 1 }).toUTC().toISO();
  if (!from || !to) return null;
  return { from, to };
}

export function maxIso(a: string, b: string): string {
  return new Date(a).getTime() >= new Date(b).getTime() ? a : b;
}

export function isStartInPast(startAtIso: string, nowIso?: string): boolean {
  const startMs = new Date(startAtIso).getTime();
  const nowMs = new Date(nowIso ?? ukBookingNowIso()).getTime();
  if (Number.isNaN(startMs)) return true;
  return startMs <= nowMs;
}

export function assertBookableStartNotPast(startAtIso: string, nowIso?: string): void {
  if (Number.isNaN(new Date(startAtIso).getTime())) {
    throw new HttpError(400, "Invalid start time");
  }
  if (isStartInPast(startAtIso, nowIso)) {
    throw new HttpError(
      400,
      "You cannot book a session or meeting that has already started/completed.",
    );
  }
}

const MS_PER_DAY = 86_400_000;

/** Weeks in each `getSessionUsage` window (Monday–Sunday, UTC — matches `clm_current_week_start`). */
export const SESSION_USAGE_PAST_WEEKS = 4;
export const SESSION_USAGE_UPCOMING_WEEKS = 4;

/** Monday 00:00:00.000 UTC for the week containing `iso`. */
export function utcWeekStartMs(iso: string): number {
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) throw new HttpError(400, "Invalid datetime");
  const dow = t.getUTCDay();
  const mondayOffset = dow === 0 ? -6 : 1 - dow;
  return Date.UTC(
    t.getUTCFullYear(),
    t.getUTCMonth(),
    t.getUTCDate() + mondayOffset,
    0,
    0,
    0,
    0,
  );
}

/**
 * Session usage query window:
 * - upcoming: current week Monday → Sunday at end of the 4th week (e.g. 25 May–21 Jun)
 * - past: Monday 4 weeks before current → Sunday before current week (e.g. 27 Apr–24 May)
 */
export function sessionUsageWeekRange(
  view: "past" | "upcoming",
  nowIso?: string,
): { rangeStart: Date; rangeEnd: Date } {
  const currentMondayMs = utcWeekStartMs(nowIso ?? ukBookingNowIso());
  const spanMs = SESSION_USAGE_UPCOMING_WEEKS * 7 * MS_PER_DAY;

  if (view === "past") {
    const pastSpanMs = SESSION_USAGE_PAST_WEEKS * 7 * MS_PER_DAY;
    return {
      rangeStart: new Date(currentMondayMs - pastSpanMs),
      rangeEnd: new Date(currentMondayMs - 1),
    };
  }

  return {
    rangeStart: new Date(currentMondayMs),
    rangeEnd: new Date(currentMondayMs + spanMs - 1),
  };
}
