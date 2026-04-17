import { supabaseAdmin } from "../db/supabase.js";
import { HttpError } from "../lib/http-error.js";

export class CoachService {
  async listCoaches() {
    const { data, error } = await supabaseAdmin
      .from("coaches")
      .select("*, admins!coaches_user_id_fkey(id, name, email, location_id)")
      .order("created_at", { ascending: true });
    if (error) throw new HttpError(500, "Failed to fetch coaches", error);
    return data ?? [];
  }

  async getCoach(coachUserId: string) {
    const { data, error } = await supabaseAdmin
      .from("coaches")
      .select("*, admins!coaches_user_id_fkey(id, name, email, location_id)")
      .eq("id", coachUserId)
      .single();
    if (error) throw new HttpError(404, "Coach not found", error);
    return data;
  }

  async createCoach(input: {
    userId: number;
    weeklyHourLimitMins?: number;
    travelBufferMinutes?: number;
  }) {
    const { data: admin, error: adminErr } = await supabaseAdmin
      .from("admins")
      .select("id, location_id")
      .eq("id", input.userId)
      .single();
    if (adminErr || !admin) throw new HttpError(404, "Admin not found");
    if (!admin.location_id)
      throw new HttpError(400, "Admin must have a location_id to create coach");

    const { data, error } = await supabaseAdmin
      .from("coaches")
      .insert({
        user_id: input.userId,
        location_id: admin.location_id,
        weekly_hour_limit_mins: input.weeklyHourLimitMins ?? 2400,
        travel_buffer_minutes: input.travelBufferMinutes ?? 30,
      })
      .select()
      .single();
    if (error) throw new HttpError(500, "Failed to create coach", error);
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
    return data;
  }

  async deleteCoach(coachUserId: string) {
    const { error } = await supabaseAdmin.from("coaches").delete().eq("id", coachUserId);
    if (error) throw new HttpError(500, "Failed to delete coach", error);
    return { ok: true };
  }

  async addCoachAvailability(input: {
    coachUserId: string;
    dayOfWeek: number;
    startMins: number;
    endMins: number;
  }) {
    const { data, error } = await supabaseAdmin
      .from("coach_availability")
      .insert({
        coach_id: input.coachUserId,
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

  async getCoachAvailability(coachUserId: string) {
    const { data, error } = await supabaseAdmin
      .from("coach_availability")
      .select("*")
      .eq("coach_id", coachUserId)
      .order("day_of_week", { ascending: true });
    if (error) throw new HttpError(500, "Failed to fetch coach availability", error);
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
