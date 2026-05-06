import { supabaseAdmin } from "../db/supabase.js";
import { HttpError } from "../lib/http-error.js";

export class CoachService {
  private coachesListCache:
    | { expiresAt: number; value: Array<Record<string, unknown>> }
    | null = null;

  private invalidateCoachesListCache() {
    this.coachesListCache = null;
  }

  async listCoaches() {
    const now = Date.now();
    if (this.coachesListCache && this.coachesListCache.expiresAt > now) {
      return this.coachesListCache.value;
    }

    const { data, error } = await supabaseAdmin
      .from("coaches")
      .select(
        "id, user_id, weekly_hour_limit_mins, travel_buffer_minutes, created_at, admins!coaches_user_id_fkey(id, name, email, role, location_id, photo_url)",
      )
      .order("created_at", { ascending: true });
    if (error) throw new HttpError(500, "Failed to fetch coaches", error);
    const coaches = data ?? [];
    if (coaches.length === 0) return coaches;
    const adminIds = coaches
      .map((c) => (c as { user_id?: string | number }).user_id)
      .filter((id): id is string | number => id !== undefined && id !== null);
    if (adminIds.length === 0) {
      this.coachesListCache = {
        expiresAt: now + 10_000,
        value: coaches as Array<Record<string, unknown>>,
      };
      return coaches;
    }
    const { data: accessRows, error: accessErr } = await supabaseAdmin
      .from("admin_location_access")
      .select("admin_id, location_id")
      .in("admin_id", adminIds);
    if (accessErr) throw new HttpError(500, "Failed to fetch coach location access", accessErr);
    const locsByAdmin = new Map<string, string[]>();
    for (const row of accessRows ?? []) {
      const key = String(row.admin_id);
      const arr = locsByAdmin.get(key) ?? [];
      arr.push(row.location_id);
      locsByAdmin.set(key, arr);
    }
    const enriched = coaches.map((coach) => ({
      ...coach,
      location_ids: locsByAdmin.get(String((coach as { user_id: string | number }).user_id)) ?? [],
    }));
    this.coachesListCache = {
      expiresAt: now + 10_000,
      value: enriched as Array<Record<string, unknown>>,
    };
    return enriched;
  }

  async getCoach(coachUserId: string) {
    const { data, error } = await supabaseAdmin
      .from("coaches")
      .select("*, admins!coaches_user_id_fkey(id, name, email, location_id)")
      .eq("id", coachUserId)
      .single();
    if (error) throw new HttpError(404, "Coach not found", error);
    const adminId = (data as { user_id: string | number }).user_id;
    const { data: accessRows, error: accessErr } = await supabaseAdmin
      .from("admin_location_access")
      .select("location_id")
      .eq("admin_id", adminId);
    if (accessErr) throw new HttpError(500, "Failed to fetch coach location access", accessErr);
    return {
      ...data,
      location_ids: (accessRows ?? []).map((row) => row.location_id),
    };
  }

  async createCoach(input: {
    userId: number;
    weeklyHourLimitMins?: number;
    travelBufferMinutes?: number;
  }) {
    const { data: admin, error: adminErr } = await supabaseAdmin
      .from("admins")
      .select("id")
      .eq("id", input.userId)
      .single();
    if (adminErr || !admin) throw new HttpError(404, "Admin not found");

    const { data, error } = await supabaseAdmin
      .from("coaches")
      .insert({
        user_id: input.userId,
        weekly_hour_limit_mins: input.weeklyHourLimitMins ?? 2400,
        travel_buffer_minutes: input.travelBufferMinutes ?? 30,
      })
      .select()
      .single();
    if (error) throw new HttpError(500, "Failed to create coach", error);
    this.invalidateCoachesListCache();
    return data;
  }

  async updateCoach(
    coachUserId: string,
    input: { weeklyHourLimitMins?: number; travelBufferMinutes?: number }
  ) {
    const updates: Record<string, unknown> = {};
    if (input.weeklyHourLimitMins !== undefined) updates.weekly_hour_limit_mins = input.weeklyHourLimitMins;
    if (input.travelBufferMinutes !== undefined) updates.travel_buffer_minutes = input.travelBufferMinutes;
    if (Object.keys(updates).length === 0) throw new HttpError(400, "No fields to update");

    const { data, error } = await supabaseAdmin
      .from("coaches")
      .update(updates)
      .eq("id", coachUserId)
      .select()
      .single();
    if (error) throw new HttpError(500, "Failed to update coach", error);
    this.invalidateCoachesListCache();
    return data;
  }

  async deleteCoach(coachUserId: string) {
    const { error } = await supabaseAdmin.from("coaches").delete().eq("id", coachUserId);
    if (error) throw new HttpError(500, "Failed to delete coach", error);
    this.invalidateCoachesListCache();
    return { ok: true };
  }

  async addCoachAvailability(input: {
    coachUserId: string;
    dayOfWeek: number;
    startMins: number;
    endMins: number;
    weekStartDate?: string;
  }) {
    const { data, error } = await supabaseAdmin
      .from("coach_availability")
      .insert({
        coach_id: input.coachUserId,
        week_start_date: input.weekStartDate ?? null,
        day_of_week: input.dayOfWeek,
        start_mins: input.startMins,
        end_mins: input.endMins,
      })
      .select()
      .single();
    if (error) throw new HttpError(500, "Failed to add coach availability", error);
    return data;
  }

  async removeCoachAvailability(availabilityId: string) {
    const { error } = await supabaseAdmin.from("coach_availability").delete().eq("id", availabilityId);
    if (error) throw new HttpError(500, "Failed to remove coach availability", error);
    return { ok: true };
  }

  async getCoachAvailability(coachUserId: string, weekStartDate?: string) {
    if (weekStartDate) {
      const { data: weekRows, error: weekErr } = await supabaseAdmin
        .from("coach_availability")
        .select("*")
        .eq("coach_id", coachUserId)
        .eq("week_start_date", weekStartDate)
        .order("day_of_week", { ascending: true })
        .order("start_mins", { ascending: true });
      if (weekErr) throw new HttpError(500, "Failed to fetch coach weekly availability", weekErr);
      if ((weekRows ?? []).length > 0) return weekRows ?? [];
    }

    const { data: defaultRows, error: defaultErr } = await supabaseAdmin
      .from("coach_availability")
      .select("*")
      .eq("coach_id", coachUserId)
      .is("week_start_date", null)
      .order("day_of_week", { ascending: true })
      .order("start_mins", { ascending: true });
    if (defaultErr) throw new HttpError(500, "Failed to fetch coach default availability", defaultErr);
    return defaultRows ?? [];
  }

  /**
   * Replaces all availability windows for a coach (admin rota / weekly pattern).
   * A day with no windows in `windows` is effectively OFF (old rows for that day are removed by the delete,
   * then not re-inserted). `windows: []` clears the whole week.
   */
  async replaceCoachAvailability(
    coachId: string,
    windows: { dayOfWeek: number; startMins: number; endMins: number }[],
    weekStartDate?: string
  ) {
    let deleteQuery = supabaseAdmin.from("coach_availability").delete().eq("coach_id", coachId);
    if (weekStartDate) deleteQuery = deleteQuery.eq("week_start_date", weekStartDate);
    else deleteQuery = deleteQuery.is("week_start_date", null);
    const { error: delErr } = await deleteQuery;
    if (delErr) throw new HttpError(500, "Failed to clear coach availability", delErr);
    if (windows.length === 0) return [];
    const { data, error } = await supabaseAdmin
      .from("coach_availability")
      .insert(
        windows.map((w) => ({
          coach_id: coachId,
          week_start_date: weekStartDate ?? null,
          day_of_week: w.dayOfWeek,
          start_mins: w.startMins,
          end_mins: w.endMins,
        }))
      )
      .select();
    if (error) throw new HttpError(500, "Failed to set coach availability", error);
    return data ?? [];
  }

  async addCoachHoliday(input: { coachUserId: string; startAt: string; endAt: string }) {
    const { data, error } = await supabaseAdmin
      .from("coach_holidays")
      .insert({
        coach_id: input.coachUserId,
        start_at: input.startAt,
        end_at: input.endAt,
      })
      .select()
      .single();
    if (error) throw new HttpError(500, "Failed to add coach holiday", error);
    return data;
  }

  async removeCoachHoliday(holidayId: string) {
    const { error } = await supabaseAdmin.from("coach_holidays").delete().eq("id", holidayId);
    if (error) throw new HttpError(500, "Failed to remove coach holiday", error);
    return { ok: true };
  }

  async getCoachHolidays(coachUserId: string) {
    const { data, error } = await supabaseAdmin
      .from("coach_holidays")
      .select("*")
      .eq("coach_id", coachUserId)
      .order("start_at", { ascending: true });
    if (error) throw new HttpError(500, "Failed to fetch coach holidays", error);
    return data ?? [];
  }

  async addCoachAllowedSessionType(input: { coachUserId: string; sessionTypeId: string }) {
    const { data, error } = await supabaseAdmin
      .from("coach_allowed_session_types")
      .insert({
        coach_id: input.coachUserId,
        session_type_id: input.sessionTypeId,
      })
      .select()
      .single();
    if (error) throw new HttpError(500, "Failed to add allowed session type", error);
    return data;
  }

  async removeCoachAllowedSessionType(coachUserId: string, sessionTypeId: string) {
    const { error } = await supabaseAdmin
      .from("coach_allowed_session_types")
      .delete()
      .eq("coach_id", coachUserId)
      .eq("session_type_id", sessionTypeId);
    if (error) throw new HttpError(500, "Failed to remove allowed session type", error);
    return { ok: true };
  }

  async getCoachAllowedSessionTypes(coachUserId: string) {
    const { data, error } = await supabaseAdmin
      .from("coach_allowed_session_types")
      .select("*, session_types(*)")
      .eq("coach_id", coachUserId);
    if (error) throw new HttpError(500, "Failed to fetch coach allowed session types", error);
    return data ?? [];
  }
}
