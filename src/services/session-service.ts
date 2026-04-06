import { supabaseAdmin } from "../db/supabase.js";
import { HttpError } from "../lib/http-error.js";
import { validateCoachForSession } from "./coach-roster-validator.js";

export class SessionService {
  async listSessionTypes() {
    const { data, error } = await supabaseAdmin
      .from("session_types")
      .select("*")
      .order("created_at", { ascending: false });
    if (error) throw new HttpError(500, "Failed to fetch session types", error);
    return data ?? [];
  }

  async listSessions(from?: string, to?: string) {
    let query = supabaseAdmin
      .from("sessions")
      .select("*, session_types(*), coaches(profiles(full_name, id))")
      .limit(1)
      .order("start_at", { ascending: true });
    if (from) query = query.gte("start_at", from);
    if (to) query = query.lte("start_at", to);
    const { data, error } = await query;
    console.log(data);
    if (error) throw new HttpError(500, "Failed to fetch sessions", error);
    const sessions = (data ?? []) as Array<Record<string, unknown> & { coaches?: { profiles?: { full_name?: string } } }>;
    return sessions.map((s) => {
      const coachName = s.coaches?.profiles?.full_name ?? null;
      const { coaches, ...rest } = s;
      return { ...rest, coach_name: coachName };
    });
  }

  async createSessionType(input: { name: string; color?: string | null; icon?: string | null; displayOrder?: number; defaultCapacity: number; defaultDurationMins: 30 | 45 | 60 }) {
    const tokenTypeId = crypto.randomUUID();
    const { data, error } = await supabaseAdmin.from('session_types').insert({
      name: input.name,
      color: input.color ?? null,
      icon: input.icon ?? null,
      display_order: input.displayOrder ?? 0,
      token_type_id: tokenTypeId,
      default_capacity: input.defaultCapacity,
      default_duration_mins: input.defaultDurationMins
    }).select().single();
    if (error) throw new HttpError(500, 'Failed to create session type', error);
    return data;
  }

  async updateSessionType(
    sessionTypeId: string,
    input: {
      name?: string;
      color?: string | null;
      icon?: string | null;
      displayOrder?: number;
      defaultCapacity?: number;
      defaultDurationMins?: 30 | 45 | 60;
    }
  ) {
    const updates: Record<string, unknown> = {};
    if (input.name !== undefined) updates.name = input.name;
    if (input.color !== undefined) updates.color = input.color;
    if (input.icon !== undefined) updates.icon = input.icon;
    if (input.displayOrder !== undefined) updates.display_order = input.displayOrder;
    if (input.defaultCapacity !== undefined) {
      updates.default_capacity = input.defaultCapacity;
    }
    if (input.defaultDurationMins !== undefined) {
      updates.default_duration_mins = input.defaultDurationMins;
    }

    const { data, error } = await supabaseAdmin
      .from("session_types")
      .update(updates)
      .eq("id", sessionTypeId)
      .select()
      .single();
    if (error) throw new HttpError(500, "Failed to update session type", error);
    return data;
  }

  async createSession(input: {
    sessionTypeId: string;
    tokenTypeId: string;
    coachUserId: string;
    locationId?: string | null;
    startAt: string;
    endAt: string;
    capacity: number;
    allowOvertime?: boolean;
    isOnline?: boolean;
  }) {
    await validateCoachForSession({
      coachUserId: input.coachUserId,
      sessionTypeId: input.sessionTypeId,
      locationId: input.locationId ?? null,
      startAt: input.startAt,
      endAt: input.endAt,
      allowOvertime: input.allowOvertime,
    });
    const { data, error } = await supabaseAdmin
      .from("sessions")
      .insert({
        session_type_id: input.sessionTypeId,
        token_type_id: input.tokenTypeId,
        coach_user_id: input.coachUserId,
        location_id: input.locationId ?? null,
        start_at: input.startAt,
        end_at: input.endAt,
        capacity: input.capacity,
        is_online: input.isOnline ?? false
      })
      .select()
      .single();
    if (error) throw new HttpError(500, "Failed to create session", error);
    return data;
  }

  async setCapacity(sessionId: string, capacity: number) {
    const { count, error: countErr } = await supabaseAdmin
      .from("bookings")
      .select("*", { count: "exact", head: true })
      .eq("session_id", sessionId)
      .eq("status", "booked");
    if (countErr) throw new HttpError(500, "Failed to check booked count", countErr);
    const bookedCount = count ?? 0;
    if (capacity < bookedCount)
      throw new HttpError(400, `Capacity cannot be less than current booked count (${bookedCount})`);
    const { data, error } = await supabaseAdmin
      .from("sessions")
      .update({ capacity })
      .eq("id", sessionId)
      .select()
      .single();
    if (error) throw new HttpError(500, "Failed to update capacity", error);
    return data;
  }

  async setCoach(
    sessionId: string,
    coachUserId: string,
    opts?: { allowOvertime?: boolean }
  ) {
    const { data: session, error: fetchErr } = await supabaseAdmin
      .from("sessions")
      .select("session_type_id, location_id, start_at, end_at")
      .eq("id", sessionId)
      .single();
    if (fetchErr || !session)
      throw new HttpError(404, "Session not found");
    await validateCoachForSession({
      coachUserId,
      sessionTypeId: session.session_type_id,
      locationId: session.location_id,
      startAt: session.start_at,
      endAt: session.end_at,
      excludeSessionId: sessionId,
      allowOvertime: opts?.allowOvertime,
    });
    const { data, error } = await supabaseAdmin
      .from("sessions")
      .update({ coach_user_id: coachUserId })
      .eq("id", sessionId)
      .select()
      .single();
    if (error) throw new HttpError(500, "Failed to update coach", error);
    return data;
  }

  async setSessionType(sessionId: string, sessionTypeId: string, tokenTypeId: string) {
    const { data: session, error: fetchErr } = await supabaseAdmin
      .from("sessions")
      .select("coach_user_id, location_id, start_at, end_at")
      .eq("id", sessionId)
      .single();
    if (fetchErr || !session)
      throw new HttpError(404, "Session not found");
    await validateCoachForSession({
      coachUserId: session.coach_user_id,
      sessionTypeId,
      locationId: session.location_id,
      startAt: session.start_at,
      endAt: session.end_at,
      excludeSessionId: sessionId,
    });
    const { data, error } = await supabaseAdmin
      .from("sessions")
      .update({ session_type_id: sessionTypeId, token_type_id: tokenTypeId })
      .eq("id", sessionId)
      .select()
      .single();
    if (error) throw new HttpError(500, "Failed to update session type", error);
    return data;
  }

  async getSessionMembers(sessionId: string) {
    const { data, error } = await supabaseAdmin
      .from("bookings")
      .select("*, profiles!bookings_member_id_fkey(full_name, email)")
      .eq("session_id", sessionId)
      .eq("status", "booked");
    if (error) throw new HttpError(500, "Failed to fetch session members", error);
    return data ?? [];
  }

  async listCoaches() {
    const { data, error } = await supabaseAdmin
      .from("coaches")
      .select("*, profiles!coaches_user_id_fkey(id, full_name, email, location_id)")
      .order("user_id", { ascending: true });
    if (error) throw new HttpError(500, "Failed to fetch coaches", error);
    return data ?? [];
  }

  async listLocations() {
    const { data, error } = await supabaseAdmin
      .from("locations")
      .select("*")
      .order("name", { ascending: true });
    if (error) throw new HttpError(500, "Failed to fetch locations", error);
    return data ?? [];
  }
}
