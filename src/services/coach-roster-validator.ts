import { DateTime } from "luxon";
import { supabaseAdmin } from "../db/supabase.js";
import { HttpError } from "../lib/http-error.js";

/**
 * Validates coach eligibility and scheduling constraints when assigning a coach to a session.
 */
export async function validateCoachForSession(opts: {
  coachId: string;
  sessionTypeId: string;
  locationId: string | null;
  startAt: string;
  endAt: string;
  excludeSessionId?: string;
  allowOvertime?: boolean;
  ignoreSessionIds?: string[];
}): Promise<void> {
  const start = new Date(opts.startAt);
  const end = new Date(opts.endAt);
  if (end <= start) throw new HttpError(400, "endAt must be after startAt");

  // 1. Fetch coach and limits.
  const { data: coach, error: coachErr } = await supabaseAdmin
    .from("coaches")
    .select("id, user_id, weekly_hour_limit_mins, travel_buffer_minutes")
    .eq("id", opts.coachId)
    .single();
  if (coachErr || !coach) throw new HttpError(404, "Coach not found");
  const coachUserId = (coach as { user_id: string | number }).user_id;
  const weeklyLimit = (coach as { weekly_hour_limit_mins: number }).weekly_hour_limit_mins;
  const travelBufferMins = (coach as { travel_buffer_minutes: number }).travel_buffer_minutes;
  const ignoredSessionIdSet = new Set((opts.ignoreSessionIds ?? []).map((x) => String(x)));

  // 2. Within availability windows (day_of_week 1=Mon..7=Sun, start_mins/end_mins).
  // Availability is configured in UK local business time (Europe/London), not UTC.
  const startLocal = toLondonParts(start);
  const endLocal = toLondonParts(end);
  const dayOfWeek = startLocal.dayOfWeek;
  const startMins = startLocal.minutesFromMidnight;
  const endMins = endLocal.minutesFromMidnight;
  const sessionWeekStart = getWeekStartDateOnly(opts.startAt);

  const { data: weekRows, error: weekErr } = await supabaseAdmin
    .from("coach_availability")
    .select("start_mins, end_mins, location_id, break_start_mins, break_duration_mins")
    .eq("coach_id", opts.coachId)
    .eq("day_of_week", dayOfWeek)
    .eq("week_start_date", sessionWeekStart)
    .eq("kind", "session");
  if (weekErr) throw new HttpError(500, "Failed to fetch coach weekly availability", weekErr);
  let availRows = weekRows ?? [];
  if (availRows.length === 0) {
    const { data: defaultRows, error: defaultErr } = await supabaseAdmin
      .from("coach_availability")
      .select("start_mins, end_mins, location_id, break_start_mins, break_duration_mins")
      .eq("coach_id", opts.coachId)
      .eq("day_of_week", dayOfWeek)
      .is("week_start_date", null)
      .eq("kind", "session");
    if (defaultErr) throw new HttpError(500, "Failed to fetch coach default availability", defaultErr);
    availRows = defaultRows ?? [];
  }
  const hasSlots = (availRows ?? []).length > 0;
  const withinAvailability =
    hasSlots &&
    (availRows ?? []).some(
      (r: {
        start_mins: number;
        end_mins: number;
        location_id?: string | null;
        break_start_mins?: number | null;
        break_duration_mins?: number | null;
      }) => {
        const timeOk = startMins >= r.start_mins && endMins <= r.end_mins;
        if (!timeOk) return false;
        const bd = r.break_duration_mins;
        const bs = r.break_start_mins;
        if (bd != null && bd > 0 && bs != null) {
          const b0 = Number(bs);
          const b1 = b0 + Number(bd);
          if (startMins < b1 && endMins > b0) return false;
        }
        if (!opts.locationId) return true;
        const winLoc = r.location_id;
        if (!winLoc) return true;
        return winLoc === opts.locationId;
      },
    );
  if (!hasSlots)
    throw new HttpError(400, "Coach has no availability windows for this day");
  if (!withinAvailability)
    throw new HttpError(
      400,
      "This coach is on break during the selected session time, or the slot is outside their rota windows. Please choose another time or coach.",
    );

  // 3. Not during approved holiday
  const { data: holidays } = await supabaseAdmin
    .from("coach_holidays")
    .select("start_at, end_at")
    .eq("coach_id", opts.coachId);
  const overlapsHoliday = (holidays ?? []).some((h: { start_at: string; end_at: string }) => {
    const hStart = new Date(h.start_at).getTime();
    const hEnd = new Date(h.end_at).getTime();
    return start.getTime() < hEnd && end.getTime() > hStart;
  });
  if (overlapsHoliday) throw new HttpError(400, "Session overlaps with coach holiday");

  // 4. Session type permitted for coach
  // const { data: allowed } = await supabaseAdmin
  //   .from("coach_allowed_session_types")
  //   .select("id")
  //   .eq("coach_user_id", opts.coachUserId)
  //   .eq("session_type_id", opts.sessionTypeId)
  //   .maybeSingle();
  // if (!allowed)
  //   throw new HttpError(400, "Session type is not permitted for this coach");

  // 5. Location access match: coach must have access to session location.
  if (opts.locationId) {
    const { data: access, error: accessErr } = await supabaseAdmin
      .from("admin_location_access")
      .select("location_id")
      .eq("admin_id", coachUserId)
      .eq("location_id", opts.locationId)
      .maybeSingle();
    if (accessErr) throw new HttpError(500, "Failed to verify coach location access", accessErr);
    if (!access) throw new HttpError(400, "Session location is not assigned to this coach");
  }

  // 6. No overlapping sessions for same coach
  let overlapQuery = supabaseAdmin
    .from("sessions")
    .select("id")
    .eq("coach_id", opts.coachId)
    .eq("is_cancelled", false)
    .is("deleted_at", null)
    .lt("start_at", opts.endAt)
    .gt("end_at", opts.startAt);
  if (opts.excludeSessionId) overlapQuery = overlapQuery.neq("id", opts.excludeSessionId);
  const { data: overlapping } = await overlapQuery;
  const realOverlaps = (overlapping ?? []).filter((row: { id?: string }) => !ignoredSessionIdSet.has(String(row.id ?? "")));
  if (realOverlaps.length > 0)
    throw new HttpError(400, "Session overlaps with another session for this coach");

  // 7. Travel buffer between different locations
  const { data: otherSessions } = await supabaseAdmin
    .from("sessions")
    .select("id, start_at, end_at, location_id")
    .eq("coach_id", opts.coachId)
    .eq("is_cancelled", false)
    .is("deleted_at", null);
  if (opts.excludeSessionId) {
    const filtered = (otherSessions ?? []).filter(
      (s: { id: string }) => s.id !== opts.excludeSessionId && !ignoredSessionIdSet.has(String(s.id)),
    );
    for (const s of filtered) {
      const bufCheck = checkTravelBuffer(
        opts.startAt,
        opts.endAt,
        opts.locationId,
        s.start_at,
        s.end_at,
        s.location_id,
        travelBufferMins
      );
      if (bufCheck) throw new HttpError(400, bufCheck);
    }
  } else {
    for (const s of (otherSessions ?? []).filter((row: { id: string }) => !ignoredSessionIdSet.has(String(row.id)))) {
      const bufCheck = checkTravelBuffer(
        opts.startAt,
        opts.endAt,
        opts.locationId,
        s.start_at,
        s.end_at,
        s.location_id,
        travelBufferMins
      );
      if (bufCheck) throw new HttpError(400, bufCheck);
    }
  }

  // 8. Weekly hour limit (unless allowOvertime)
  if (!opts.allowOvertime) {
    const weekStart = getWeekStart(opts.startAt);
    const weekEnd = new Date(weekStart);
    weekEnd.setUTCDate(weekEnd.getUTCDate() + 7);

    const { data: weekSessions } = await supabaseAdmin
      .from("sessions")
      .select("start_at, end_at")
      .eq("coach_id", opts.coachId)
      .eq("is_cancelled", false)
      .is("deleted_at", null)
      .gte("start_at", weekStart.toISOString())
      .lt("start_at", weekEnd.toISOString());

    let totalMins = (end.getTime() - start.getTime()) / 60_000;
    for (const sess of weekSessions ?? []) {
      const sStart = new Date((sess as { start_at: string }).start_at).getTime();
      const sEnd = new Date((sess as { end_at: string }).end_at).getTime();
      totalMins += (sEnd - sStart) / 60_000;
    }
    if (totalMins > weeklyLimit)
      throw new HttpError(400, `Weekly hour limit exceeded (${Math.round(totalMins)} mins > ${weeklyLimit} mins)`);
  }
}

/** Monday 00:00 UTC for the week containing the given ISO datetime */
// function getWeekStart(iso: string): Date {
//   const d = new Date(iso);
//   const dow = d.getUTCDay();
//   const diff = dow === 0 ? 6 : dow - 1; // days back to Monday
//   const monday = new Date(d);
//   monday.setUTCDate(monday.getUTCDate() - diff);
//   monday.setUTCHours(0, 0, 0, 0);
//   return monday;
// }

// function getWeekStartDateOnly(iso: string): string {
//   return getWeekStart(iso).toISOString().slice(0, 10);
// }
function getWeekStart(iso: string): Date {
  return DateTime
    .fromISO(iso, { zone: "utc" })     // input is UTC
    .setZone("Europe/London")          // convert to London
    .startOf("week")                   // Monday 00:00 (ISO)
    .toJSDate();
}

function getWeekStartDateOnly(iso: string): string {
  const weekStart = DateTime
    .fromISO(iso, { zone: "utc" })
    .setZone("Europe/London")
    .startOf("week")
    .toISODate(); // YYYY-MM-DD
  if (!weekStart) throw new Error(`Invalid ISO date: ${iso}`);
  return weekStart;
}
function toLondonParts(d: Date): { dayOfWeek: number; minutesFromMidnight: number } {
  const weekday = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    weekday: "short",
  }).format(d);
  const time = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(d);

  const dayMap: Record<string, number> = {
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
    Sun: 7,
  };
  const dayOfWeek = dayMap[weekday] ?? 1;
  const [hh, mm] = time.split(":").map((x) => Number(x));
  return { dayOfWeek, minutesFromMidnight: (hh || 0) * 60 + (mm || 0) };
}

function checkTravelBuffer(
  newStart: string,
  newEnd: string,
  newLoc: string | null,
  otherStart: string,
  otherEnd: string,
  otherLoc: string | null,
  bufferMins: number
): string | null {
  if (!newLoc || !otherLoc || newLoc === otherLoc) return null;
  const nStart = new Date(newStart).getTime();
  const nEnd = new Date(newEnd).getTime();
  const oStart = new Date(otherStart).getTime();
  const oEnd = new Date(otherEnd).getTime();
  const mins = (t: number) => t / 60_000;
  if (oEnd <= nStart) {
    const gap = mins(nStart - oEnd);
    if (gap < bufferMins) return `Travel buffer required: ${bufferMins} mins between sessions at different locations`;
  }
  if (nEnd <= oStart) {
    const gap = mins(oStart - nEnd);
    if (gap < bufferMins) return `Travel buffer required: ${bufferMins} mins between sessions at different locations`;
  }
  return null;
}
