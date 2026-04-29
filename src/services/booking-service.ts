import { supabaseAdmin } from "../db/supabase.js";
import { HttpError } from "../lib/http-error.js";

export class BookingService {
  private readonly knownSessionAccessCodes = new Set([
    "reshape30",
    "reshape45",
    "hybrid",
    "predators",
    "beat30",
    "beat45",
    "abset",
  ]);

  private normalizeAccessCode(value: unknown): string {
    return String(value ?? "")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "");
  }

  private async getMemberAccessProfile(memberId: string): Promise<{
    locationCodes: Set<string>;
    trainingLevels: Set<string>;
    sessionAccess: Set<string>;
  }> {
    const [locationRowsRes, trainingRowsRes, sessionRowsRes] = await Promise.all([
      supabaseAdmin
        .from("member_location_access")
        .select("location_code")
        .eq("member_id", memberId),
      supabaseAdmin
        .from("member_training_levels")
        .select("level_code")
        .eq("member_id", memberId),
      supabaseAdmin
        .from("member_session_access")
        .select("session_code")
        .eq("member_id", memberId),
    ]);

    if (locationRowsRes.error) {
      throw new HttpError(500, "Failed to load member location access", locationRowsRes.error);
    }
    if (trainingRowsRes.error) {
      throw new HttpError(500, "Failed to load member training levels", trainingRowsRes.error);
    }
    if (sessionRowsRes.error) {
      throw new HttpError(500, "Failed to load member session access", sessionRowsRes.error);
    }

    const toCodeSet = (rows: unknown[] | null | undefined, key: string) =>
      new Set(
        (rows ?? [])
          .map((row) => this.normalizeAccessCode((row as Record<string, unknown>)[key]))
          .filter(Boolean),
      );

    return {
      locationCodes: toCodeSet(locationRowsRes.data, "location_code"),
      trainingLevels: toCodeSet(trainingRowsRes.data, "level_code"),
      sessionAccess: toCodeSet(sessionRowsRes.data, "session_code"),
    };
  }

  private isSessionAllowedForMember(
    access: { locationCodes: Set<string>; trainingLevels: Set<string>; sessionAccess: Set<string> },
    session: {
      is_online?: boolean | null;
      location_id?: string | null;
      training_level?: string | null;
      session_types?: { name?: string | null; category?: string | null } | Array<{ name?: string | null; category?: string | null }> | null;
      locations?: { name?: string | null; slug?: string | null } | Array<{ name?: string | null; slug?: string | null }> | null;
    },
  ): boolean {
    return this.getSessionAccessDebug(access, session).reason === null;
  }

  private getSessionAccessDebug(
    access: { locationCodes: Set<string>; trainingLevels: Set<string>; sessionAccess: Set<string> },
    session: {
      is_online?: boolean | null;
      location_id?: string | null;
      training_level?: string | null;
      session_types?: { name?: string | null; category?: string | null } | Array<{ name?: string | null; category?: string | null }> | null;
      locations?: { name?: string | null; slug?: string | null } | Array<{ name?: string | null; slug?: string | null }> | null;
    },
  ): {
    reason: "location" | "training_level" | "session_access" | null;
    normalized: { sessionTypeCode: string; sessionCategoryCode: string; trainingLevelCode: string; locationNameCode: string; locationSlugCode: string };
  } {
    const sessionType = Array.isArray(session.session_types) ? session.session_types[0] : session.session_types;
    const location = Array.isArray(session.locations) ? session.locations[0] : session.locations;
    const sessionTypeCode = this.normalizeAccessCode(sessionType?.name);
    const sessionCategoryCode = this.normalizeAccessCode(sessionType?.category);
    const trainingLevelCode = this.normalizeAccessCode(session.training_level);
    const locationNameCode = this.normalizeAccessCode(location?.name);
    const locationSlugCode = this.normalizeAccessCode(location?.slug);

    // Location access: if access list exists and session is in-person, location must match code/name/slug.
    if (access.locationCodes.size > 0 && !session.is_online && session.location_id) {
      const sessionLocCodes = new Set([locationSlugCode, locationNameCode]);
      const locationAllowed = [...sessionLocCodes].some((code) => code && access.locationCodes.has(code));
      if (!locationAllowed) {
        return { reason: "location", normalized: { sessionTypeCode, sessionCategoryCode, trainingLevelCode, locationNameCode, locationSlugCode } };
      }
    }

    // Training level access: if session has a level and member has allowed list, it must include it.
    if (trainingLevelCode && access.trainingLevels.size > 0 && !access.trainingLevels.has(trainingLevelCode)) {
      return { reason: "training_level", normalized: { sessionTypeCode, sessionCategoryCode, trainingLevelCode, locationNameCode, locationSlugCode } };
    }

    // Session access: if member has list, session name/category must map to one of allowed codes.
    if (access.sessionAccess.size > 0) {
      // Member > Training session-access UI does not include these category-level keys.
      // Skip category gating for them so name-based access remains the source of truth.
      if (sessionCategoryCode !== "11" && sessionCategoryCode !== "octave") {
        const sessionIsInAccessScope =
          this.knownSessionAccessCodes.has(sessionTypeCode) ||
          this.knownSessionAccessCodes.has(sessionCategoryCode);
        if (!sessionIsInAccessScope) {
          return { reason: null, normalized: { sessionTypeCode, sessionCategoryCode, trainingLevelCode, locationNameCode, locationSlugCode } };
        }
        const sessionCodes = new Set([sessionTypeCode, sessionCategoryCode]);
        const sessionAllowed = [...sessionCodes].some((code) => code && access.sessionAccess.has(code));
        if (!sessionAllowed) {
          return { reason: "session_access", normalized: { sessionTypeCode, sessionCategoryCode, trainingLevelCode, locationNameCode, locationSlugCode } };
        }
      }
    }
    return { reason: null, normalized: { sessionTypeCode, sessionCategoryCode, trainingLevelCode, locationNameCode, locationSlugCode } };
  }

  async getMemberWaitlistEntries(memberId: string) {
    const { data, error } = await supabaseAdmin
      .from("waiting_list_entries")
      .select("*, sessions(*, session_types(*))")
      .eq("member_id", memberId)
      .order("joined_at", { ascending: false });
    if (error) throw new HttpError(500, "Failed to fetch member waitlist", error);
    return data ?? [];
  }

  async getSessionWaitlist(sessionId: string) {
    const { data, error } = await supabaseAdmin
      .from("waiting_list_entries")
      .select("*, profiles!waiting_list_entries_member_id_fkey(full_name, email)")
      .eq("session_id", sessionId)
      .order("joined_at", { ascending: true });
    if (error) throw new HttpError(500, "Failed to fetch session waitlist", error);
    return data ?? [];
  }

  /** Waitlist rows for sessions whose start_at falls in [from, to] (admin dashboard). */
  async listAdminWaitlistEntries(filters: { from?: string; to?: string }) {
    let sessionQuery = supabaseAdmin.from("sessions").select("id");
    if (filters.from) sessionQuery = sessionQuery.gte("start_at", filters.from);
    if (filters.to) sessionQuery = sessionQuery.lte("start_at", filters.to);
    const { data: sessionRows, error: sessionErr } = await sessionQuery;
    if (sessionErr) throw new HttpError(500, "Failed to resolve sessions for waitlist", sessionErr);
    const sessionIds = (sessionRows ?? []).map((r) => String((r as { id: string }).id));
    if (sessionIds.length === 0) return [];

    const { data, error } = await supabaseAdmin
      .from("waiting_list_entries")
      .select(
        "id, session_id, member_id, joined_at, sessions(start_at, capacity, session_types(category), locations(name), coaches!sessions_coach_id_fkey(admins(name)))), profiles!waiting_list_entries_member_id_fkey(full_name, first_name, last_name)",
      )
      .in("session_id", sessionIds)
      .order("joined_at", { ascending: true });
    if (error) throw new HttpError(500, "Failed to fetch waitlist entries", error);
    return data ?? [];
  }

  async getBookingContext(memberId: string) {
    const { data: activeMembershipId } = await supabaseAdmin.rpc("clm_find_active_membership", {
      p_member_id: memberId,
      p_now: new Date().toISOString(),
    });
    const [{ data: membership }, { data: bookings }, { data: tokens }, { data: profile }] =
      await Promise.all([
        activeMembershipId
          ? supabaseAdmin
            .from("member_memberships")
            .select("*")
            .eq("id", activeMembershipId)
            .single()
          : Promise.resolve({ data: null }),
        supabaseAdmin
          .from("bookings")
          .select("*, sessions(*)")
          .eq("member_id", memberId)
          .order("booked_at", { ascending: false }),
        supabaseAdmin.from("tokens").select("*").eq("member_id", memberId).order("created_at", { ascending: false }),
        supabaseAdmin.from("profiles").select("location_id").eq("id", memberId).maybeSingle(),
      ]);
    return {
      member: { id: memberId, locationId: profile?.location_id ?? null },
      membership: membership ?? null,
      tokens: tokens ?? [],
      upcomingBookings: bookings ?? [],
    };
  }

  async getAvailableSessions(
    memberId: string,
    from?: string,
    to?: string,
    sessionTypeId?: string,
    locationId?: string,
    isOnline?: boolean
  ) {
    const { data: user, error: userError } = await supabaseAdmin.from("profiles").select("*").eq("id", memberId).single();
    if (userError || !user) throw new HttpError(404, "Member not found");

    // Membership eligibility gating via allowance token types.
    const { data: activeMembershipId, error: membershipErr } = await supabaseAdmin.rpc(
      "clm_find_active_membership",
      { p_member_id: memberId, p_now: new Date().toISOString() }
    );
    if (membershipErr) throw new HttpError(500, "Failed to resolve active membership", membershipErr);
    if (!activeMembershipId) return [];

    const { data: allowanceRows, error: allowanceErr } = await supabaseAdmin
      .from("membership_session_allowances")
      .select("token_type_id, weekly_allowance")
      .eq("membership_id", activeMembershipId)
      .gt("weekly_allowance", 0);
    if (allowanceErr) throw new HttpError(500, "Failed to fetch membership allowances", allowanceErr);

    const allowedTokenTypeIds = new Set(
      (allowanceRows ?? [])
        .map((r) => (r as { token_type_id?: string }).token_type_id)
        .filter((v): v is string => Boolean(v))
    );

    const isDateOnly = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v);
    const toStartOfDayUtc = (v: string) => `${v}T00:00:00.000Z`;
    const toEndOfDayUtc = (v: string) => `${v}T23:59:59.999Z`;

    let effectiveFrom = from ?? new Date().toISOString();
    let effectiveTo = to;

    if (from && isDateOnly(from)) effectiveFrom = toStartOfDayUtc(from);
    if (to && isDateOnly(to)) effectiveTo = toEndOfDayUtc(to);
    console.log("[getAvailableSessions] window", {
      memberId,
      now: new Date().toISOString(),
      from: from ?? null,
      to: to ?? null,
      effectiveFrom,
      effectiveTo: effectiveTo ?? null,
      isOnline: isOnline ?? null,
      locationId: locationId ?? null,
    });

    const normalizedSex = String((user as { sex?: string | null }).sex ?? "")
      .trim()
      .toLowerCase();
    const allowedAudiences = new Set<string>(["mixed"]);
    if (normalizedSex === "male" || normalizedSex === "female") {
      allowedAudiences.add(normalizedSex);
    }

    let query = supabaseAdmin
      .from("sessions")
      .select("*, session_types(*), locations(name, slug), coaches!sessions_coach_id_fkey(admins(name))")
      .gte("start_at", effectiveFrom)
      .order("start_at", { ascending: true });
    if (effectiveTo) query = query.lte("start_at", effectiveTo);
    if (sessionTypeId) query = query.eq("session_type_id", sessionTypeId);

    if (isOnline === true) {
      query = query.eq("is_online", true);
    } else {
      query = query.eq("is_online", false);
      const effectiveLocationId = locationId ?? user.location_id;
      if (effectiveLocationId) query = query.eq("location_id", effectiveLocationId);
    }

    const { data: sessions, error } = await query;
    if (error) throw new HttpError(500, "Failed to fetch available sessions", error);
    const memberAccess = await this.getMemberAccessProfile(memberId);
    console.log(memberAccess, "memberAccess");
    const list = (sessions ?? []) as Array<
      Record<string, unknown> & {
        id: string;
        capacity: number;
        coaches?: { admins?: { name?: string } };
        session_types?: { token_type_id?: string; audience?: string | null; name?: string | null; category?: string | null } | null;
        locations?: { name?: string | null; slug?: string | null } | null;
        is_online?: boolean | null;
        location_id?: string | null;
        training_level?: string | null;
      }
    >;
    if (list.length === 0) return [];

    // Enforce allowance gating at token level and audience level.
    const rejectedDebug: Array<{
      sessionId: string;
      reason: string;
      sessionTypeCode?: string;
      sessionCategoryCode?: string;
      trainingLevelCode?: string;
      locationNameCode?: string;
      locationSlugCode?: string;
    }> = [];
    const eligibleList = allowedTokenTypeIds.size
      ? list.filter((s) => {
        const tokenTypeId = s.session_types?.token_type_id;
        const audience = String(s.session_types?.audience ?? "mixed")
          .trim()
          .toLowerCase();
        const audienceAllowed = allowedAudiences.has(audience || "mixed");
        const accessDebug = this.getSessionAccessDebug(memberAccess, s);
        if (!tokenTypeId || !allowedTokenTypeIds.has(String(tokenTypeId))) {
          rejectedDebug.push({ sessionId: String(s.id), reason: "token" });
          return false;
        }
        if (!audienceAllowed) {
          rejectedDebug.push({ sessionId: String(s.id), reason: "audience" });
          return false;
        }
        if (accessDebug.reason) {
          rejectedDebug.push({
            sessionId: String(s.id),
            reason: accessDebug.reason,
            sessionTypeCode: accessDebug.normalized.sessionTypeCode,
            sessionCategoryCode: accessDebug.normalized.sessionCategoryCode,
            trainingLevelCode: accessDebug.normalized.trainingLevelCode,
            locationNameCode: accessDebug.normalized.locationNameCode,
            locationSlugCode: accessDebug.normalized.locationSlugCode,
          });
          return false;
        }
        return true;
      })
      : [];
    if (rejectedDebug.length > 0) {
      console.log("[getAvailableSessions] rejected", rejectedDebug);
    }
    if (eligibleList.length === 0) return [];

    const sessionIds = eligibleList.map((s) => s.id);

    const [bookedCountsRes, memberBookingsRes, memberCancelledBookingsRes, memberWaitlistRes] = await Promise.all([
      supabaseAdmin.from("bookings").select("session_id").in("session_id", sessionIds).eq("status", "booked"),
      supabaseAdmin.from("bookings").select("id, session_id").eq("member_id", memberId).eq("status", "booked").in("session_id", sessionIds),
      supabaseAdmin.from("bookings").select("session_id").eq("member_id", memberId).eq("status", "cancelled").in("session_id", sessionIds),
      supabaseAdmin.from("waiting_list_entries").select("session_id").eq("member_id", memberId).in("session_id", sessionIds),
    ]);

    const bookedBySession = new Map<string, number>();
    for (const row of bookedCountsRes.data ?? []) {
      const sid = (row as { session_id: string }).session_id;
      bookedBySession.set(sid, (bookedBySession.get(sid) ?? 0) + 1);
    }
    const memberBookings = (memberBookingsRes.data ?? []) as Array<{ id: string; session_id: string }>;
    const memberBookedSessionIds = new Set(memberBookings.map((r) => r.session_id));
    const bookingIdBySession = new Map(memberBookings.map((r) => [r.session_id, r.id]));
    const memberCancelledSessionIds = new Set((memberCancelledBookingsRes.data ?? []).map((r) => (r as { session_id: string }).session_id));
    const memberWaitlistSessionIds = new Set((memberWaitlistRes.data ?? []).map((r) => (r as { session_id: string }).session_id));

    return eligibleList.map((s) => {
      const coachName = s.coaches?.admins?.name ?? null;
      const { coaches, ...rest } = s;
      const bookedCount = bookedBySession.get(s.id) ?? 0;
      const isFull = bookedCount >= s.capacity;
      const isBookedByMe = memberBookedSessionIds.has(s.id);
      const isCancelledByMe = memberCancelledSessionIds.has(s.id);
      const isOnWaitlist = memberWaitlistSessionIds.has(s.id);
      const bookingId = isBookedByMe ? (bookingIdBySession.get(s.id) ?? null) : null;
      let status: "open" | "full" | "booked" = isBookedByMe ? "booked" : isFull ? "full" : "open";
      return {
        ...rest,
        coach_user_id: s.coach_id,
        coach_name: coachName,
        booked_count: bookedCount,
        status,
        isBookedByMe,
        isCancelledByMe,
        booking_id: bookingId,
        isOnWaitlist,
      };
    });
  }

  async getSessionDetail(sessionId: string) {
    const { data, error } = await supabaseAdmin
      .from("sessions")
      .select("*, session_types(*), coaches!sessions_coach_id_fkey(admins(name))")
      .eq("id", sessionId)
      .single();
    if (error) throw new HttpError(404, "Session not found", error);
    const s = data as Record<string, unknown> & { coaches?: { admins?: { name?: string } } };
    const coachName = s?.coaches?.admins?.name ?? null;
    const { coaches, ...rest } = s ?? {};
    return {
      ...rest,
      coach_user_id: (s as { coach_id?: string }).coach_id ?? null,
      coach_name: coachName,
    };
  }

  async createBooking(input: { memberId: string; membershipId: string; sessionId: string }) {
    const [memberAccess, sessionRes] = await Promise.all([
      this.getMemberAccessProfile(input.memberId),
      supabaseAdmin
        .from("sessions")
        .select("id, is_online, location_id, training_level, session_types(name, category), locations(name, slug)")
        .eq("id", input.sessionId)
        .single(),
    ]);
    if (sessionRes.error || !sessionRes.data) {
      throw new HttpError(404, "Session not found", sessionRes.error);
    }
    if (!this.isSessionAllowedForMember(memberAccess, sessionRes.data as any)) {
      throw new HttpError(403, "Member is not allowed to book this session");
    }

    const { data, error } = await supabaseAdmin.rpc("clm_create_booking", {
      p_member_id: input.memberId,
      p_membership_id: input.membershipId,
      p_session_id: input.sessionId,
      p_now: new Date().toISOString(),
    });
    if (error) throw new HttpError(422, "Booking failed", error);
    return data;
  }

  async cancelBooking(input: { bookingId: string; memberId: string }) {
    const { data, error } = await supabaseAdmin.rpc("clm_cancel_booking", {
      p_member_id: input.memberId,
      p_booking_id: input.bookingId,
      p_now: new Date().toISOString(),
    });
    if (error) throw new HttpError(422, "Cancellation failed", error);
    return data;
  }

  async joinWaitlist(input: { memberId: string; membershipId: string; sessionId: string }) {
    const [memberAccess, sessionRes] = await Promise.all([
      this.getMemberAccessProfile(input.memberId),
      supabaseAdmin
        .from("sessions")
        .select("id, is_online, location_id, training_level, session_types(name, category), locations(name, slug)")
        .eq("id", input.sessionId)
        .single(),
    ]);
    if (sessionRes.error || !sessionRes.data) {
      throw new HttpError(404, "Session not found", sessionRes.error);
    }
    if (!this.isSessionAllowedForMember(memberAccess, sessionRes.data as any)) {
      throw new HttpError(403, "Member is not allowed to join waitlist for this session");
    }

    const { data, error } = await supabaseAdmin.rpc("clm_join_waitlist", {
      p_member_id: input.memberId,
      p_membership_id: input.membershipId,
      p_session_id: input.sessionId,
      p_now: new Date().toISOString(),
    });
    if (error) throw new HttpError(422, "Failed to join waiting list", error);
    return data;
  }

  async getBookings(memberId: string, status?: string) {
    let query = supabaseAdmin.from("bookings").select("*, sessions(*, session_types(*))").eq("member_id", memberId).order("booked_at", { ascending: false });
    if (status === "upcoming") query = query.eq("status", "booked");
    if (status === "past") query = query.neq("status", "booked");
    const { data, error } = await query;
    if (error) throw new HttpError(500, "Failed to fetch bookings", error);
    return data ?? [];
  }

  async getSessionUsage(memberId: string, view: "past" | "upcoming") {
    const now = new Date();
    let rangeStart: Date;
    let rangeEnd: Date;

    if (view === "past") {
      rangeStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      rangeEnd = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59, 999);
    } else {
      rangeStart = new Date(now.getFullYear(), now.getMonth(), 1);
      rangeEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);
    }

    // Fetch bookings within the date range (join sessions for start_at)
    const { data: bookings, error: bookingsErr } = await supabaseAdmin
      .from("bookings")
      .select(`
        id, status, booked_at, session_id, 
        sessions!inner(id, start_at, end_at, session_type_id, session_types(id, name, color))
      `)
      .eq("member_id", memberId)
      .gte("sessions.start_at", rangeStart.toISOString())
      .lte("sessions.start_at", rangeEnd.toISOString());
    if (bookingsErr) throw new HttpError(500, "Failed to fetch session usage", bookingsErr);

    // Filter to only bookings whose session is actually within the range (inner join filter)
    const filtered = (bookings ?? []).filter(
      (b) => (b as Record<string, unknown>).sessions != null
    );

    // Compute counts
    let attended = 0;
    let missed = 0;
    let cancelled = 0;
    let upcoming = 0;

    const schedule: Array<{
      date: string;
      time: string;
      status: string;
      sessionTypeName: string | null;
      sessionTypeColor: string | null;
      bookingId: string;
      sessionId: string;
    }> = [];

    for (const booking of filtered) {
      const session = (booking as Record<string, unknown>).sessions as {
        id: string;
        start_at: string;
        end_at: string;
        session_types?: { id: string; name: string; color: string | null } | null;
      };

      const sessionStart = new Date(session.start_at);
      const isPast = sessionStart < now;

      if (booking.status === "cancelled") {
        cancelled++;
      } else if (booking.status === "no_show") {
        missed++;
      } else if (booking.status === "booked" && isPast) {
        attended++;
      } else if (booking.status === "booked" && !isPast) {
        upcoming++;
      }

      schedule.push({
        date: session.start_at.split("T")[0],
        time: sessionStart.toTimeString().slice(0, 5),
        status: booking.status === "booked" && isPast ? "attended" : booking.status,
        sessionTypeName: session.session_types?.name ?? null,
        sessionTypeColor: session.session_types?.color ?? null,
        bookingId: booking.id,
        sessionId: session.id,
      });
    }

    // Fetch allowed sessions from membership allowances
    const { data: activeMembershipId } = await supabaseAdmin.rpc("clm_find_active_membership", {
      p_member_id: memberId,
      p_now: now.toISOString(),
    });

    let allowedPerWeek = 0;
    if (activeMembershipId) {
      const { data: allowances } = await supabaseAdmin
        .from("membership_session_allowances")
        .select("weekly_allowance")
        .eq("membership_id", activeMembershipId);
      allowedPerWeek = (allowances ?? []).reduce((sum, a) => sum + (a.weekly_allowance ?? 0), 0);
    }

    const allowed = allowedPerWeek * 4;

    if (view === "past") {
      const usedVal = attended + missed;
      return {
        view: "past",
        attended,
        missed,
        cancelled,
        used: usedVal,
        remaining: Math.max(0, allowed - usedVal),
        unused: Math.max(0, allowed - usedVal),
        allowed,
        schedule,
      };
    }

    return {
      view: "upcoming",
      attended,
      upcoming,
      missed,
      cancelled,
      used: attended + upcoming + missed,
      remaining: Math.max(0, allowed - (attended + upcoming + missed)),
      unused: Math.max(0, allowed - (attended + upcoming + missed)),
      allowed,
      schedule,
    };
  }

  async getUsageTracker(memberId: string, from: string, to: string) {
    const fromDate = new Date(from);
    const toDate = new Date(to);
    const now = new Date();
    const queryNow = now.toISOString();
    const getMonday = (d: Date) => {
      const date = new Date(d);
      const day = date.getDay();
      const diff = date.getDate() - (day === 0 ? 6 : day - 1);
      const monday = new Date(date.setDate(diff));
      monday.setHours(0, 0, 0, 0);
      return monday;
    };

    const firstMonday = getMonday(fromDate);
    const lastMonday = getMonday(toDate);

    const weeks: Array<{ start: Date; end: Date; label: string }> = [];
    let curr = new Date(firstMonday);
    while (curr <= lastMonday) {
      const wStart = new Date(curr);
      const wEnd = new Date(curr.getTime() + 7 * 24 * 60 * 60 * 1000 - 1);
      const label = `${wStart.toLocaleString('default', { month: 'short' })} ${wStart.getDate()} - ${wEnd.toLocaleString('default', { month: 'short' })} ${wEnd.getDate()}`;
      weeks.push({ start: wStart, end: wEnd, label });
      curr.setDate(curr.getDate() + 7);
    }
    const [bookingsRes, waitlistRes, tokensRes, membershipRes] = await Promise.all([
      supabaseAdmin
        .from("bookings")
        .select("id, status, booked_at, session_id, sessions(id, start_at, end_at, session_type_id, session_types(id, name, color)), booking_token_deductions(token_id, token_week_start, tokens(*))")
        .eq("member_id", memberId)
        .gte("sessions.start_at", firstMonday.toISOString())
        .lte("sessions.start_at", new Date(lastMonday.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString()),
      supabaseAdmin
        .from("waiting_list_entries")
        .select("session_id, sessions(id, start_at, session_type_id, session_types(name))")
        .eq("member_id", memberId)
        .gte("sessions.start_at", firstMonday.toISOString()),
      supabaseAdmin
        .from("tokens")
        .select("*")
        .eq("member_id", memberId)
        .gt("expiry_at", queryNow),
      supabaseAdmin.rpc("clm_find_active_membership", { p_member_id: memberId, p_now: queryNow })
    ]);

    const activeMembershipId = membershipRes.data;
    let baseQtyPerWeek = 5; // fallback
    if (activeMembershipId) {
      const { data: allowances } = await supabaseAdmin
        .from("membership_session_allowances")
        .select("weekly_allowance")
        .eq("membership_id", activeMembershipId);
      baseQtyPerWeek = (allowances ?? []).reduce((sum, a) => sum + (a.weekly_allowance ?? 0), 0) || 5;
    }

    const allBookings = (bookingsRes.data ?? []).filter(b => b.sessions != null) as any[];
    const allWaitlist = (waitlistRes.data ?? []).filter(w => w.sessions != null) as any[];
    const allTokens = tokensRes.data ?? [];

    return weeks.map(week => {
      const wStartIso = week.start.toISOString();
      const nextWStartIso = new Date(week.start.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();
      // Bookings in this week
      const weekBookings = allBookings.filter(b => {
        const s = Array.isArray(b.sessions) ? b.sessions[0] : b.sessions;
        return s && s.start_at >= wStartIso && s.start_at < nextWStartIso;
      });
      const weekWaitlist = allWaitlist.filter(w => {
        const s = Array.isArray(w.sessions) ? w.sessions[0] : w.sessions;
        return s && s.start_at >= wStartIso && s.start_at < nextWStartIso;
      });
      const unusedCurrentWeekTokens = [...allTokens].filter(t => t.week_start === wStartIso && t.quantity > 0 && t.source === 'weekly');
      const circles: Array<{ status: "attended" | "waitlist" | "lost" | "rollover_used" | "future_used" | "available"; date?: string }> = [];
      // 1. Process bookings in this week
      for (const b of weekBookings) {
        const s = Array.isArray(b.sessions) ? b.sessions[0] : b.sessions;
        const deduction = (b.booking_token_deductions as any)?.[0];
        const tokenWeekStart = deduction?.token_week_start;
        const sessionDate = s.start_at.split('T')[0];
        let status: any = "attended";
        if (b.status === "no_show" || (b.status === "cancelled" && !deduction?.tokens)) {
          status = "lost";
        } else if (b.status === "cancelled") {
          continue;
        } else if (b.status === "no_show") {
          status = "lost";
        } else if (tokenWeekStart) {
          if (tokenWeekStart < wStartIso) status = "rollover_used";
          else if (tokenWeekStart > wStartIso) status = "future_used";
          else status = "attended";
        }
        circles.push({ status, date: sessionDate });
      }

      for (const w of weekWaitlist) {
        const s = Array.isArray(w.sessions) ? w.sessions[0] : w.sessions;
        circles.push({ status: "waitlist", date: s.start_at.split('T')[0] });
      }

      const baseCircles = circles.filter(c => c.status === "attended" || c.status === "lost" || c.status === "waitlist");
      const extraCircles = circles.filter(c => c.status === "rollover_used" || c.status === "future_used");
      const finalCircles: typeof circles = [];

      for (let i = 0; i < baseQtyPerWeek; i++) {
        if (baseCircles[i]) {
          finalCircles.push(baseCircles[i]);
        } else if (unusedCurrentWeekTokens.length > 0) {
          unusedCurrentWeekTokens.pop();
          finalCircles.push({ status: "available" });
        } else {
          finalCircles.push({ status: "available" });
        }
      }
      if (baseCircles.length > baseQtyPerWeek) {
        finalCircles.push(...baseCircles.slice(baseQtyPerWeek));
      }

      finalCircles.push(...extraCircles);
      const currentWeekOtherTokens = allTokens.filter(t => t.week_start !== wStartIso && t.quantity > 0 && t.source === 'weekly');
      const adminBonusTokens = allTokens.filter(t => t.source !== 'weekly' && t.quantity > 0);

      for (const t of currentWeekOtherTokens) {
        for (let i = 0; i < t.quantity; i++) finalCircles.push({ status: "available" });
      }
      for (const t of adminBonusTokens) {
        for (let i = 0; i < t.quantity; i++) finalCircles.push({ status: "available" });
      }

      const tally = {
        attended: finalCircles.filter(c => c.status === "attended").length,
        waitlist: finalCircles.filter(c => c.status === "waitlist").length,
        lost: finalCircles.filter(c => c.status === "lost").length,
        available: finalCircles.filter(c => c.status === "available").length,
        rollover_used: finalCircles.filter(c => c.status === "rollover_used").length,
        future_used: finalCircles.filter(c => c.status === "future_used").length
      };

      return {
        weekStart: wStartIso,
        label: week.label,
        counts: tally,
        remaining: tally.available,
        unused: tally.available,
        lost: tally.lost
      };
    });
  }

  async getAdminBookingById(bookingId: string) {
    const { data, error } = await supabaseAdmin
      .from("bookings")
      .select(
        "*, sessions(*, session_types(*)), profiles!bookings_member_id_fkey(id, full_name, email, first_name, last_name, phone, role, location_id)"
      )
      .eq("id", bookingId)
      .maybeSingle();
    if (error) throw new HttpError(500, "Failed to fetch booking", error);
    if (!data) throw new HttpError(404, "Booking not found");
    return data;
  }

  async listAdminBookings(filters: {
    from?: string;
    to?: string;
    memberId?: string;
    sessionId?: string;
    status?: "booked" | "cancelled" | "no_show";
    limit?: number;
  }) {
    const limit = Math.min(filters.limit ?? 200, 500);
    let sessionIdsInRange: string[] | undefined;
    if (filters.from != null || filters.to != null) {
      let sq = supabaseAdmin.from("sessions").select("id");
      if (filters.from) sq = sq.gte("start_at", filters.from);
      if (filters.to) sq = sq.lte("start_at", filters.to);
      const { data: sessRows, error: sessErr } = await sq;
      if (sessErr) throw new HttpError(500, "Failed to resolve sessions for date filter", sessErr);
      sessionIdsInRange = (sessRows ?? []).map((r) => (r as { id: string }).id);
      if (sessionIdsInRange.length === 0) return [];
    }

    let query = supabaseAdmin
      .from("bookings")
      .select(
        "*, sessions(*, session_types(*)), profiles!bookings_member_id_fkey(id, full_name, email, first_name, last_name, phone, role, location_id)"
      )
      .order("booked_at", { ascending: false })
      .limit(limit);

    if (filters.memberId) query = query.eq("member_id", filters.memberId);
    if (filters.sessionId) query = query.eq("session_id", filters.sessionId);
    if (filters.status) query = query.eq("status", filters.status);
    if (sessionIdsInRange) query = query.in("session_id", sessionIdsInRange);

    const { data, error } = await query;
    if (error) throw new HttpError(500, "Failed to fetch bookings", error);
    return data ?? [];
  }

  async adminRemoveMember(input: { bookingId: string; refund: "refund" | "charge"; adminId: string }) {
    const { data, error } = await supabaseAdmin.rpc("clm_admin_remove_member", {
      p_admin_id: input.adminId,
      p_booking_id: input.bookingId,
      p_refund: input.refund,
      p_now: new Date().toISOString(),
    });
    if (error) throw new HttpError(422, "Admin remove-member failed", error);
    return data;
  }

  async adminMarkNoShow(input: { bookingId: string; adminId: string }) {
    const { data: booking, error: fetchErr } = await supabaseAdmin
      .from("bookings")
      .select("*, sessions(*)")
      .eq("id", input.bookingId)
      .single();
    if (fetchErr || !booking) throw new HttpError(404, "Booking not found");
    if (booking.status !== "booked") throw new HttpError(422, `Cannot mark as no_show: booking status is '${booking.status}'`);
    const session = (booking as Record<string, unknown>).sessions as { start_at: string } | null;
    if (!session) throw new HttpError(422, "Session not found for this booking");
    if (new Date(session.start_at) > new Date()) throw new HttpError(422, "Cannot mark no_show before the session has started");

    const { error: updateErr } = await supabaseAdmin
      .from("bookings")
      .update({ status: "no_show" })
      .eq("id", input.bookingId);
    if (updateErr) throw new HttpError(500, "Failed to update booking status", updateErr);

    await supabaseAdmin.from("audit_logs").insert({
      actor_type: "admin",
      actor_id: input.adminId,
      action: "booking.admin_mark_no_show",
      meta: { bookingId: input.bookingId },
    });

    return { ok: true, bookingId: input.bookingId, status: "no_show" };
  }

  async adminCancelSession(input: { sessionId: string; refund: "refund" | "charge"; adminId: string }) {
    console.log("adminCancelSession", input);
    const { data, error } = await supabaseAdmin.rpc("clm_admin_cancel_session", {
      p_admin_id: input.adminId,
      p_session_id: input.sessionId,
      p_refund: input.refund,
      p_now: new Date().toISOString(),
    });
    if (error) throw new HttpError(422, "Admin cancel-session failed", error);
    return data;
  }
}
