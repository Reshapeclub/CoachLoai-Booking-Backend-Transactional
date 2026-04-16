import { supabaseAdmin } from "../db/supabase.js";
import { HttpError } from "../lib/http-error.js";

/**
 * Validates coach eligibility and scheduling constraints when assigning a coach to a session.
 */
export async function validateCoachForSession(opts: {
  coachUserId: string;
  sessionTypeId: string;
  locationId: string | null;
  startAt: string;
  endAt: string;
  excludeSessionId?: string;
  allowOvertime?: boolean;
}): Promise<void> {
  const start = new Date(opts.startAt);
  const end = new Date(opts.endAt);
  if (end <= start) throw new HttpError(400, "endAt must be after startAt");

  // 1. Fetch coach + profile (for location_id, weekly_hour_limit_mins, travel_buffer_minutes)
  const { data: coach, error: coachErr } = await supabaseAdmin
    .from("coaches")
    .select("*, profiles!coaches_user_id_fkey(id, location_id)")
    .eq("user_id", opts.coachUserId)
    .single();
  if (coachErr || !coach) throw new HttpError(404, "Coach not found");
  const profile = (coach as { profiles?: { location_id?: string | null } }).profiles;
  const coachLocationId = profile?.location_id ?? null;
  const weeklyLimit = (coach as { weekly_hour_limit_mins: number }).weekly_hour_limit_mins;
  const travelBufferMins = (coach as { travel_buffer_minutes: number }).travel_buffer_minutes;

  // 2. Within availability windows (day_of_week 1=Mon..7=Sun, start_mins/end_mins)
  const dow = start.getUTCDay(); // 0=Sun, 1=Mon, ..., 6=Sat
  const dayOfWeek = dow === 0 ? 7 : dow; // 1=Mon .. 7=Sun
  const startMins = start.getUTCHours() * 60 + start.getUTCMinutes();
  const endMins = end.getUTCHours() * 60 + end.getUTCMinutes();

  const { data: availRows } = await supabaseAdmin
    .from("coach_availability")
    .select("start_mins, end_mins")
    .eq("coach_user_id", opts.coachUserId)
    .eq("day_of_week", dayOfWeek);
  const hasSlots = (availRows ?? []).length > 0;
  const withinAvailability =
    hasSlots &&
    (availRows ?? []).some(
      (r: { start_mins: number; end_mins: number }) => startMins >= r.start_mins && endMins <= r.end_mins
    );
  if (hasSlots && !withinAvailability)
    throw new HttpError(400, "Session time is outside coach availability windows");

  // 3. Not during approved holiday
  const { data: holidays } = await supabaseAdmin
    .from("coach_holidays")
    .select("start_at, end_at")
    .eq("coach_user_id", opts.coachUserId);
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

  // 5. Location match (coach's location or session location; if both set, they must match)
  if (opts.locationId && coachLocationId && opts.locationId !== coachLocationId)
    throw new HttpError(400, "Session location does not match coach location");

  // 6. No overlapping sessions for same coach
  let overlapQuery = supabaseAdmin
    .from("sessions")
    .select("id")
    .eq("coach_user_id", opts.coachUserId)
    .lt("start_at", opts.endAt)
    .gt("end_at", opts.startAt);
  if (opts.excludeSessionId) overlapQuery = overlapQuery.neq("id", opts.excludeSessionId);
  const { data: overlapping } = await overlapQuery;
  if ((overlapping ?? []).length > 0)
    throw new HttpError(400, "Session overlaps with another session for this coach");

  // 7. Travel buffer between different locations
  const { data: otherSessions } = await supabaseAdmin
    .from("sessions")
    .select("id, start_at, end_at, location_id")
    .eq("coach_user_id", opts.coachUserId);
  if (opts.excludeSessionId) {
    const filtered = (otherSessions ?? []).filter((s: { id: string }) => s.id !== opts.excludeSessionId);
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
    for (const s of otherSessions ?? []) {
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
      .eq("coach_user_id", opts.coachUserId)
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
function getWeekStart(iso: string): Date {
  const d = new Date(iso);
  const dow = d.getUTCDay();
  const diff = dow === 0 ? 6 : dow - 1; // days back to Monday
  const monday = new Date(d);
  monday.setUTCDate(monday.getUTCDate() - diff);
  monday.setUTCHours(0, 0, 0, 0);
  return monday;
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
