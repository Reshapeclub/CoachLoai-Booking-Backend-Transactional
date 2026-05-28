import { supabaseAdmin } from "../db/supabase.js";
import { HttpError } from "../lib/http-error.js";
import { validateCoachForSession } from "./coach-roster-validator.js";

/** PostgREST URLs with `.in("session_id", uuid[])` overflow ~16KB when the array is large; keep chunks small. */
const SESSION_ID_IN_CHUNK = 80;

function chunkIds<T>(ids: T[], size: number): T[][] {
  if (size <= 0) return [ids];
  const out: T[][] = [];
  for (let i = 0; i < ids.length; i += size) out.push(ids.slice(i, i + size));
  return out;
}

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

  async listSessions(from?: string, to?: string, opts?: { includeDeleted?: boolean }) {
    // Explicit columns + slimmer session_types — avoids huge JSON when listing thousands of rows (admin heatmap).
    let query = supabaseAdmin
      .from("sessions")
      .select(
        "id, session_type_id, token_type_id, coach_id, location_id, start_at, end_at, capacity, training_level, is_cancelled, is_online, created_at, deleted_at, session_types(id, name, category, default_capacity, default_duration_mins, color, audience, token_type_id, category_icon, icon, display_order), coaches!sessions_coach_id_fkey(admins(name, id)), locations(name)",
      )
      .order("start_at", { ascending: true });
    if (!opts?.includeDeleted) {
      query = query.is("deleted_at", null);
    }
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
      // Admin always passes from+to; one bounded query each beats dozens of sequential `.in()` chunks (was hanging).
      if (from && to) {
        const [bookedRes, waitRes] = await Promise.all([
          supabaseAdmin
            .from("bookings")
            // PostgREST (PGRST108): filters on sessions.* require sessions in select; !inner applies date window.
            .select("session_id, sessions!inner(start_at)")
            .eq("status", "booked")
            .gte("sessions.start_at", from)
            .lte("sessions.start_at", to),
          supabaseAdmin
            .from("waiting_list_entries")
            .select("session_id, sessions!inner(start_at)")
            .gte("sessions.start_at", from)
            .lte("sessions.start_at", to),
        ]);
        if (bookedRes.error) throw new HttpError(500, "Failed to fetch session bookings", bookedRes.error);
        if (waitRes.error) throw new HttpError(500, "Failed to fetch session waitlist counts", waitRes.error);
        (bookedRes.data ?? []).forEach((b) => {
          const sessionId = String((b as { session_id: string }).session_id);
          bookedCountBySessionId[sessionId] = (bookedCountBySessionId[sessionId] ?? 0) + 1;
        });
        (waitRes.data ?? []).forEach((w) => {
          const sessionId = String((w as { session_id: string }).session_id);
          waitlistCountBySessionId[sessionId] = (waitlistCountBySessionId[sessionId] ?? 0) + 1;
        });
      } else {
        const chunks = chunkIds(sessionIds, SESSION_ID_IN_CHUNK);
        const bookedChunks = await Promise.all(
          chunks.map((idChunk) =>
            supabaseAdmin.from("bookings").select("session_id").in("session_id", idChunk).eq("status", "booked"),
          ),
        );
        for (const { data: bookings, error: bookingsErr } of bookedChunks) {
          if (bookingsErr) throw new HttpError(500, "Failed to fetch session bookings", bookingsErr);
          (bookings ?? []).forEach((b) => {
            const sessionId = String(b.session_id);
            bookedCountBySessionId[sessionId] = (bookedCountBySessionId[sessionId] ?? 0) + 1;
          });
        }
        const waitChunks = await Promise.all(
          chunks.map((idChunk) =>
            supabaseAdmin.from("waiting_list_entries").select("session_id").in("session_id", idChunk),
          ),
        );
        for (const { data: waitRows, error: waitErr } of waitChunks) {
          if (waitErr) throw new HttpError(500, "Failed to fetch session waitlist counts", waitErr);
          (waitRows ?? []).forEach((w) => {
            const sessionId = String((w as { session_id: string }).session_id);
            waitlistCountBySessionId[sessionId] = (waitlistCountBySessionId[sessionId] ?? 0) + 1;
          });
        }
      }
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
    trainingLevel?: string | null;
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
        training_level: input.trainingLevel ?? null,
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
      trainingLevel?: string | null;
    }
  ) {
    const { data: current, error: currentErr } = await supabaseAdmin
      .from("sessions")
      .select("id, session_type_id, token_type_id, coach_id, location_id, start_at, end_at, capacity, is_online")
      .eq("id", sessionId)
      .is("deleted_at", null)
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
    if (input.trainingLevel !== undefined) updates.training_level = input.trainingLevel;

    const { data, error } = await supabaseAdmin
      .from("sessions")
      .update(updates)
      .eq("id", sessionId)
      .is("deleted_at", null)
      .select()
      .single();
    if (error) throw new HttpError(500, "Failed to update session", error);
    return data;
  }

  async setCapacity(sessionId: string, capacity: number) {
    const { data, error } = await supabaseAdmin
      .from("sessions")
      .update({ capacity })
      .eq("id", sessionId)
      .is("deleted_at", null)
      .select()
      .single();
    if (error) throw new HttpError(500, "Failed to update capacity", error);
    return data;
  }

  async setCoach(
    sessionId: string,
    coachId: string,
    opts?: { allowOvertime?: boolean; ignoreSessionIds?: string[] }
  ) {
    const { data: session, error: fetchErr } = await supabaseAdmin
      .from("sessions")
      .select("session_type_id, location_id, start_at, end_at")
      .eq("id", sessionId)
      .is("deleted_at", null)
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
      ignoreSessionIds: opts?.ignoreSessionIds,
    });
    const { data, error } = await supabaseAdmin
      .from("sessions")
      .update({ coach_id: coachId })
      .eq("id", sessionId)
      .is("deleted_at", null)
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
      .is("deleted_at", null)
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
      .is("deleted_at", null)
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

  /** Soft-delete: session hidden from schedules; no row remove. Blocked if any active bookings. */
  async adminDeleteSession(sessionId: string) {
    const { count, error: countErr } = await supabaseAdmin
      .from("bookings")
      .select("*", { count: "exact", head: true })
      .eq("session_id", sessionId)
      .eq("status", "booked");
    if (countErr) throw new HttpError(500, "Failed to check bookings before delete", countErr);
    if ((count ?? 0) > 0) {
      throw new HttpError(
        409,
        "Cannot delete: this session still has active bookings. Remove or move members first, or cancel the session instead.",
      );
    }
    const { data: row, error: selErr } = await supabaseAdmin
      .from("sessions")
      .select("id, deleted_at")
      .eq("id", sessionId)
      .maybeSingle();
    if (selErr) throw new HttpError(500, "Failed to load session before delete", selErr);
    if (!row) throw new HttpError(404, "Session not found");
    if ((row as { deleted_at?: string | null }).deleted_at != null) {
      throw new HttpError(422, "Session is already removed");
    }
    const { error: delErr } = await supabaseAdmin
      .from("sessions")
      .update({ deleted_at: new Date().toISOString() })
      .eq("id", sessionId)
      .is("deleted_at", null);
    if (delErr) throw new HttpError(500, "Failed to soft-delete session", delErr);
    return { ok: true as const };
  }

  /** Soft-delete future sessions in [from, to] that have not started yet (start_at > now). */
  async adminBulkDeleteFutureSessions(input: { from: string; to: string; nowIso?: string }) {
    const nowIso = input.nowIso ?? new Date().toISOString();
    const nowMs = new Date(nowIso).getTime();
    const fromMs = new Date(input.from).getTime();
    const toMs = new Date(input.to).getTime();
    if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs < fromMs) {
      throw new HttpError(400, "Invalid from/to range for bulk delete");
    }
    const futureFromIso = nowMs >= fromMs ? nowIso : input.from;

    const { data: sessions, error } = await supabaseAdmin
      .from("sessions")
      .select("id")
      .gte("start_at", futureFromIso)
      .lte("start_at", input.to)
      .is("deleted_at", null)
      .order("start_at", { ascending: true });
    if (error) throw new HttpError(500, "Failed to list sessions for bulk delete", error);

    const deletedIds: string[] = [];
    const skipped: Array<{ sessionId: string; reason: string }> = [];
    for (const row of sessions ?? []) {
      const sessionId = String((row as { id: string }).id ?? "").trim();
      if (!sessionId) continue;
      try {
        await this.adminDeleteSession(sessionId);
        deletedIds.push(sessionId);
      } catch (e) {
        const reason =
          e instanceof HttpError ? e.message : e instanceof Error ? e.message : "Delete failed";
        skipped.push({ sessionId, reason });
      }
    }
    return {
      ok: true as const,
      deletedCount: deletedIds.length,
      deletedIds,
      skippedCount: skipped.length,
      skipped,
    };
  }

  /** Clear soft-delete so the session appears on schedules again. */
  async adminRestoreSession(sessionId: string) {
    const { data: row, error: selErr } = await supabaseAdmin
      .from("sessions")
      .select("id, deleted_at, coach_id, session_type_id, location_id, start_at, end_at, is_cancelled")
      .eq("id", sessionId)
      .maybeSingle();
    if (selErr) throw new HttpError(500, "Failed to load session", selErr);
    if (!row) throw new HttpError(404, "Session not found");
    if ((row as { deleted_at?: string | null }).deleted_at == null) {
      throw new HttpError(422, "Session is not removed");
    }
    if ((row as { is_cancelled?: boolean }).is_cancelled === true) {
      throw new HttpError(422, "Cannot restore a cancelled session; reinstate it first.");
    }
    const coachId = String((row as { coach_id: string }).coach_id ?? "").trim();
    if (!coachId) throw new HttpError(422, "Session has no coach assigned");
    await validateCoachForSession({
      coachId,
      sessionTypeId: String((row as { session_type_id: string }).session_type_id),
      locationId: (row as { location_id?: string | null }).location_id ?? null,
      startAt: String((row as { start_at: string }).start_at),
      endAt: String((row as { end_at: string }).end_at),
      excludeSessionId: sessionId,
    });
    const { error: updErr } = await supabaseAdmin
      .from("sessions")
      .update({ deleted_at: null })
      .eq("id", sessionId);
    if (updErr) throw new HttpError(500, "Failed to restore session", updErr);
    return { ok: true as const };
  }

  async listCoaches() {
    const { data, error } = await supabaseAdmin
      .from("coaches")
      .select("*, admins!coaches_user_id_fkey(id, name, email, role, location_id, photo_url, is_active)")
      .order("user_id", { ascending: true });
    if (error) throw new HttpError(500, "Failed to fetch coaches", error);
    const coaches = (data ?? []).filter((row) => {
      const c = row as { is_active?: boolean | null; admins?: { is_active?: boolean | null } | null };
      if (c.is_active === false) return false;
      const a = c.admins;
      if (a && a.is_active === false) return false;
      return true;
    });
    if (coaches.length === 0) return coaches;
    const adminIds = coaches
      .map((c) => (c as { user_id?: string | number }).user_id)
      .filter((id): id is string | number => id !== undefined && id !== null);
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
    return coaches.map((coach) => ({
      ...coach,
      location_ids: locsByAdmin.get(String((coach as { user_id: string | number }).user_id)) ?? [],
    }));
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
