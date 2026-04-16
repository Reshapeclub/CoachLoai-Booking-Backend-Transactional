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

  async listSessionTypesGrouped() {
    const { data, error } = await supabaseAdmin
      .from("session_types")
      .select("*")
      .order("category", { ascending: true })
      .order("created_at", { ascending: true });
    if (error) throw new HttpError(500, "Failed to fetch session types", error);
    const rows = (data ?? []) as Array<Record<string, unknown> & { category?: string; token_type_id?: string }>;

    const groups = new Map<string, { category: string; tokenTypeId: string | null; children: unknown[] }>();
    for (const row of rows) {
      const category = String(row.category || "1:1");
      const tokenTypeId = row.token_type_id ? String(row.token_type_id) : null;
      const g = groups.get(category) ?? { category, tokenTypeId, children: [] };
      // prefer first tokenTypeId encountered (created_at asc)
      if (!g.tokenTypeId && tokenTypeId) g.tokenTypeId = tokenTypeId;
      g.children.push(row);
      groups.set(category, g);
    }
    return Array.from(groups.values());
  }

  async listSessionTypesByCategory(category: "1:1" | "Elite" | "Octave" | "Group") {
    const { data, error } = await supabaseAdmin
      .from("session_types")
      .select("*")
      .eq("category", category)
      .order("created_at", { ascending: true });
    if (error) throw new HttpError(500, "Failed to fetch session types by category", error);
    return data ?? [];
  }

  async listSessions(from?: string, to?: string) {
    let query = supabaseAdmin
      .from("sessions")
      .select("*, session_types(*), coaches(admins(name, id)), locations(name)")
      .order("start_at", { ascending: true });
    if (from) query = query.gte("start_at", from);
    if (to) query = query.lte("start_at", to);
    const { data, error } = await query;
    if (error) throw new HttpError(500, "Failed to fetch sessions", error);
    const sessions = (data ?? []) as Array<
      Record<string, unknown> & {
        id: string;
        coaches?: { admins?: { name?: string } };
        locations?: { name?: string };
      }
    >;

    const sessionIds = sessions.map((s) => s.id).filter(Boolean);
    const bookedCountBySessionId: Record<string, number> = {};
    if (sessionIds.length > 0) {
      const { data: bookings, error: bookingsErr } = await supabaseAdmin
        .from("bookings")
        .select("session_id")
        .in("session_id", sessionIds)
        .eq("status", "booked");
      if (bookingsErr) throw new HttpError(500, "Failed to fetch session bookings", bookingsErr);
      (bookings ?? []).forEach((b) => {
        const sessionId = String(b.session_id);
        bookedCountBySessionId[sessionId] = (bookedCountBySessionId[sessionId] ?? 0) + 1;
      });
    }

    return sessions.map((s) => {
      const coachName = s.coaches?.admins?.name ?? null;
      const locationName = s.locations?.name ?? null;
      const { coaches, locations, ...rest } = s;
      return {
        ...rest,
        coach_name: coachName,
        location_name: locationName,
        booked_count: bookedCountBySessionId[s.id] ?? 0,
      };
    });
  }

  async createSessionType(input: { name: string; category?: "1:1" | "Elite" | "Octave" | "Group"; color?: string | null; icon?: string | null; displayOrder?: number; defaultCapacity: number; maxPerDay?: number; defaultDurationMins: 30 | 45 | 60 }) {
    const category = input.category ?? "1:1";
    const { data: existingCategoryType } = await supabaseAdmin
      .from("session_types")
      .select("token_type_id")
      .eq("category", category)
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle();
    const tokenTypeId = existingCategoryType?.token_type_id ?? crypto.randomUUID();
    const { data, error } = await supabaseAdmin.from('session_types').insert({
      name: input.name,
      category,
      color: input.color ?? null,
      icon: input.icon ?? null,
      display_order: input.displayOrder ?? 0,
      token_type_id: tokenTypeId,
      default_capacity: input.defaultCapacity,
      max_per_day: input.maxPerDay ?? input.defaultCapacity,
      default_duration_mins: input.defaultDurationMins
    }).select().single();
    if (error) throw new HttpError(500, 'Failed to create session type', error);
    return data;
  }

  async updateSessionType(
    sessionTypeId: string,
    input: {
      name?: string;
      category?: "1:1" | "Elite" | "Octave" | "Group";
      color?: string | null;
      icon?: string | null;
      displayOrder?: number;
      defaultCapacity?: number;
      maxPerDay?: number;
      defaultDurationMins?: 30 | 45 | 60;
    }
  ) {
    const updates: Record<string, unknown> = {};
    if (input.name !== undefined) updates.name = input.name;
    if (input.category !== undefined) updates.category = input.category;
    if (input.color !== undefined) updates.color = input.color;
    if (input.icon !== undefined) updates.icon = input.icon;
    if (input.displayOrder !== undefined) updates.display_order = input.displayOrder;
    if (input.defaultCapacity !== undefined) {
      updates.default_capacity = input.defaultCapacity;
    }
    if (input.maxPerDay !== undefined) {
      updates.max_per_day = input.maxPerDay;
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

  async updateSessionTypesByCategory(
    category: "1:1" | "Elite" | "Octave" | "Group",
    input: {
      color?: string | null;
      icon?: string | null;
      displayOrder?: number;
      defaultCapacity?: number;
      maxPerDay?: number;
      defaultDurationMins?: 30 | 45 | 60;
      isActive?: boolean;
    }
  ) {
    const updates: Record<string, unknown> = {};
    if (input.color !== undefined) updates.color = input.color;
    if (input.icon !== undefined) updates.icon = input.icon;
    if (input.displayOrder !== undefined) updates.display_order = input.displayOrder;
    if (input.defaultCapacity !== undefined) updates.default_capacity = input.defaultCapacity;
    if (input.maxPerDay !== undefined) updates.max_per_day = input.maxPerDay;
    if (input.defaultDurationMins !== undefined) updates.default_duration_mins = input.defaultDurationMins;
    if (input.isActive !== undefined) updates.is_active = input.isActive;
    if (Object.keys(updates).length === 0) throw new HttpError(400, "No fields to update");

    const { data, error } = await supabaseAdmin
      .from("session_types")
      .update(updates)
      .eq("category", category)
      .select();
    if (error) throw new HttpError(500, "Failed to update session types by category", error);
    return data ?? [];
  }

  async createSession(input: {
    sessionTypeId: string;
    tokenTypeId: string;
    coachId: string;
    locationId?: string | null;
    startAt: string;
    endAt: string;
    capacity: number;
    allowOvertime?: boolean;
    isOnline?: boolean;
  }) {
    await validateCoachForSession({
      coachId: input.coachId,
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
        coach_id: input.coachId,
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
    coachId: string,
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
      coachId,
      sessionTypeId: session.session_type_id,
      locationId: session.location_id,
      startAt: session.start_at,
      endAt: session.end_at,
      excludeSessionId: sessionId,
      allowOvertime: opts?.allowOvertime,
    });
    const { data, error } = await supabaseAdmin
      .from("sessions")
      .update({ coach_id: coachId })
      .eq("id", sessionId)
      .select()
      .single();
    if (error) throw new HttpError(500, "Failed to update coach", error);
    return data;
  }

  async setSessionType(sessionId: string, sessionTypeId: string, tokenTypeId: string) {
    const { data: session, error: fetchErr } = await supabaseAdmin
      .from("sessions")
      .select("coach_id, location_id, start_at, end_at")
      .eq("id", sessionId)
      .single();
    if (fetchErr || !session)
      throw new HttpError(404, "Session not found");
    await validateCoachForSession({
      coachId: session.coach_id,
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
      .select("*, admins!coaches_user_id_fkey(id, name, email, location_id)")
      .order("user_id", { ascending: true });
    if (error) throw new HttpError(500, "Failed to fetch coaches", error);
    return data ?? [];
  }

  async listLocations() {
    const { data, error } = await supabaseAdmin
      .from("locations")
      .select("*")
      .order("name", { ascending: false });
    if (error) throw new HttpError(500, "Failed to fetch locations", error);
    return data ?? [];
  }
}
