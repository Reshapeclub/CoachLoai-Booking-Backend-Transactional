import { supabaseAdmin } from "../db/supabase.js";
import { HttpError } from "../lib/http-error.js";
import {
  assertBookableStartNotPast,
  ukBookingNowIso,
  ukDayBoundsUtcIso,
} from "../lib/uk-booking-time.js";

/** Must match `clm_cancel_booking` refund window (hours before session start). */
const BOOKING_REFUND_WINDOW_HOURS = 24;

function isLateCancellationBooking(
  status: string,
  cancelledAt: string | null | undefined,
  sessionStartAt: string,
): boolean {
  if (status !== "cancelled") return false;
  const sessionStartMs = new Date(sessionStartAt).getTime();
  if (!Number.isFinite(sessionStartMs)) return false;
  if (!cancelledAt) {
    // Legacy rows without cancelled_at: treat past sessions as lost.
    return sessionStartMs <= Date.now();
  }
  const cancelledMs = new Date(cancelledAt).getTime();
  if (!Number.isFinite(cancelledMs)) return sessionStartMs <= Date.now();
  const hoursUntilStart = (sessionStartMs - cancelledMs) / 3_600_000;
  return hoursUntilStart < BOOKING_REFUND_WINDOW_HOURS;
}

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

  /** Codes saved on `member_training_levels.level_code` (admin Member > Sessions). */
  private readonly memberTrainingLevelCodes = new Set([
    "mastery",
    "beast",
    "charged",
    "noncharged",
    "culture",
    "skill",
    "pwr",
  ]);

  private normalizeAccessCode(value: unknown): string {
    return String(value ?? "")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "");
  }

  /** Resolve membership for a browse window (supports future membership start dates). */
  private async findMembershipForWindow(
    memberId: string,
    windowStartIso: string,
    windowEndIso?: string,
  ): Promise<string | null> {
    const startMs = new Date(windowStartIso).getTime();
    const endMs = windowEndIso ? new Date(windowEndIso).getTime() : NaN;
    const windowEnd =
      windowEndIso && Number.isFinite(endMs)
        ? windowEndIso
        : new Date(
            (Number.isFinite(startMs) ? startMs : Date.now()) + 28 * 86400000,
          ).toISOString();

    const { data, error } = await supabaseAdmin.rpc("clm_find_membership_overlapping_window", {
      p_member_id: memberId,
      p_window_start: windowStartIso,
      p_window_end: windowEnd,
    });
    if (error) throw new HttpError(500, "Failed to resolve membership for window", error);
    return data ? String(data) : null;
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

  /**
   * Map `sessions.training_level` and session type labels to member level codes.
   * Schedule often stores Elite/Octave levels as session-type titles (e.g. "Mastery"), not ids.
   */
  private resolveSessionTrainingLevelCodes(session: {
    training_level?: string | null;
    session_types?: { name?: string | null; category?: string | null } | Array<{ name?: string | null; category?: string | null }> | null;
  }): Set<string> {
    const sessionType = Array.isArray(session.session_types)
      ? session.session_types[0]
      : session.session_types;
    const rawLevel = this.normalizeAccessCode(session.training_level);
    const typeName = this.normalizeAccessCode(sessionType?.name);
    const codes = new Set<string>();

    // Row-level level (e.g. charged / noncharged) is authoritative — avoid substring false positives.
    if (rawLevel && this.memberTrainingLevelCodes.has(rawLevel)) {
      codes.add(rawLevel);
      return codes;
    }

    const sortedCodes = [...this.memberTrainingLevelCodes].sort((a, b) => b.length - a.length);
    for (const hay of [rawLevel, typeName].filter(Boolean)) {
      for (const code of sortedCodes) {
        if (hay === code) {
          codes.add(code);
          break;
        }
        if (!hay.includes(code)) continue;
        const hasLongerMatch = sortedCodes.some(
          (longer) => longer.length > code.length && hay.includes(longer),
        );
        if (!hasLongerMatch) {
          codes.add(code);
          break;
        }
      }
    }

    return codes;
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

    // Training level: when member has an allow-list in DB, session must map to at least one allowed code.
    // 1:1 sessions are exempt. Elite/Octave/Group use charged/noncharged or level names on the session row.
    const bypassTrainingLevelCheck = sessionTypeCode === "11" || sessionCategoryCode === "11";
    if (!bypassTrainingLevelCheck && access.trainingLevels.size > 0) {
      const sessionLevelCodes = this.resolveSessionTrainingLevelCodes(session);
      const levelAllowed =
        sessionLevelCodes.size > 0 &&
        [...sessionLevelCodes].some((code) => access.trainingLevels.has(code));
      if (!levelAllowed) {
        return { reason: "training_level", normalized: { sessionTypeCode, sessionCategoryCode, trainingLevelCode, locationNameCode, locationSlugCode } };
      }
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
    let query = supabaseAdmin
      .from("waiting_list_entries")
      .select(
        "id, session_id, member_id, joined_at, sessions!inner(start_at, capacity, session_types(category), locations(name), coaches!sessions_coach_id_fkey(admins(name)))), profiles!waiting_list_entries_member_id_fkey(full_name, first_name, last_name)",
      )
      .order("joined_at", { ascending: true });
    if (filters.from) query = query.gte("sessions.start_at", filters.from);
    if (filters.to) query = query.lte("sessions.start_at", filters.to);

    const { data, error } = await query;
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
    const isDateOnly = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v);
    const toEndOfDayUtc = (v: string) => {
      const bounds = ukDayBoundsUtcIso(v);
      if (bounds) {
        const end = new Date(bounds.to);
        end.setMilliseconds(end.getMilliseconds() - 1);
        return end.toISOString();
      }
      return `${v}T23:59:59.999Z`;
    };

    const nowIso = ukBookingNowIso();
    let effectiveFrom = from ?? nowIso;
    let effectiveTo = to;
    if (from && isDateOnly(from)) {
      const bounds = ukDayBoundsUtcIso(from);
      effectiveFrom = bounds?.from ?? `${from}T00:00:00.000Z`;
    }
    if (to && isDateOnly(to)) effectiveTo = toEndOfDayUtc(to);

    const membershipWindowEnd =
      effectiveTo ??
      new Date(new Date(effectiveFrom).getTime() + 28 * 86400000).toISOString();

    const sessionTypesSelect =
      "session_types(id, name, category, token_type_id, audience, default_capacity, default_duration_mins, max_per_day, color, category_icon, icon, display_order, is_active)";
    const sessionsSelect = `*, ${sessionTypesSelect}, locations(name, slug), coaches!sessions_coach_id_fkey(admins(name, photo_url))`;

    const [{ data: user, error: userError }, activeMembershipId, memberAccess] = await Promise.all([
      supabaseAdmin.from("profiles").select("sex, location_id").eq("id", memberId).single(),
      this.findMembershipForWindow(memberId, effectiveFrom, membershipWindowEnd),
      this.getMemberAccessProfile(memberId),
    ]);

    if (userError || !user) throw new HttpError(404, "Member not found");
    if (!activeMembershipId) return [];

    let sessionsQuery = supabaseAdmin
      .from("sessions")
      .select(sessionsSelect)
      .gte("start_at", effectiveFrom)
      .eq("is_cancelled", false)
      .is("deleted_at", null)
      .order("start_at", { ascending: true });
    if (effectiveTo) sessionsQuery = sessionsQuery.lte("start_at", effectiveTo);
    if (sessionTypeId) sessionsQuery = sessionsQuery.eq("session_type_id", sessionTypeId);
    if (isOnline === true) {
      sessionsQuery = sessionsQuery.eq("is_online", true);
    } else {
      sessionsQuery = sessionsQuery.eq("is_online", false);
      const effectiveLocationId = locationId ?? (user as { location_id?: string | null }).location_id;
      if (effectiveLocationId) sessionsQuery = sessionsQuery.eq("location_id", effectiveLocationId);
    }

    const [{ data: allowanceRows, error: allowanceErr }, { data: sessions, error }, { data: membershipRow, error: membershipRowErr }] =
      await Promise.all([
        supabaseAdmin
          .from("membership_session_allowances")
          .select("token_type_id, weekly_allowance")
          .eq("membership_id", activeMembershipId)
          .gt("weekly_allowance", 0),
        sessionsQuery,
        supabaseAdmin
          .from("member_memberships")
          .select("start_date, end_date, termination_date")
          .eq("id", activeMembershipId)
          .single(),
      ]);

    if (allowanceErr) throw new HttpError(500, "Failed to fetch membership allowances", allowanceErr);
    if (error) throw new HttpError(500, "Failed to fetch available sessions", error);
    if (membershipRowErr) {
      throw new HttpError(500, "Failed to load membership dates", membershipRowErr);
    }

    const allowedTokenTypeIds = new Set(
      (allowanceRows ?? [])
        .map((r) => (r as { token_type_id?: string }).token_type_id)
        .filter((v): v is string => Boolean(v)),
    );

    const normalizedSex = String((user as { sex?: string | null }).sex ?? "")
      .trim()
      .toLowerCase();
    const allowedAudiences = new Set<string>(["mixed"]);
    if (normalizedSex === "male" || normalizedSex === "female") {
      allowedAudiences.add(normalizedSex);
    }

    type CoachAdmin = { name?: string | null; photo_url?: string | null };
    type SessionRow = Record<string, unknown> & {
      id: string;
      start_at?: string;
      capacity: number;
      coaches?: { admins?: CoachAdmin | CoachAdmin[] };
      session_types?: { token_type_id?: string; audience?: string | null; name?: string | null; category?: string | null } | null;
      locations?: { name?: string | null; slug?: string | null } | null;
      is_online?: boolean | null;
      location_id?: string | null;
      training_level?: string | null;
    };

    const membershipStartMs = membershipRow?.start_date
      ? new Date(String(membershipRow.start_date)).getTime()
      : null;
    const membershipEndMs = membershipRow?.end_date
      ? new Date(String(membershipRow.end_date)).getTime()
      : null;
    const membershipTermMs = membershipRow?.termination_date
      ? new Date(String(membershipRow.termination_date)).getTime()
      : null;

    const list = ((sessions ?? []) as SessionRow[]).filter((s) => {
      const startMs = new Date(String(s.start_at ?? "")).getTime();
      if (!Number.isFinite(startMs)) return false;
      if (membershipStartMs != null && Number.isFinite(membershipStartMs) && startMs < membershipStartMs) {
        return false;
      }
      if (membershipEndMs != null && Number.isFinite(membershipEndMs) && startMs >= membershipEndMs) {
        return false;
      }
      if (membershipTermMs != null && Number.isFinite(membershipTermMs) && startMs >= membershipTermMs) {
        return false;
      }
      return true;
    });
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
    if (rejectedDebug.length > 0 && process.env.NODE_ENV !== "production") {
      console.log("[getAvailableSessions] rejected", rejectedDebug);
    }
    if (eligibleList.length === 0) return [];

    const sessionIds = eligibleList.map((s) => s.id);

    const [{ data: bookedRows }, { data: memberBkRows }, { data: wlRows }] = await Promise.all([
      supabaseAdmin.from("bookings").select("session_id").in("session_id", sessionIds).eq("status", "booked"),
      supabaseAdmin
        .from("bookings")
        .select("id, session_id, status")
        .eq("member_id", memberId)
        .in("session_id", sessionIds)
        .in("status", ["booked", "cancelled"])
        .order("booked_at", { ascending: false }),
      supabaseAdmin.from("waiting_list_entries").select("session_id").eq("member_id", memberId).in("session_id", sessionIds),
    ]);

    const bookedBySession = new Map<string, number>();
    for (const row of bookedRows ?? []) {
      const sid = (row as { session_id: string }).session_id;
      bookedBySession.set(sid, (bookedBySession.get(sid) ?? 0) + 1);
    }
    const memberBookedSessionIds = new Set<string>();
    const memberCancelledSessionIds = new Set<string>();
    /** Latest booking id per session (booked_at desc): active or cancelled. */
    const memberBookingIdBySession = new Map<string, string>();
    for (const row of memberBkRows ?? []) {
      const r = row as { id: string; session_id: string; status: string };
      if (r.status === "booked") memberBookedSessionIds.add(r.session_id);
      else if (r.status === "cancelled") memberCancelledSessionIds.add(r.session_id);
      if (!memberBookingIdBySession.has(r.session_id)) {
        memberBookingIdBySession.set(r.session_id, r.id);
      }
    }
    const memberWaitlistSessionIds = new Set((wlRows ?? []).map((r) => (r as { session_id: string }).session_id));

    const coachAdminFromSession = (s: (typeof list)[number]): CoachAdmin | null => {
      const raw = s.coaches?.admins;
      if (raw == null) return null;
      return Array.isArray(raw) ? raw[0] ?? null : raw;
    };

    return eligibleList.map((s) => {
      const admin = coachAdminFromSession(s);
      const coachName = admin?.name != null ? String(admin.name) : null;
      const photo = admin?.photo_url != null ? String(admin.photo_url).trim() : "";
      const profileImgUrl = photo.length > 0 ? photo : null;
      const { coaches, ...rest } = s;
      const bookedCount = bookedBySession.get(s.id) ?? 0;
      const isFull = bookedCount >= s.capacity;
      const isBookedByMe = memberBookedSessionIds.has(s.id);
      const isCancelledByMe = memberCancelledSessionIds.has(s.id);
      const isOnWaitlist = memberWaitlistSessionIds.has(s.id);
      const hasBookedThisSession = memberBookingIdBySession.has(s.id);
      const bookingId = hasBookedThisSession ? (memberBookingIdBySession.get(s.id) ?? null) : null;
      let status: "open" | "full" | "booked" = isBookedByMe ? "booked" : isFull ? "full" : "open";
      return {
        ...rest,
        coach_user_id: s.coach_id,
        coach_name: coachName,
        profile_img_url: profileImgUrl,
        booked_count: bookedCount,
        status,
        isBookedByMe,
        isCancelledByMe,
        booking_id: bookingId,
        isOnWaitlist,
      };
    });
  }

  /**
   * Returns membership session allowance summary for schedule tab:
   */
  async getMembershipSessionAllowanceSummary(memberId: string) {
    const nowIso = ukBookingNowIso();
    const windowEnd = new Date(Date.now() + 28 * 86400000).toISOString();
    const activeMembershipId = await this.findMembershipForWindow(memberId, nowIso, windowEnd);
    if (!activeMembershipId) return [];

    const { data: allowanceRows, error: allowanceErr } = await supabaseAdmin
      .from("membership_session_allowances")
      .select("token_type_id, weekly_allowance")
      .eq("membership_id", activeMembershipId)
      .gt("weekly_allowance", 0);
    if (allowanceErr) throw new HttpError(500, "Failed to fetch membership allowances", allowanceErr);
    const rows = (allowanceRows ?? []) as Array<{ token_type_id: string; weekly_allowance: number }>;
    if (rows.length === 0) return [];

    const tokenTypeIds = Array.from(new Set(rows.map((r) => String(r.token_type_id)).filter(Boolean)));
    const { data: sessionTypes, error: stErr } = await supabaseAdmin
      .from("session_types")
      .select("id, name, category, token_type_id, display_order, is_active")
      .in("token_type_id", tokenTypeIds)
      .order("display_order", { ascending: true })
      .order("created_at", { ascending: true });
    if (stErr) throw new HttpError(500, "Failed to fetch session type labels", stErr);

    const stByToken = new Map<string, { session_type_id: string | null; label: string; category: string | null }>();
    for (const st of (sessionTypes ?? []) as Array<Record<string, unknown>>) {
      const tokenTypeId = String(st.token_type_id ?? "");
      if (!tokenTypeId || stByToken.has(tokenTypeId)) continue;
      const category = st.category != null ? String(st.category) : null;
      const name = st.name != null ? String(st.name) : null;
      stByToken.set(tokenTypeId, {
        session_type_id: st.id != null ? String(st.id) : null,
        label: (category && category.trim()) || (name && name.trim()) || "Session",
        category,
      });
    }

    return rows.map((r) => {
      const meta = stByToken.get(String(r.token_type_id));
      return {
        token_type_id: String(r.token_type_id),
        weekly_allowance: Number(r.weekly_allowance) || 0,
        session_type_id: meta?.session_type_id ?? null,
        label: meta?.label ?? "Session",
        category: meta?.category ?? null,
      };
    });
  }

  async getSessionDetail(sessionId: string) {
    const sessionTypesSelect =
      "session_types(id, name, category, token_type_id, audience, default_capacity, default_duration_mins, max_per_day, color, category_icon, icon, display_order, is_active)";
    const { data, error } = await supabaseAdmin
      .from("sessions")
      .select(`*, ${sessionTypesSelect}, coaches!sessions_coach_id_fkey(admins(name, photo_url))`)
      .eq("id", sessionId)
      .is("deleted_at", null)
      .single();
    if (error) throw new HttpError(404, "Session not found", error);
    type CoachAdmin = { name?: string | null; photo_url?: string | null };
    const s = data as Record<string, unknown> & { coaches?: { admins?: CoachAdmin | CoachAdmin[] } };
    const adminsRaw = s?.coaches?.admins;
    const admin = adminsRaw == null ? null : Array.isArray(adminsRaw) ? adminsRaw[0] ?? null : adminsRaw;
    const coachName = admin?.name != null ? String(admin.name) : null;
    const photo = admin?.photo_url != null ? String(admin.photo_url).trim() : "";
    const profileImgUrl = photo.length > 0 ? photo : null;
    const { coaches, ...rest } = s ?? {};
    return {
      ...rest,
      coach_user_id: (s as { coach_id?: string }).coach_id ?? null,
      coach_name: coachName,
      profile_img_url: profileImgUrl,
    };
  }

  async createBooking(input: { memberId: string; membershipId: string; sessionId: string }) {
    const [memberAccess, sessionRes] = await Promise.all([
      this.getMemberAccessProfile(input.memberId),
      supabaseAdmin
        .from("sessions")
        .select("id, start_at, is_online, location_id, training_level, session_types(name, category), locations(name, slug)")
        .eq("id", input.sessionId)
        .is("deleted_at", null)
        .single(),
    ]);
    if (sessionRes.error || !sessionRes.data) {
      throw new HttpError(404, "Session not found", sessionRes.error);
    }
    if (!this.isSessionAllowedForMember(memberAccess, sessionRes.data as any)) {
      throw new HttpError(403, "Member is not allowed to book this session");
    }

    const sessionRow = sessionRes.data as { start_at: string };
    assertBookableStartNotPast(String(sessionRow.start_at ?? ""));

    const nowIso = ukBookingNowIso();
    const { data, error } = await supabaseAdmin.rpc("clm_create_booking", {
      p_member_id: input.memberId,
      p_membership_id: input.membershipId,
      p_session_id: input.sessionId,
      p_now: nowIso,
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

  /** Rebook the same session after cancel — re-activates the cancelled row (avoids member+session unique constraint). */
  async rebookBooking(input: { bookingId: string; memberId: string; membershipId?: string }) {
    let membershipId = input.membershipId?.trim();
    if (!membershipId) {
      const nowIso = ukBookingNowIso();
      const { data: activeMembershipId, error: memErr } = await supabaseAdmin.rpc(
        "clm_find_active_membership",
        { p_member_id: input.memberId, p_now: nowIso },
      );
      if (memErr) throw new HttpError(500, "Failed to resolve active membership", memErr);
      if (!activeMembershipId) throw new HttpError(422, "No active membership");
      membershipId = String(activeMembershipId);
    }

    const { data, error } = await supabaseAdmin.rpc("clm_rebook_booking", {
      p_member_id: input.memberId,
      p_booking_id: input.bookingId,
      p_membership_id: membershipId,
      p_now: ukBookingNowIso(),
    });
    if (error) throw new HttpError(422, "Rebook failed", error);

    const payload =
      data && typeof data === "object" && !Array.isArray(data)
        ? { ...(data as Record<string, unknown>) }
        : { ok: true, result: data };
    return { ...payload, rebookedFromBookingId: input.bookingId };
  }

  async joinWaitlist(input: { memberId: string; membershipId: string; sessionId: string }) {
    const [memberAccess, sessionRes] = await Promise.all([
      this.getMemberAccessProfile(input.memberId),
      supabaseAdmin
        .from("sessions")
        .select("id, start_at, is_online, location_id, training_level, session_types(name, category), locations(name, slug)")
        .eq("id", input.sessionId)
        .is("deleted_at", null)
        .single(),
    ]);
    if (sessionRes.error || !sessionRes.data) {
      throw new HttpError(404, "Session not found", sessionRes.error);
    }
    if (!this.isSessionAllowedForMember(memberAccess, sessionRes.data as any)) {
      throw new HttpError(403, "Member is not allowed to join waitlist for this session");
    }

    const sessionRow = sessionRes.data as { start_at: string };
    assertBookableStartNotPast(String(sessionRow.start_at ?? ""));

    const nowIso = ukBookingNowIso();
    const { data, error } = await supabaseAdmin.rpc("clm_join_waitlist", {
      p_member_id: input.memberId,
      p_membership_id: input.membershipId,
      p_session_id: input.sessionId,
      p_now: nowIso,
    });
    if (error) throw new HttpError(422, "Failed to join waiting list", error);
    return data;
  }

  async getBookings(memberId: string, status?: string) {
    let query = supabaseAdmin
      .from("bookings")
      .select(
        "*, sessions(*, session_types(*), locations(name), coaches!sessions_coach_id_fkey(admins(name)))",
      )
      .eq("member_id", memberId)
      .order("booked_at", { ascending: false });
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
        id, status, booked_at, cancelled_at, session_id,
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
    let lost = 0;
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
      const cancelledAt = (booking as { cancelled_at?: string | null }).cancelled_at;
      let scheduleStatus: string;

      if (booking.status === "cancelled") {
        if (isLateCancellationBooking(booking.status, cancelledAt, session.start_at)) {
          lost++;
          scheduleStatus = "lost";
        } else {
          cancelled++;
          scheduleStatus = "cancelled";
        }
      } else if (booking.status === "no_show") {
        missed++;
        lost++;
        scheduleStatus = "lost";
      } else if (booking.status === "booked" && isPast) {
        attended++;
        scheduleStatus = "attended";
      } else if (booking.status === "booked" && !isPast) {
        upcoming++;
        scheduleStatus = "booked";
      } else {
        scheduleStatus = String(booking.status ?? "booked");
      }

      schedule.push({
        date: session.start_at.split("T")[0],
        time: sessionStart.toTimeString().slice(0, 5),
        status: scheduleStatus,
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
      const usedVal = attended + lost;
      return {
        view: "past",
        attended,
        missed,
        lost,
        cancelled,
        used: usedVal,
        remaining: Math.max(0, allowed - usedVal),
        unused: Math.max(0, allowed - usedVal),
        allowed,
        schedule,
      };
    }

    const usedVal = attended + upcoming + lost;
    return {
      view: "upcoming",
      attended,
      upcoming,
      missed,
      lost,
      cancelled,
      used: usedVal,
      remaining: Math.max(0, allowed - usedVal),
      unused: Math.max(0, allowed - usedVal),
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
        .select("id, status, booked_at, cancelled_at, session_id, sessions(id, start_at, end_at, session_type_id, session_types(id, name, color)), booking_token_deductions(token_id, token_week_start, tokens(*))")
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
      const wStartMs = new Date(wStartIso).getTime();
      const nextWStartMs = new Date(nextWStartIso).getTime();
      // Bookings in this week
      const weekBookings = allBookings.filter(b => {
        const s = Array.isArray(b.sessions) ? b.sessions[0] : b.sessions;
        const sessionStartMs = s?.start_at ? new Date(String(s.start_at)).getTime() : NaN;
        return Number.isFinite(sessionStartMs) && sessionStartMs >= wStartMs && sessionStartMs < nextWStartMs;
      });
      const weekWaitlist = allWaitlist.filter(w => {
        const s = Array.isArray(w.sessions) ? w.sessions[0] : w.sessions;
        const sessionStartMs = s?.start_at ? new Date(String(s.start_at)).getTime() : NaN;
        return Number.isFinite(sessionStartMs) && sessionStartMs >= wStartMs && sessionStartMs < nextWStartMs;
      });
      const unusedCurrentWeekTokens = [...allTokens].filter(t => {
        if (!(t.quantity > 0 && t.source === "weekly" && t.week_start)) return false;
        const tokenWeekStartMs = new Date(String(t.week_start)).getTime();
        return Number.isFinite(tokenWeekStartMs) && tokenWeekStartMs === wStartMs;
      });
      const circles: Array<{ status: "attended" | "waitlist" | "lost" | "rollover_used" | "future_used" | "available"; date?: string }> = [];
      // 1. Process bookings in this week
      for (const b of weekBookings) {
        const s = Array.isArray(b.sessions) ? b.sessions[0] : b.sessions;
        const deduction = (b.booking_token_deductions as any)?.[0];
        const tokenWeekStart = deduction?.token_week_start;
        const sessionDate = s.start_at.split('T')[0];
        let status: any = "attended";
        if (b.status === "no_show") {
          status = "lost";
        } else if (b.status === "cancelled") {
          if (isLateCancellationBooking(b.status, b.cancelled_at, s.start_at)) {
            status = "lost";
          } else {
            continue;
          }
        } else if (tokenWeekStart) {
          const tokenWeekStartMs = new Date(String(tokenWeekStart)).getTime();
          if (Number.isFinite(tokenWeekStartMs) && tokenWeekStartMs < wStartMs) status = "rollover_used";
          else if (Number.isFinite(tokenWeekStartMs) && tokenWeekStartMs > wStartMs) status = "future_used";
          else status = "attended";
        }
        circles.push({ status, date: sessionDate });
      }

      for (const w of weekWaitlist) {
        const s = Array.isArray(w.sessions) ? w.sessions[0] : w.sessions;
        circles.push({ status: "waitlist", date: s.start_at.split('T')[0] });
      }

      const baseCircles = circles.filter(c => c.status === "attended" || c.status === "lost" || c.status === "waitlist");
      // const extraCircles = circles.filter(c => c.status === "rollover_used" || c.status === "future_used");
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
      // if (baseCircles.length > baseQtyPerWeek) {
      //   finalCircles.push(...baseCircles.slice(baseQtyPerWeek));
      // }

      // finalCircles.push(...extraCircles);
      // const currentWeekOtherTokens = allTokens.filter(t => t.week_start !== wStartIso && t.quantity > 0 && t.source === 'weekly');
      // const adminBonusTokens = allTokens.filter(t => t.source !== 'weekly' && t.quantity > 0);

      // for (const t of currentWeekOtherTokens) {
      //   for (let i = 0; i < t.quantity; i++) finalCircles.push({ status: "available" });
      // }
      // for (const t of adminBonusTokens) {
      //   for (let i = 0; i < t.quantity; i++) finalCircles.push({ status: "available" });
      // }

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
    if (filters.from) query = query.gte("sessions.start_at", filters.from);
    if (filters.to) query = query.lte("sessions.start_at", filters.to);

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

  /**
   * Move an active booking to another session (Re-Shape §19.2).
   * Token types must match. Optional eligibility override for admin.
   */
  async adminMoveBookingToSession(input: {
    bookingId: string;
    targetSessionId: string;
    adminId: string | number;
    overrideEligibility?: boolean;
  }) {
    const { data: booking, error: bErr } = await supabaseAdmin
      .from("bookings")
      .select(
        "id, member_id, status, session_id, sessions(id, token_type_id, start_at, end_at, location_id, is_cancelled, capacity, training_level, is_online, session_types(name, category), locations(name, slug))",
      )
      .eq("id", input.bookingId)
      .single();
    if (bErr || !booking) throw new HttpError(404, "Booking not found");
    const b = booking as Record<string, unknown>;
    if (String(b.status) !== "booked") throw new HttpError(422, "Only active (booked) rows can be moved");
    const memberId = String(b.member_id);
    const sourceSession = b.sessions as Record<string, unknown> | null;
    if (!sourceSession) throw new HttpError(422, "Source session missing");

    const { data: target, error: tErr } = await supabaseAdmin
      .from("sessions")
      .select(
        "id, token_type_id, start_at, end_at, location_id, is_cancelled, capacity, training_level, is_online, session_types(name, category), locations(name, slug)",
      )
      .eq("id", input.targetSessionId)
      .is("deleted_at", null)
      .single();
    if (tErr || !target) throw new HttpError(404, "Target session not found");
    const tgt = target as Record<string, unknown>;
    if (tgt.is_cancelled === true) throw new HttpError(422, "Target session is cancelled");
    if (String(sourceSession.id) === String(tgt.id)) throw new HttpError(400, "Member is already on this session");

    const srcTok = String(sourceSession.token_type_id ?? "");
    const tgtTok = String(tgt.token_type_id ?? "");
    if (srcTok !== tgtTok) {
      throw new HttpError(
        400,
        "Cannot move between sessions with different token types. Remove and rebook, or pick a session with the same token type.",
      );
    }

    const access = await this.getMemberAccessProfile(memberId);
    const sessionForGate = {
      is_online: tgt.is_online,
      location_id: tgt.location_id,
      training_level: tgt.training_level,
      session_types: tgt.session_types,
      locations: tgt.locations,
    };
    if (!input.overrideEligibility && !this.isSessionAllowedForMember(access, sessionForGate as any)) {
      throw new HttpError(
        403,
        "Member is not eligible for the target session. Confirm override in the admin UI to proceed.",
      );
    }

    const tgtStart = String(tgt.start_at);
    const { data: otherBookings, error: obErr } = await supabaseAdmin
      .from("bookings")
      .select("id, sessions(start_at)")
      .eq("member_id", memberId)
      .eq("status", "booked")
      .neq("id", input.bookingId);
    if (obErr) throw new HttpError(500, "Failed to check duplicate booking time", obErr);
    const tgtMs = new Date(tgtStart).getTime();
    for (const row of otherBookings ?? []) {
      const sess = (row as { sessions?: { start_at?: string } | null }).sessions;
      const st = sess?.start_at;
      if (st && new Date(st).getTime() === tgtMs) {
        throw new HttpError(400, "Member already has another booking at this time");
      }
    }

    const { count: capCt, error: capErr } = await supabaseAdmin
      .from("bookings")
      .select("*", { count: "exact", head: true })
      .eq("session_id", input.targetSessionId)
      .eq("status", "booked");
    if (capErr) throw new HttpError(500, "Failed to check target session capacity", capErr);
    const cap = Number(tgt.capacity ?? 0);
    if ((capCt ?? 0) >= cap) throw new HttpError(400, "Target session is full");

    const { error: updErr } = await supabaseAdmin
      .from("bookings")
      .update({ session_id: input.targetSessionId })
      .eq("id", input.bookingId);
    if (updErr) throw new HttpError(500, "Failed to move booking", updErr);

    const { count: dedCount, error: dedCountErr } = await supabaseAdmin
      .from("booking_token_deductions")
      .select("*", { count: "exact", head: true })
      .eq("booking_id", input.bookingId);
    if (!dedCountErr && (dedCount ?? 0) > 0) {
      const { error: dedErr } = await supabaseAdmin
        .from("booking_token_deductions")
        .update({ token_type_id: tgtTok })
        .eq("booking_id", input.bookingId);
      if (dedErr) throw new HttpError(500, "Failed to sync token deduction row", dedErr);
    }

    const actorId =
      typeof input.adminId === "string" && /^[0-9a-f-]{36}$/i.test(input.adminId) ? input.adminId : null;
    await supabaseAdmin.from("audit_logs").insert({
      actor_type: "admin",
      actor_id: actorId,
      action: "booking.admin_move_session",
      meta: {
        bookingId: input.bookingId,
        memberId,
        fromSessionId: sourceSession.id,
        toSessionId: input.targetSessionId,
        overrideEligibility: Boolean(input.overrideEligibility),
      },
    });

    await supabaseAdmin.from("notifications").insert([
      {
        member_id: memberId,
        channel: "in_app",
        type: "booking_moved",
        payload: { bookingId: input.bookingId, sessionId: input.targetSessionId },
      },
      {
        member_id: memberId,
        channel: "email",
        type: "booking_moved",
        payload: { bookingId: input.bookingId, sessionId: input.targetSessionId },
      },
    ]);

    return { ok: true as const, bookingId: input.bookingId, sessionId: input.targetSessionId };
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
