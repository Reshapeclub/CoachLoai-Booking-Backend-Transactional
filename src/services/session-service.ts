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
      .select("*, session_types(*), coaches!sessions_coach_id_fkey(admins(name, id)), locations(name)")
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
    const waitlistCountBySessionId: Record<string, number> = {};
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

      const { data: waitRows, error: waitErr } = await supabaseAdmin
        .from("waiting_list_entries")
        .select("session_id")
        .in("session_id", sessionIds);
      if (waitErr) throw new HttpError(500, "Failed to fetch session waitlist counts", waitErr);
      (waitRows ?? []).forEach((w) => {
        const sessionId = String((w as { session_id: string }).session_id);
        waitlistCountBySessionId[sessionId] = (waitlistCountBySessionId[sessionId] ?? 0) + 1;
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
        waitlist_count: waitlistCountBySessionId[s.id] ?? 0,
      };
    });
  }

  async createSessionType(input: { name: string; category?: "1:1" | "Elite" | "Octave" | "Group"; categoryIcon?: string | null; audience?: string | null; color?: string | null; icon?: string | null; displayOrder?: number; defaultCapacity: number; maxPerDay?: number; defaultDurationMins: 30 | 45 | 60 }) {
    const category = input.category ?? "1:1";
    if (category === "1:1") {
      const { data: existingOneToOne, error: oneToOneErr } = await supabaseAdmin
        .from("session_types")
        .select("id")
        .eq("category", "1:1")
        .limit(1)
        .maybeSingle();
      if (oneToOneErr) throw new HttpError(500, "Failed to check existing 1:1 session types", oneToOneErr);
      if (existingOneToOne) throw new HttpError(400, "A 1:1 session type already exists; only one entry is allowed for this category.");
    }
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
      category_icon: input.categoryIcon ?? null,
      audience: input.audience ?? "mixed",
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
      categoryIcon?: string | null;
      audience?: string | null;
      color?: string | null;
      icon?: string | null;
      displayOrder?: number;
      defaultCapacity?: number;
      maxPerDay?: number;
      defaultDurationMins?: 30 | 45 | 60;
    }
  ) {
    if (input.category === "1:1") {
      const { data: otherOneToOne, error: oneToOneErr } = await supabaseAdmin
        .from("session_types")
        .select("id")
        .eq("category", "1:1")
        .neq("id", sessionTypeId)
        .limit(1)
        .maybeSingle();
      if (oneToOneErr) throw new HttpError(500, "Failed to check existing 1:1 session types", oneToOneErr);
      if (otherOneToOne)
        throw new HttpError(400, "A 1:1 session type already exists; only one entry is allowed for this category.");
    }
    const updates: Record<string, unknown> = {};
    if (input.name !== undefined) updates.name = input.name;
    if (input.category !== undefined) updates.category = input.category;
    if (input.categoryIcon !== undefined) updates.category_icon = input.categoryIcon;
    if (input.audience !== undefined) updates.audience = input.audience;
    if (input.color !== undefined) updates.color = input.color;
    if (input.icon !== undefined) updates.icon = input.icon;
    if (input.displayOrder !== undefined) {
      const n = Math.floor(Number(input.displayOrder));
      if (Number.isFinite(n) && n >= 0) updates.display_order = n;
    }
    // if (input.defaultCapacity !== undefined) {
    //   const n = Math.floor(Number(input.defaultCapacity));
    //   if (Number.isFinite(n) && n >= 1) updates.default_capacity = n;
    // }
    if (input.maxPerDay !== undefined) {
      const n = Math.floor(Number(input.maxPerDay));
      if (Number.isFinite(n) && n >= 1) updates.max_per_day = n;
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
      categoryIcon?: string | null;
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
    if (input.categoryIcon !== undefined) updates.category_icon = input.categoryIcon;
    if (input.color !== undefined) updates.color = input.color;
    // if (input.icon !== undefined) updates.icon = input.icon;
    if (input.displayOrder !== undefined) updates.display_order = input.displayOrder;
    if (input.defaultCapacity !== undefined) updates.default_capacity = input.defaultCapacity;
    if (input.maxPerDay !== undefined) updates.max_per_day = input.maxPerDay;
    if (input.defaultDurationMins !== undefined) updates.default_duration_mins = input.defaultDurationMins;
    if (input.isActive !== undefined) updates.is_active = input.isActive;
    if (Object.keys(updates).length === 0) throw new HttpError(400, "No fields to update");
    const { data: existingForCategory, error: existErr } = await supabaseAdmin
      .from("session_types")
      .select("id")
      .eq("category", category)
      .limit(1)
      .maybeSingle();
    if (existErr) throw new HttpError(500, "Failed to check session types for category", existErr);
    if (!existingForCategory) {
      const defaultNames: Record<"1:1" | "Elite" | "Octave" | "Group", string> = {
        "1:1": "1:1 Private (default)",
        Elite: "Elite (default)",
        Octave: "Octave (default)",
        Group: "Group (default)",
      };
      const defaultCapacity = Math.max(1, Math.floor(Number(updates.default_capacity ?? 1)));
      const maxPerDay = Math.max(
        1,
        Math.floor(Number(updates.max_per_day ?? defaultCapacity))
      );
      const dur = updates.default_duration_mins;
      const defaultDurationMins =
        dur === 30 || dur === 45 || dur === 60
          ? dur
          : (45 as 30 | 45 | 60);
      const displayOrder =
        updates.display_order !== undefined
          ? Math.max(0, Math.floor(Number(updates.display_order)))
          : 0;
      const isActive = typeof updates.is_active === "boolean" ? updates.is_active : true;
      const { error: insertErr } = await supabaseAdmin.from("session_types").insert({
        name: defaultNames[category],
        category,
        category_icon: updates.category_icon ?? null,
        color: updates.color ?? null,
        display_order: displayOrder,
        token_type_id: crypto.randomUUID(),
        default_capacity: defaultCapacity,
        max_per_day: maxPerDay,
        default_duration_mins: defaultDurationMins,
        is_active: isActive,
        audience: "mixed",
      });
      if (insertErr) {
        if ((insertErr as { code?: string }).code !== "23505")
          throw new HttpError(500, "Failed to create default session type for category", insertErr);
      }
    }
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
    chargeType?: "charged" | "noncharged";
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
        is_online: input.isOnline ?? false,
        charge_type: input.chargeType ?? null,
      })
      .select()
      .single();
    if (error) throw new HttpError(500, "Failed to create session", error);
    return data;
  }

  async updateSession(
    sessionId: string,
    input: {
      sessionTypeId?: string;
      tokenTypeId?: string;
      coachId?: string;
      locationId?: string | null;
      start?: string;
      durationMins?: 30 | 45 | 60;
      capacity?: number;
      allowOvertime?: boolean;
      isOnline?: boolean;
      chargeType?: "charged" | "noncharged";
    }
  ) {
    const { data: current, error: currentErr } = await supabaseAdmin
      .from("sessions")
      .select("id, session_type_id, token_type_id, coach_id, location_id, start_at, end_at, capacity, is_online")
      .eq("id", sessionId)
      .single();
    if (currentErr || !current) throw new HttpError(404, "Session not found");

    const finalSessionTypeId = input.sessionTypeId ?? current.session_type_id;
    const finalCoachId = input.coachId ?? current.coach_id;
    const finalLocationId = input.locationId !== undefined ? input.locationId : current.location_id;
    const finalStart = input.start ? new Date(input.start) : new Date(current.start_at);

    const { data: st, error: stErr } = await supabaseAdmin
      .from("session_types")
      .select("id, token_type_id, default_duration_mins, default_capacity")
      .eq("id", finalSessionTypeId)
      .single();
    if (stErr || !st) throw new HttpError(404, "Session type not found");

    const finalDuration = input.durationMins ?? Number(st.default_duration_mins ?? 45);
    const finalEnd = new Date(finalStart.getTime() + finalDuration * 60 * 1000);
    const finalCapacity = input.capacity ?? Number(current.capacity ?? st.default_capacity ?? 1);

    const { count, error: countErr } = await supabaseAdmin
      .from("bookings")
      .select("*", { count: "exact", head: true })
      .eq("session_id", sessionId)
      .eq("status", "booked");
    if (countErr) throw new HttpError(500, "Failed to check booked count", countErr);
    const bookedCount = count ?? 0;
    if (finalCapacity < bookedCount)
      throw new HttpError(400, `Capacity cannot be less than current booked count (${bookedCount})`);

    await validateCoachForSession({
      coachId: finalCoachId,
      sessionTypeId: finalSessionTypeId,
      locationId: finalLocationId,
      startAt: finalStart.toISOString(),
      endAt: finalEnd.toISOString(),
      excludeSessionId: sessionId,
      allowOvertime: input.allowOvertime,
    });

    const finalTokenTypeId = String(input.tokenTypeId ?? st.token_type_id ?? current.token_type_id ?? "").trim();
    if (!finalTokenTypeId) throw new HttpError(400, "Session type is missing token_type_id");

    const updates: Record<string, unknown> = {
      coach_id: finalCoachId,
      session_type_id: finalSessionTypeId,
      token_type_id: finalTokenTypeId,
      location_id: finalLocationId,
      start_at: finalStart.toISOString(),
      end_at: finalEnd.toISOString(),
      capacity: finalCapacity,
    };
    if (input.isOnline !== undefined) updates.is_online = input.isOnline;
    if (input.chargeType !== undefined) updates.charge_type = input.chargeType;

    const { data, error } = await supabaseAdmin
      .from("sessions")
      .update(updates)
      .eq("id", sessionId)
      .select()
      .single();
    if (error) throw new HttpError(500, "Failed to update session", error);
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

  async createLocation(input: {
    name: string;
    slug: string;
    address?: string | null;
    capacity?: number | null;
    manager?: string | null;
    openingHours?: string | null;
  }) {
    const row: Record<string, unknown> = { name: input.name.trim(), slug: input.slug.trim() };
    if (input.address !== undefined) row.address = input.address;
    if (input.capacity !== undefined) row.capacity = input.capacity;
    if (input.manager !== undefined) row.manager = input.manager;
    if (input.openingHours !== undefined) row.opening_hours = input.openingHours;
    const { data, error } = await supabaseAdmin.from("locations").insert(row).select().single();
    if (error) {
      if ((error as { code?: string }).code === "23505")
        throw new HttpError(409, "A location with this name or slug already exists", error);
      throw new HttpError(500, "Failed to create location", error);
    }
    return data;
  }

  async updateLocation(
    locationId: string,
    input: {
      name?: string;
      slug?: string;
      address?: string | null;
      capacity?: number | null;
      manager?: string | null;
      openingHours?: string | null;
    }
  ) {
    const upd: Record<string, unknown> = {};
    if (input.name !== undefined) upd.name = input.name.trim();
    if (input.slug !== undefined) upd.slug = input.slug.trim();
    if (input.address !== undefined) upd.address = input.address;
    if (input.capacity !== undefined) upd.capacity = input.capacity;
    if (input.manager !== undefined) upd.manager = input.manager;
    if (input.openingHours !== undefined) upd.opening_hours = input.openingHours;
    if (Object.keys(upd).length === 0) throw new HttpError(400, "No fields to update");
    const { data, error } = await supabaseAdmin.from("locations").update(upd).eq("id", locationId).select().single();
    if (error) {
      if ((error as { code?: string }).code === "23505")
        throw new HttpError(409, "A location with this name or slug already exists", error);
      if ((error as { code?: string }).code === "PGRST116")
        throw new HttpError(404, "Location not found", error);
      throw new HttpError(500, "Failed to update location", error);
    }
    if (!data) throw new HttpError(404, "Location not found");
    return data;
  }

  async deleteLocation(locationId: string) {
    const { error } = await supabaseAdmin.from("locations").delete().eq("id", locationId);
    if (error) {
      if ((error as { code?: string }).code === "23503")
        throw new HttpError(409, "Cannot delete: location is still in use (sessions, coaches, or other records).", error);
      throw new HttpError(500, "Failed to delete location", error);
    }
    return { ok: true } as const;
  }
}
