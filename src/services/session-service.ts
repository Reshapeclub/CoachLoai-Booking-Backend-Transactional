import { supabaseAdmin } from "../db/supabase.js";
import { HttpError } from "../lib/http-error.js";

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

  async createSessionType(input: { name: string; defaultCapacity: number; defaultDurationMins: 30|45|60 }) {
    const tokenTypeId = crypto.randomUUID();
    const { data, error } = await supabaseAdmin.from('session_types').insert({ name: input.name, token_type_id: tokenTypeId, default_capacity: input.defaultCapacity, default_duration_mins: input.defaultDurationMins }).select().single();
    if (error) throw new HttpError(500, 'Failed to create session type', error);
    return data;
  }

  async updateSessionType(
    sessionTypeId: string,
    input: {
      name?: string;
      defaultCapacity?: number;
      defaultDurationMins?: 30 | 45 | 60;
    }
  ) {
    const updates: Record<string, unknown> = {};
    if (input.name !== undefined) updates.name = input.name;
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

  async createSession(input: { sessionTypeId: string; tokenTypeId: string; coachUserId: string; locationId?: string|null; startAt: string; endAt: string; capacity: number; }) {
    const { data, error } = await supabaseAdmin.from('sessions').insert({ session_type_id: input.sessionTypeId, token_type_id: input.tokenTypeId, coach_user_id: input.coachUserId, location_id: input.locationId ?? null, start_at: input.startAt, end_at: input.endAt, capacity: input.capacity }).select().single();
    if (error) throw new HttpError(500, 'Failed to create session', error);
    return data;
  }

  async setCapacity(sessionId: string, capacity: number) {
    const { data, error } = await supabaseAdmin.from('sessions').update({ capacity }).eq('id', sessionId).select().single();
    if (error) throw new HttpError(500, 'Failed to update capacity', error);
    return data;
  }

  async setCoach(sessionId: string, coachUserId: string) {
    const { data, error } = await supabaseAdmin.from('sessions').update({ coach_user_id: coachUserId }).eq('id', sessionId).select().single();
    if (error) throw new HttpError(500, 'Failed to update coach', error);
    return data;
  }

  async setSessionType(sessionId: string, sessionTypeId: string, tokenTypeId: string) {
    const { data, error } = await supabaseAdmin.from('sessions').update({ session_type_id: sessionTypeId, token_type_id: tokenTypeId }).eq('id', sessionId).select().single();
    if (error) throw new HttpError(500, 'Failed to update session type', error);
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
