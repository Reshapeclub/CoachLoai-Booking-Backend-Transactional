import { supabaseAdmin } from "../db/supabase.js";
import { HttpError } from "../lib/http-error.js";
import { TokenService } from "./token-service.js";
import {
  cancelAdminNutritionPlan,
  cancelAdminTrainingPlan,
  getActiveNutritionPlanForMembership,
  loadMembershipPlanQueues,
  mapNutritionPlanForDashboard,
  queueAdminNutritionPlan,
  queueAdminTrainingPlan,
  upsertAdminNutritionCurrent,
} from "./membership-plan-service.js";

type MembershipMode = "inperson" | "remote";
type PlanTier = "structure" | "pace" | "performance";

function toDateOnly(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toISOString().slice(0, 10);
}

function extractTimeFromIso(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString("en-GB", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZone: "Europe/London",
  });
}

function unwrapJoinedRow<T extends Record<string, unknown>>(value: T | T[] | null | undefined): T | null {
  if (!value) return null;
  return Array.isArray(value) ? (value[0] ?? null) : value;
}

function coachNameFromSession(session: Record<string, unknown> | null): string {
  if (!session) return "";
  const coaches = unwrapJoinedRow(
    session.coaches as Record<string, unknown> | Record<string, unknown>[] | null | undefined,
  );
  if (!coaches) return "";
  const adminsRaw = coaches.admins;
  const admin = Array.isArray(adminsRaw) ? adminsRaw[0] : adminsRaw;
  return String((admin as { name?: string } | undefined)?.name ?? "").trim();
}

function locationNameFromSession(session: Record<string, unknown> | null): string {
  if (!session) return "";
  const location = unwrapJoinedRow(
    session.locations as Record<string, unknown> | Record<string, unknown>[] | null | undefined,
  );
  return String(location?.name ?? "").trim();
}

function normalizeDashboardMode(value: string | undefined): MembershipMode {
  return String(value || "")
    .trim()
    .toLowerCase() === "remote"
    ? "remote"
    : "inperson";
}

function membershipHasActivePlanWindow(membership: MembershipRow | null): boolean {
  if (!membership) return false;
  const status = String(membership.status ?? "active").trim().toLowerCase();
  if (status === "terminated" || status === "ended") return false;
  const termMs = membership.termination_date
    ? new Date(String(membership.termination_date)).getTime()
    : NaN;
  if (Number.isFinite(termMs) && termMs <= Date.now()) return false;
  const today = toDateOnly(new Date().toISOString());
  const endYmd = toDateOnly(membership.end_date);
  if (endYmd && endYmd < today) return false;
  const startYmd = toDateOnly(membership.start_date);
  if (startYmd && startYmd > today) return false;
  return true;
}

function categoryToSessionAllocKey(category: string): "oneToOne" | "elite" | "octave" | "group" | null {
  const c = String(category || "").trim();
  if (c === "1:1") return "oneToOne";
  if (c === "Elite") return "elite";
  if (c === "Octave") return "octave";
  if (c === "Group") return "group";
  return null;
}

function clampAlloc(n: number): number {
  return Math.max(0, Math.min(7, Math.trunc(n)));
}

type MembershipRow = {
  id: string;
  member_id: string;
  mode: MembershipMode;
  current_package: PlanTier;
  is_paused: boolean;
  status: string;
  start_date: string;
  end_date: string;
  termination_date: string | null;
  created_at: string;
  updated_at: string;
};

function normalizePlanTierValue(v: unknown): PlanTier {
  const s = String(v ?? "pace")
    .trim()
    .toLowerCase();
  if (s === "structure") return "structure";
  if (s === "performance") return "performance";
  return "pace";
}

function parseCalendarDateToStartIso(dateStr: string): string {
  const s = String(dateStr).trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (m) {
    const y = Number(m[1]);
    const mo = Number(m[2]);
    const d = Number(m[3]);
    return new Date(Date.UTC(y, mo - 1, d, 0, 0, 0, 0)).toISOString();
  }
  const t = new Date(s);
  if (Number.isNaN(t.getTime())) throw new HttpError(400, "Invalid date");
  return new Date(
    Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate(), 0, 0, 0, 0),
  ).toISOString();
}

/** Monday 00:00 UTC — matches `clm_current_week_start` in SQL. */
function currentWeekStartFromInstant(iso: string): string {
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) throw new HttpError(400, "Invalid datetime");
  const day = new Date(
    Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate(), 0, 0, 0, 0),
  );
  const dow = day.getUTCDay();
  const mondayOffset = dow === 0 ? -6 : 1 - dow;
  day.setUTCDate(day.getUTCDate() + mondayOffset);
  return day.toISOString();
}

function weekStartFromDateYmd(dateYmd: string): string {
  return currentWeekStartFromInstant(parseCalendarDateToStartIso(dateYmd));
}

/** Inclusive calendar days between two YYYY-MM-DD values. */
function inclusiveCalendarDaysBetween(startYmd: string, endYmd: string): number {
  const startMs = new Date(parseCalendarDateToStartIso(startYmd)).getTime();
  const endMs = new Date(parseCalendarDateToStartIso(endYmd)).getTime();
  if (endMs < startMs) return 0;
  return Math.floor((endMs - startMs) / 86400000) + 1;
}

/** Pause weeks from an inclusive calendar span (7 days → 1 week, not 2 Mondays). */
function pauseWeekCountFromInclusiveDates(startYmd: string, endYmd: string): number {
  const days = inclusiveCalendarDaysBetween(startYmd, endYmd);
  return days > 0 ? Math.max(1, Math.ceil(days / 7)) : 1;
}

function weekStartPlusWeeks(weekStartIso: string, weeksAfter: number): string {
  const d = new Date(weekStartIso);
  d.setUTCDate(d.getUTCDate() + weeksAfter * 7);
  return d.toISOString();
}

/**
 * Map admin pause calendar dates to Monday week bounds for `clm_apply_membership_pause`.
 * Using Monday of both start and end dates can span 2 weeks for a 7-day range (e.g. Tue → next Mon).
 */
function resolvePauseWeekRangeFromDates(
  startDateYmd: string,
  endDateYmd: string,
  explicitWeekCount?: number,
): { startWeek: string; endWeekInclusive: string; pauseWeekCount: number } {
  const startWeek = weekStartFromDateYmd(startDateYmd);
  const pauseWeekCount =
    explicitWeekCount && explicitWeekCount > 0
      ? explicitWeekCount
      : pauseWeekCountFromInclusiveDates(startDateYmd, endDateYmd);
  const endWeekInclusive = weekStartPlusWeeks(startWeek, pauseWeekCount - 1);
  return { startWeek, endWeekInclusive, pauseWeekCount };
}

type CancelMembershipPauseRpcResult = {
  ok?: boolean;
  removedWeeks?: number;
  reversedDays?: number;
  endDate?: string;
  isPaused?: boolean;
};

async function cancelMembershipPauseRpc(
  membershipId: string,
  opts: {
    pauseWeekIds?: string[] | null;
    reverseExtensions?: boolean;
  },
): Promise<CancelMembershipPauseRpcResult> {
  const { data, error } = await supabaseAdmin.rpc("clm_cancel_membership_pause", {
    p_membership_id: membershipId,
    p_pause_week_ids: opts.pauseWeekIds ?? null,
    p_reverse_extensions: opts.reverseExtensions !== false,
  });
  if (error) {
    throw new HttpError(500, "Failed to cancel membership pause", error);
  }
  return (data ?? {}) as CancelMembershipPauseRpcResult;
}

function parseCalendarDateToEndIso(dateStr: string): string {
  const s = String(dateStr).trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (m) {
    const y = Number(m[1]);
    const mo = Number(m[2]);
    const d = Number(m[3]);
    return new Date(Date.UTC(y, mo - 1, d, 23, 59, 59, 999)).toISOString();
  }
  const t = new Date(s);
  if (Number.isNaN(t.getTime())) throw new HttpError(400, "Invalid end date");
  return new Date(
    Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate(), 23, 59, 59, 999),
  ).toISOString();
}

export class MembershipService {
  #normalizeCodeList(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    return Array.from(
      new Set(
        value
          .map((item) => String(item ?? "").trim().toLowerCase())
          .filter((item) => item.length > 0),
      ),
    );
  }

  async putAdminMemberMembershipAccess(
    memberId: string,
    body: {
      member_locations?: string[];
      training_level?: string[];
      session_access?: string[];
    },
  ) {
    const { data: profile, error: profileErr } = await supabaseAdmin
      .from("profiles")
      .select("id")
      .eq("id", memberId)
      .maybeSingle();
    if (profileErr) throw new HttpError(500, "Failed to verify member", profileErr);
    if (!profile) throw new HttpError(404, "Member not found");

    const memberLocations = this.#normalizeCodeList(body.member_locations);
    const trainingLevels = this.#normalizeCodeList(body.training_level);
    const sessionAccess = this.#normalizeCodeList(body.session_access);

    const { error: clearLocErr } = await supabaseAdmin
      .from("member_location_access")
      .delete()
      .eq("member_id", memberId);
    if (clearLocErr) {
      throw new HttpError(500, "Failed to clear member location access", clearLocErr);
    }
    if (memberLocations.length) {
      const { error: insertLocErr } = await supabaseAdmin
        .from("member_location_access")
        .insert(
          memberLocations.map((locationCode) => ({
            member_id: memberId,
            location_code: locationCode,
          })),
        );
      if (insertLocErr) {
        throw new HttpError(500, "Failed to save member location access", insertLocErr);
      }
    }

    const { error: clearTrainingErr } = await supabaseAdmin
      .from("member_training_levels")
      .delete()
      .eq("member_id", memberId);
    if (clearTrainingErr) {
      throw new HttpError(500, "Failed to clear member training levels", clearTrainingErr);
    }
    if (trainingLevels.length) {
      const { error: insertTrainingErr } = await supabaseAdmin
        .from("member_training_levels")
        .insert(
          trainingLevels.map((levelCode) => ({
            member_id: memberId,
            level_code: levelCode,
          })),
        );
      if (insertTrainingErr) {
        throw new HttpError(500, "Failed to save member training levels", insertTrainingErr);
      }
    }

    const { error: clearSessionAccessErr } = await supabaseAdmin
      .from("member_session_access")
      .delete()
      .eq("member_id", memberId);
    if (clearSessionAccessErr) {
      throw new HttpError(500, "Failed to clear member session access", clearSessionAccessErr);
    }
    if (sessionAccess.length) {
      const { error: insertSessionAccessErr } = await supabaseAdmin
        .from("member_session_access")
        .insert(
          sessionAccess.map((accessCode) => ({
            member_id: memberId,
            session_code: accessCode,
          })),
        );
      if (insertSessionAccessErr) {
        throw new HttpError(500, "Failed to save member session access", insertSessionAccessErr);
      }
    }

    return {
      member_locations: memberLocations,
      training_level: trainingLevels,
      session_access: sessionAccess,
    };
  }

  async createMembership(input: {
    memberId: string;
    mode: MembershipMode;
    currentPackage?: PlanTier;
    startDate: string;
    endDate: string;
  }) {
    const { data, error } = await supabaseAdmin
      .from("member_memberships")
      .insert({
        member_id: input.memberId,
        mode: input.mode,
        current_package: input.currentPackage ?? "pace",
        status: "active",
        start_date: input.startDate,
        end_date: input.endDate,
      })
      .select()
      .single();
    if (error) throw new HttpError(500, "Failed to create membership", error);
    return data;
  }

  async getMembershipById(membershipId: string) {
    const { data, error } = await supabaseAdmin
      .from("member_memberships")
      .select("*")
      .eq("id", membershipId)
      .single();
    if (error) throw new HttpError(404, "Membership not found", error);
    return data;
  }

  async updateMembership(
    membershipId: string,
    updates: {
      mode?: MembershipMode;
      currentPackage?: PlanTier;
      isPaused?: boolean;
      status?: "active" | "paused" | "ended" | "terminated";
      startDate?: string;
      endDate?: string | null;
      terminationDate?: string | null;
    }
  ) {
    const payload: Record<string, unknown> = {};
    if (updates.mode !== undefined) payload.mode = updates.mode;
    if (updates.currentPackage !== undefined) payload.current_package = updates.currentPackage;
    if (updates.isPaused !== undefined) payload.is_paused = updates.isPaused;
    if (updates.status !== undefined) payload.status = updates.status;
    if (updates.startDate !== undefined) payload.start_date = updates.startDate;
    if (updates.endDate !== undefined) payload.end_date = updates.endDate;
    if (updates.terminationDate !== undefined) payload.termination_date = updates.terminationDate;

    const { data, error } = await supabaseAdmin
      .from("member_memberships")
      .update(payload)
      .eq("id", membershipId)
      .select()
      .single();
    if (error) throw new HttpError(500, "Failed to update membership", error);
    return data;
  }

  async pauseMembership(input: {
    membershipId: string;
    startWeek: string;
    endWeekInclusive: string;
  }) {
    const { data, error } = await supabaseAdmin.rpc("clm_apply_membership_pause", {
      p_membership_id: input.membershipId,
      p_start_week: input.startWeek,
      p_end_week_inclusive: input.endWeekInclusive,
    });
    if (error) throw new HttpError(500, "Failed to pause membership", error);
    return data as {
      ok: boolean;
      pauseId: string;
      cancelledBookings: number;
      startDate: string;
      endDate: string;
    };
  }

  async resumeMembership(membershipId: string) {
    await cancelMembershipPauseRpc(membershipId, { reverseExtensions: true });
    const { data, error } = await supabaseAdmin
      .from("member_memberships")
      .select("*")
      .eq("id", membershipId)
      .single();
    if (error) throw new HttpError(500, "Failed to load membership after resume", error);
    return data;
  }

  async cancelMembershipPause(input: {
    membershipId: string;
    pauseId?: string;
    reverseExtensions?: boolean;
    startWeek?: string;
    endWeekInclusive?: string;
    startDateYmd?: string;
    endDateYmd?: string;
    /** `all` removes every pause week row for the membership (admin cancel). */
    cancelScope?: "single" | "range" | "all";
  }) {
    const reverseExtensions = input.reverseExtensions !== false;
    const { data: membership, error: membershipErr } = await supabaseAdmin
      .from("member_memberships")
      .select("id, end_date")
      .eq("id", input.membershipId)
      .maybeSingle();
    if (membershipErr) throw new HttpError(500, "Failed to load membership", membershipErr);
    if (!membership) throw new HttpError(404, "Membership not found");

    let pauseWeekIds: string[] | null = null;
    if (input.cancelScope !== "all") {
      pauseWeekIds = [];
      const startWeek =
        input.startWeek ??
        (input.startDateYmd ? weekStartFromDateYmd(input.startDateYmd) : undefined);
      const endWeek =
        input.endWeekInclusive ??
        (input.endDateYmd ? weekStartFromDateYmd(input.endDateYmd) : undefined);

      if (startWeek && endWeek) {
        const rangeStart = currentWeekStartFromInstant(startWeek);
        const rangeEnd = currentWeekStartFromInstant(endWeek);
        const { data: rangeRows, error: rangeErr } = await supabaseAdmin
          .from("membership_pause_weeks")
          .select("id")
          .eq("membership_id", input.membershipId)
          .gte("week_start", rangeStart)
          .lte("week_start", rangeEnd);
        if (rangeErr) throw new HttpError(500, "Failed to load pauses in date range", rangeErr);
        pauseWeekIds = (rangeRows ?? []).map((row) => String((row as { id: string }).id));
      } else if (input.pauseId) {
        const { data: pauseRow, error: pauseErr } = await supabaseAdmin
          .from("membership_pause_weeks")
          .select("id")
          .eq("membership_id", input.membershipId)
          .eq("id", input.pauseId)
          .maybeSingle();
        if (pauseErr) throw new HttpError(500, "Failed to load membership pause", pauseErr);
        if (pauseRow?.id) pauseWeekIds = [String(pauseRow.id)];
      }

      if (!pauseWeekIds.length) {
        const { data: allRows, error: allErr } = await supabaseAdmin
          .from("membership_pause_weeks")
          .select("id")
          .eq("membership_id", input.membershipId);
        if (allErr) throw new HttpError(500, "Failed to load membership pauses", allErr);
        pauseWeekIds = (allRows ?? []).map((row) => String((row as { id: string }).id));
      }

      if (!pauseWeekIds.length) {
        await supabaseAdmin
          .from("member_memberships")
          .update({ is_paused: false, updated_at: new Date().toISOString() })
          .eq("id", input.membershipId);
        return {
          ok: true,
          removedWeeks: 0,
          reversedDays: 0,
          isPaused: false,
          endDate: String((membership as { end_date?: string | null }).end_date ?? "") || null,
        };
      }
    }

    const rpcResult = await cancelMembershipPauseRpc(input.membershipId, {
      pauseWeekIds,
      reverseExtensions,
    });
    const removedWeeks = Math.max(0, Number(rpcResult.removedWeeks ?? 0));
    const reversedDays = Math.max(0, Number(rpcResult.reversedDays ?? removedWeeks * 7));
    const endDate = rpcResult.endDate
      ? String(rpcResult.endDate)
      : String((membership as { end_date?: string | null }).end_date ?? "") || null;

    return {
      ok: true,
      removedWeeks,
      reversedDays,
      isPaused: Boolean(rpcResult.isPaused),
      endDate,
    };
  }

  async #resolveDashboardMembership(
    memberId: string,
    modeInput?: string,
  ): Promise<MembershipRow> {
    const { data: profile, error: profileErr } = await supabaseAdmin
      .from("profiles")
      .select("id")
      .eq("id", memberId)
      .maybeSingle();
    if (profileErr) throw new HttpError(500, "Failed to verify member", profileErr);
    if (!profile) throw new HttpError(404, "Member not found");

    const mode = normalizeDashboardMode(modeInput);
    const { data: membershipRows, error: mmErr } = await supabaseAdmin
      .from("member_memberships")
      .select("*")
      .eq("member_id", memberId);
    if (mmErr) throw new HttpError(500, "Failed to load memberships", mmErr);
    const rows = (membershipRows ?? []) as MembershipRow[];
    const membership =
      rows.find((r) => r.mode === mode) ??
      rows.find((r) => r.status === "active") ??
      rows[0] ??
      null;
    if (!membership) {
      throw new HttpError(404, "Membership not found for member");
    }
    return membership;
  }

  async pauseAdminMemberMembership(
    memberId: string,
    body: Record<string, unknown>,
  ) {
    const membership = await this.#resolveDashboardMembership(
      memberId,
      typeof body.mode === "string" ? body.mode : undefined,
    );

    const startWeekRaw =
      (typeof body.startWeek === "string" && body.startWeek) ||
      (typeof body.start_week === "string" && body.start_week) ||
      "";
    const endWeekRaw =
      (typeof body.endWeekInclusive === "string" && body.endWeekInclusive) ||
      (typeof body.end_week_inclusive === "string" && body.end_week_inclusive) ||
      "";

    const startDateYmd =
      (typeof body.start_date === "string" && body.start_date) ||
      (typeof body.startDate === "string" && body.startDate) ||
      "";
    const endDateYmd =
      (typeof body.end_date === "string" && body.end_date) ||
      (typeof body.endDate === "string" && body.endDate) ||
      "";

    const weeksFromBody = Math.max(
      0,
      Math.round(
        Number(
          body.weeks ??
            body.pauseWeeks ??
            body.pause_weeks ??
            0,
        ),
      ),
    );

    let startWeek = "";
    let endWeekInclusive = "";
    if (startDateYmd && endDateYmd) {
      const resolved = resolvePauseWeekRangeFromDates(
        startDateYmd,
        endDateYmd,
        weeksFromBody > 0 ? weeksFromBody : undefined,
      );
      startWeek = resolved.startWeek;
      endWeekInclusive = resolved.endWeekInclusive;
    } else if (startWeekRaw && endWeekRaw) {
      startWeek = currentWeekStartFromInstant(startWeekRaw);
      endWeekInclusive = currentWeekStartFromInstant(endWeekRaw);
    }
    if (!startWeek || !endWeekInclusive) {
      throw new HttpError(400, "Pause requires start and end dates");
    }
    if (startWeek > endWeekInclusive) {
      throw new HttpError(400, "Pause start must be on or before pause end");
    }

    const rpcResult = await this.pauseMembership({
      membershipId: membership.id,
      startWeek,
      endWeekInclusive,
    });

    const { data: pauseWeeks, error: pauseErr } = await supabaseAdmin
      .from("membership_pause_weeks")
      .select("id, week_start")
      .eq("membership_id", membership.id)
      .gte("week_start", startWeek)
      .lte("week_start", endWeekInclusive)
      .order("week_start", { ascending: true });
    if (pauseErr) throw new HttpError(500, "Failed to load pause weeks after apply", pauseErr);

    const weekRows = (pauseWeeks ?? []) as Array<{ id: string; week_start: string }>;
    const pauseIds = weekRows.map((row) => String(row.id));
    const primaryPauseId = pauseIds[0] ?? "";
    const rangeStart = toDateOnly(startWeek);
    const lastWeekStart = weekRows.length
      ? weekRows[weekRows.length - 1].week_start
      : endWeekInclusive;
    const rangeEndMs = new Date(lastWeekStart).getTime() + 6 * 86400000;
    const rangeEnd = toDateOnly(new Date(rangeEndMs).toISOString());
    const insertedWeeks = Math.max(
      0,
      Number((rpcResult as { insertedWeeks?: number }).insertedWeeks ?? pauseIds.length),
    );

    const { data: refreshedMembership, error: refreshMmErr } = await supabaseAdmin
      .from("member_memberships")
      .select("end_date, is_paused")
      .eq("id", membership.id)
      .maybeSingle();
    if (refreshMmErr) {
      throw new HttpError(500, "Failed to load membership after pause", refreshMmErr);
    }
    const membershipEndYmd = refreshedMembership?.end_date
      ? toDateOnly(String(refreshedMembership.end_date))
      : "";

    return {
      ok: true,
      pause: {
        id: primaryPauseId,
        pauseId: primaryPauseId,
        pause_id: primaryPauseId,
        pauseIds,
        startDate: rangeStart,
        start_date: rangeStart,
        endDate: rangeEnd,
        end_date: rangeEnd,
        weeks: insertedWeeks || pauseIds.length || 1,
        insertedWeeks,
        cancelledBookings: Number(
          (rpcResult as { cancelledBookings?: number }).cancelledBookings ?? 0,
        ),
        newEndDate: (rpcResult as { newEndDate?: string }).newEndDate ?? null,
      },
      current: {
        id: primaryPauseId,
        pauseId: primaryPauseId,
        pause_id: primaryPauseId,
        startDate: rangeStart,
        start_date: rangeStart,
        endDate: rangeEnd,
        end_date: rangeEnd,
      },
      membership: {
        id: membership.id,
        isPaused: true,
        is_paused: true,
        endDate: membershipEndYmd,
        end_date: membershipEndYmd,
      },
    };
  }

  async cancelAdminMemberMembershipPause(
    memberId: string,
    body: Record<string, unknown>,
  ) {
    const membership = await this.#resolveDashboardMembership(
      memberId,
      typeof body.mode === "string" ? body.mode : undefined,
    );

    const pauseId =
      (typeof body.pause_id === "string" && body.pause_id) ||
      (typeof body.pauseId === "string" && body.pauseId) ||
      undefined;
    const startDateYmd =
      (typeof body.start_date === "string" && body.start_date) ||
      (typeof body.startDate === "string" && body.startDate) ||
      "";
    const endDateYmd =
      (typeof body.end_date === "string" && body.end_date) ||
      (typeof body.endDate === "string" && body.endDate) ||
      "";

    const uuidRe =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    const validPauseId = pauseId && uuidRe.test(pauseId) ? pauseId : undefined;

    const result = await this.cancelMembershipPause({
      membershipId: membership.id,
      pauseId: validPauseId,
      reverseExtensions:
        body.reverse_extensions !== false && body.reverseExtensions !== false,
      startDateYmd: startDateYmd || undefined,
      endDateYmd: endDateYmd || undefined,
      startWeek: startDateYmd ? weekStartFromDateYmd(startDateYmd) : undefined,
      endWeekInclusive: endDateYmd ? weekStartFromDateYmd(endDateYmd) : undefined,
      cancelScope: "all",
    });

    const endYmd = result.endDate ? toDateOnly(String(result.endDate)) : "";

    return {
      ...result,
      pause: {
        history: [],
        pauseHistory: [],
        planPaused: false,
        is_paused: false,
        current: null,
      },
      membership: {
        id: membership.id,
        isPaused: false,
        is_paused: false,
        endDate: endYmd,
        end_date: endYmd,
      },
    };
  }

  async resumeAdminMemberMembershipPause(
    memberId: string,
    body: Record<string, unknown>,
  ) {
    const membership = await this.#resolveDashboardMembership(
      memberId,
      typeof body.mode === "string" ? body.mode : undefined,
    );
    const data = await this.resumeMembership(membership.id);
    return {
      ok: true,
      membership: data,
      isPaused: false,
      is_paused: false,
    };
  }

  async terminateMembership(input: { membershipId: string; terminationDate: string }) {
    const { data, error } = await supabaseAdmin
      .from("member_memberships")
      .update({ termination_date: input.terminationDate, status: "terminated", updated_at: new Date().toISOString() })
      .eq("id", input.membershipId)
      .select()
      .single();
    if (error) throw new HttpError(500, "Failed to terminate membership", error);
    return data;
  }

  async applyTrainingAllocationsFromPlan(
    membershipId: string,
    allocations: Array<{ allocation_key: string; allocation_value: number }>,
  ) {
    const alloc = this.#extractSessionAllocFromTrainingBody({
      allocations: allocations.map((row) => ({
        allocation_key: row.allocation_key,
        allocation_value: row.allocation_value,
      })),
    });
    await this.#syncMembershipSessionAllowances(membershipId, alloc);
  }

  async addSessionAllowance(input: {
    membershipId: string;
    tokenTypeId: string;
    weeklyAllowance: number;
  }) {
    const { data, error } = await supabaseAdmin
      .from("membership_session_allowances")
      .upsert(
        {
          membership_id: input.membershipId,
          token_type_id: input.tokenTypeId,
          weekly_allowance: input.weeklyAllowance,
        },
        { onConflict: "membership_id,token_type_id" }
      )
      .select()
      .single();
    if (error) throw new HttpError(500, "Failed to add session allowance", error);
    return data;
  }

  async addAllowedSessionType(input: { membershipId: string; sessionTypeId: string }) {
    const { data, error } = await supabaseAdmin
      .from("membership_allowed_session_types")
      .insert({
        membership_id: input.membershipId,
        session_type_id: input.sessionTypeId,
      })
      .select()
      .single();
    if (error) throw new HttpError(500, "Failed to add allowed session type", error);
    return data;
  }

  /**
   * 
   * (GET /admin/members/:memberId/membership).
   */
  async getAdminMemberMembershipAggregate(
    memberId: string,
    opts: { mode?: string },
    bookingRows: Array<Record<string, unknown>>,
  ) {
    const { data: profile, error: profileErr } = await supabaseAdmin
      .from("profiles")
      .select("id")
      .eq("id", memberId)
      .maybeSingle();
    if (profileErr) throw new HttpError(500, "Failed to verify member", profileErr);
    if (!profile) throw new HttpError(404, "Member not found");

    const mode = normalizeDashboardMode(opts.mode);
    const { data: membershipRows, error: mmErr } = await supabaseAdmin
      .from("member_memberships")
      .select("*")
      .eq("member_id", memberId);
    if (mmErr) throw new HttpError(500, "Failed to load memberships", mmErr);
    const rows = (membershipRows ?? []) as MembershipRow[];
    const membership =
      rows.find((r) => r.mode === mode) ?? rows.find((r) => r.status === "active") ?? rows[0] ?? null;

    let transactionalMembershipId = "";
    if (membership) {
      const membershipRecord = membership as MembershipRow & {
        membership_id?: string | null;
      };
      transactionalMembershipId = String(membershipRecord.membership_id ?? "").trim();
      if (!transactionalMembershipId) {
        const { data: activeMembershipId, error: activeMembershipErr } =
          await supabaseAdmin.rpc("clm_find_active_membership", {
            p_member_id: memberId,
            p_now: new Date().toISOString(),
          });
        if (activeMembershipErr) {
          throw new HttpError(
            500,
            "Failed to resolve transactional membership id",
            activeMembershipErr,
          );
        }
        transactionalMembershipId = String(activeMembershipId ?? "").trim();
      }
    }

    const membershipPayload = membership
      ? {
          id: membership.id,
          transactionalMembershipId,
          transactional_membership_id: transactionalMembershipId,
          memberId: membership.member_id,
          mode: membership.mode,
          currentPackage: membership.current_package,
          current_package: membership.current_package,
          isPaused: membership.is_paused,
          is_paused: membership.is_paused,
          status: membership.status,
          startDate: toDateOnly(membership.start_date),
          start_date: toDateOnly(membership.start_date),
          endDate: toDateOnly(membership.end_date),
          end_date: toDateOnly(membership.end_date),
          terminationDate: membership.termination_date
            ? toDateOnly(membership.termination_date)
            : null,
          termination_date: membership.termination_date,
          createdAt: membership.created_at,
          updatedAt: membership.updated_at,
        }
      : null;

    const allocations: Record<"oneToOne" | "elite" | "octave" | "group", number> = {
      oneToOne: 0,
      elite: 0,
      octave: 0,
      group: 0,
    };

    if (membership) {
      const { data: allowances, error: alErr } = await supabaseAdmin
        .from("membership_session_allowances")
        .select("token_type_id, weekly_allowance")
        .eq("membership_id", membership.id);
      if (alErr) throw new HttpError(500, "Failed to load session allowances", alErr);
      const tokenIds = [...new Set((allowances ?? []).map((a) => String((a as { token_type_id: string }).token_type_id)))];
      if (tokenIds.length) {
        const { data: stRows, error: stErr } = await supabaseAdmin
          .from("session_types")
          .select("token_type_id, category")
          .in("token_type_id", tokenIds);
        if (stErr) throw new HttpError(500, "Failed to resolve session types for allowances", stErr);
        const categoryByToken = new Map<string, string>();
        for (const st of stRows ?? []) {
          const row = st as { token_type_id: string; category: string };
          if (!categoryByToken.has(row.token_type_id)) categoryByToken.set(row.token_type_id, row.category);
        }
        for (const a of allowances ?? []) {
          const row = a as { token_type_id: string; weekly_allowance: number };
          const cat = categoryByToken.get(row.token_type_id);
          const key = cat ? categoryToSessionAllocKey(cat) : null;
          if (key) {
            const next = (allocations[key] ?? 0) + (row.weekly_allowance ?? 0);
            allocations[key] = clampAlloc(next);
          }
        }
      }
    }

    const trainingPlanShape = {
      planType: "fixed" as const,
      plan_type: "fixed" as const,
      startDate: membershipPayload?.startDate ?? "",
      start_date: membershipPayload?.start_date ?? "",
      endDate: membershipPayload?.endDate ?? "",
      end_date: membershipPayload?.end_date ?? "",
      allocations: { ...allocations },
      alloc: { ...allocations },
    };

    // Admin "current" plan is always member_memberships dates (not the next queued plan).
    const trainingCurrent =
      membership &&
      membershipPayload &&
      String(membership.status ?? "").trim().toLowerCase() === "active"
        ? trainingPlanShape
        : null;
    const trainingCoversToday = Boolean(
      membership && membershipHasActivePlanWindow(membership),
    );

    let pauseHistory: Array<Record<string, unknown>> = [];
    let activePause: Record<string, unknown> | null = null;
    const membershipIsPaused = Boolean(membership?.is_paused);
    if (membership) {
      if (!membershipIsPaused) {
        const { data: staleRows, error: staleLoadErr } = await supabaseAdmin
          .from("membership_pause_weeks")
          .select("id")
          .eq("membership_id", membership.id);
        if (staleLoadErr) {
          throw new HttpError(500, "Failed to load stale membership pause weeks", staleLoadErr);
        }
        const staleCount = (staleRows ?? []).length;
        if (staleCount > 0) {
          await cancelMembershipPauseRpc(membership.id, { reverseExtensions: true });
        }
      }

      const { data: pauseWeeks, error: pErr } = await supabaseAdmin
        .from("membership_pause_weeks")
        .select("id, week_start")
        .eq("membership_id", membership.id)
        .order("week_start", { ascending: true });
      if (pErr) throw new HttpError(500, "Failed to load membership pauses", pErr);
      const weekRows = membershipIsPaused
        ? ((pauseWeeks ?? []) as Array<{ id: string; week_start: string }>)
        : [];
      if (membershipIsPaused && weekRows.length > 0) {
        const first = weekRows[0];
        const last = weekRows[weekRows.length - 1];
        const rangeStart = toDateOnly(first.week_start);
        const rangeEndMs = new Date(last.week_start).getTime() + 6 * 86400000;
        const rangeEnd = toDateOnly(new Date(rangeEndMs).toISOString());
        const pausedWeekCount = weekRows.length;
        const consolidatedPause = {
          id: first.id,
          pauseId: first.id,
          pause_id: first.id,
          pauseIds: weekRows.map((pw) => pw.id),
          startDate: rangeStart,
          start_date: rangeStart,
          endDate: rangeEnd,
          end_date: rangeEnd,
          weeks: pausedWeekCount,
          netExtendedDays: pausedWeekCount * 7,
          net_extended_days: pausedWeekCount * 7,
          sessionsPaused: true,
          sessions_paused: true,
          nutritionPaused: true,
          nutrition_paused: true,
        };
        pauseHistory = [consolidatedPause];
        activePause = {
          id: first.id,
          pauseId: first.id,
          pause_id: first.id,
          startDate: rangeStart,
          start_date: rangeStart,
          endDate: rangeEnd,
          end_date: rangeEnd,
          weeks: pausedWeekCount,
        };
      }
    }

    const now = Date.now();
    const mapBookingRow = (b: Record<string, unknown>) => {
      const session = unwrapJoinedRow(
        b.sessions as Record<string, unknown> | Record<string, unknown>[] | null | undefined,
      );
      const st = unwrapJoinedRow(
        session?.session_types as
          | { name?: string; category?: string }
          | Array<{ name?: string; category?: string }>
          | null
          | undefined,
      );
      const category = String(st?.category ?? "").trim();
      const sessionName = String(st?.name ?? "").trim();
      const allocKey = categoryToSessionAllocKey(category);
      const startAt = String(session?.start_at ?? b.booked_at ?? "").trim() || undefined;
      const date = toDateOnly(startAt);
      const coachName = coachNameFromSession(session);
      const locationName = locationNameFromSession(session);
      return {
        id: String(b.id ?? ""),
        sessionDate: date,
        session_date: date,
        date,
        sessionTime: extractTimeFromIso(startAt),
        session_time: extractTimeFromIso(startAt),
        time: extractTimeFromIso(startAt),
        sessionType: sessionName || category || allocKey || "",
        session_type: sessionName || category || allocKey || "",
        sessionTypeLabel: sessionName || category || "Session",
        session_type_label: sessionName || category || "Session",
        type: allocKey ?? "group",
        coachName,
        coach_name: coachName,
        coach: coachName,
        location: locationName,
        locationName,
        status: String(b.status ?? "booked"),
        mood: "",
        intensity: null as number | null,
        notes: "",
        sortAt: startAt ?? "",
      };
    };

    const sortBySessionStart = (
      rows: Array<ReturnType<typeof mapBookingRow>>,
      direction: "asc" | "desc",
    ) =>
      [...rows].sort((a, b) => {
        const aMs = new Date(String(a.sortAt || `${a.date}T00:00:00`)).getTime();
        const bMs = new Date(String(b.sortAt || `${b.date}T00:00:00`)).getTime();
        if (!Number.isFinite(aMs) && !Number.isFinite(bMs)) return 0;
        if (!Number.isFinite(aMs)) return 1;
        if (!Number.isFinite(bMs)) return -1;
        return direction === "asc" ? aMs - bMs : bMs - aMs;
      });

    const booked: ReturnType<typeof mapBookingRow>[] = [];
    const historySessions: ReturnType<typeof mapBookingRow>[] = [];
    for (const b of bookingRows) {
      const session = unwrapJoinedRow(
        b.sessions as Record<string, unknown> | Record<string, unknown>[] | null | undefined,
      );
      if (!session?.start_at) continue;

      const row = mapBookingRow(b);
      if (!row.date) continue;

      const status = String((b as { status?: string }).status ?? "");
      const startMs = new Date(String(session.start_at)).getTime();
      const isPast = Number.isFinite(startMs) && startMs < now;

      if (status === "booked" && !isPast) {
        booked.push(row);
        continue;
      }

      if (status === "booked" && isPast) {
        historySessions.push({ ...row, status: "completed" });
        continue;
      }

      historySessions.push(row);
    }

    const { data: locationAccessRows, error: locationAccessErr } = await supabaseAdmin
      .from("member_location_access")
      .select("location_code")
      .eq("member_id", memberId);
    if (locationAccessErr) {
      throw new HttpError(500, "Failed to load member location access", locationAccessErr);
    }
    const { data: trainingLevelRows, error: trainingLevelErr } = await supabaseAdmin
      .from("member_training_levels")
      .select("level_code")
      .eq("member_id", memberId);
    if (trainingLevelErr) {
      throw new HttpError(500, "Failed to load member training levels", trainingLevelErr);
    }
    const { data: sessionAccessRows, error: sessionAccessErr } = await supabaseAdmin
      .from("member_session_access")
      .select("session_code")
      .eq("member_id", memberId);
    if (sessionAccessErr) {
      throw new HttpError(500, "Failed to load member session access", sessionAccessErr);
    }
    const memberLocations = (locationAccessRows ?? [])
      .map((row) => String((row as { location_code?: string }).location_code ?? "").trim())
      .filter(Boolean);
    const trainingLevel = (trainingLevelRows ?? [])
      .map((row) => String((row as { level_code?: string }).level_code ?? "").trim())
      .filter(Boolean);
    const sessionAccess = (sessionAccessRows ?? [])
      .map((row) => String((row as { session_code?: string }).session_code ?? "").trim())
      .filter(Boolean);
    const syntheticHistory = this.#buildDashboardHistoryEvents(rows);

    const giftList = await new TokenService().listMemberGiftSessions(memberId);

    const membershipPackage = String(
      membership?.current_package ?? membershipPayload?.currentPackage ?? "pace",
    );
    const planQueues = membership
      ? await loadMembershipPlanQueues(String(membership.id), membershipPackage)
      : { trainingQueue: [], nutritionQueue: [] };

    const todayYmd = toDateOnly(new Date().toISOString());
    let trainingUpcoming: Record<string, unknown> | null = null;
    const nextQueuedTraining = [...planQueues.trainingQueue]
      .filter((row) => {
        const start = toDateOnly(
          String(row.startDate ?? row.start_date ?? row.start ?? ""),
        );
        return start > todayYmd;
      })
      .sort((a, b) =>
        String(a.startDate ?? a.start_date ?? a.start ?? "").localeCompare(
          String(b.startDate ?? b.start_date ?? b.start ?? ""),
        ),
      )[0];
    if (nextQueuedTraining) {
      const alloc =
        (nextQueuedTraining.alloc as Record<string, number> | undefined) ??
        (nextQueuedTraining.allocations as Record<string, number> | undefined) ??
        {};
      trainingUpcoming = {
        planType: nextQueuedTraining.planType ?? "fixed",
        plan_type: nextQueuedTraining.plan_type ?? "fixed",
        startDate: nextQueuedTraining.startDate ?? nextQueuedTraining.start,
        start_date: nextQueuedTraining.start_date ?? nextQueuedTraining.start,
        endDate: nextQueuedTraining.endDate ?? nextQueuedTraining.end,
        end_date: nextQueuedTraining.end_date ?? nextQueuedTraining.end,
        allocations: { ...alloc },
        alloc: { ...alloc },
      };
    } else if (
      membership &&
      membershipPayload &&
      !trainingCurrent &&
      String(membership.status ?? "").toLowerCase() === "active" &&
      trainingPlanShape.startDate > todayYmd
    ) {
      trainingUpcoming = trainingPlanShape;
    }

    let nutritionCurrent: Record<string, unknown> | null = null;
    if (membership && membershipHasActivePlanWindow(membership)) {
      const activeNutrition = await getActiveNutritionPlanForMembership(String(membership.id));
      if (activeNutrition) {
        nutritionCurrent = mapNutritionPlanForDashboard(activeNutrition);
      }
    }

    return {
      membership: membershipPayload,
      training: {
        current: trainingCurrent,
        coversToday: trainingCoversToday,
        covers_today: trainingCoversToday,
        upcoming: trainingUpcoming,
        queue: planQueues.trainingQueue,
      },
      nutrition: {
        current: nutritionCurrent,
        queue: planQueues.nutritionQueue,
      },
      pause: {
        history: pauseHistory,
        pauseHistory,
        planPaused: membershipIsPaused && pauseHistory.length > 0,
        is_paused: membershipIsPaused,
        current: activePause,
      },
      gifts: giftList,
      access: {
        memberLocations,
        member_locations: memberLocations,
        trainingLevel,
        training_level: trainingLevel,
        sessionAccess,
        session_access: sessionAccess,
      },
      sessions: {
        booked: sortBySessionStart(booked, "asc"),
        history: sortBySessionStart(historySessions, "desc"),
      },
      injuries: [] as unknown[],
      history: syntheticHistory,
    };
  }

  #buildDashboardHistoryEvents(membershipRows: MembershipRow[]): Array<Record<string, unknown>> {
    const events: Array<Record<string, unknown>> = [];
    for (const m of membershipRows) {
      events.push({
        id: `${m.id}-created`,
        eventDate: toDateOnly(m.created_at),
        event_type: "created",
        action: "created",
        planName: m.current_package,
        plan: m.current_package,
        duration: "—",
        details: `Membership (${m.mode}) created`,
        changedByName: "System",
        source: "system",
      });
      const createdMs = new Date(m.created_at).getTime();
      const updatedMs = new Date(m.updated_at).getTime();
      if (Number.isFinite(updatedMs) && updatedMs > createdMs + 2000) {
        events.push({
          id: `${m.id}-updated`,
          eventDate: toDateOnly(m.updated_at),
          event_type: "modified",
          action: "modified",
          planName: m.current_package,
          plan: m.current_package,
          duration: "—",
          details: `Status: ${m.status}${m.is_paused ? ", paused" : ""}`,
          changedByName: "System",
          source: "system",
        });
      }
    }
    events.sort((a, b) => String(b.eventDate).localeCompare(String(a.eventDate)));
    return events;
  }

  async getAdminMemberMembershipHistory(memberId: string) {
    const { data: membershipRows, error } = await supabaseAdmin
      .from("member_memberships")
      .select("*")
      .eq("member_id", memberId);
    if (error) throw new HttpError(500, "Failed to load memberships for history", error);
    return this.#buildDashboardHistoryEvents((membershipRows ?? []) as MembershipRow[]);
  }

  async patchAdminMemberMembership(
    memberId: string,
    body: { mode?: MembershipMode; currentPackage?: PlanTier },
  ) {
    const { data: profile, error: profileErr } = await supabaseAdmin
      .from("profiles")
      .select("id")
      .eq("id", memberId)
      .maybeSingle();
    if (profileErr) throw new HttpError(500, "Failed to verify member", profileErr);
    if (!profile) throw new HttpError(404, "Member not found");

    const mode = body.mode ?? "inperson";
    const tier = body.currentPackage ?? "pace";

    const { data: existing, error: exErr } = await supabaseAdmin
      .from("member_memberships")
      .select("id")
      .eq("member_id", memberId)
      .eq("mode", mode)
      .maybeSingle();
    if (exErr) throw new HttpError(500, "Failed to resolve membership", exErr);

    if (!existing) {
      const start = new Date();
      const end = new Date(start.getTime() + 365 * 24 * 60 * 60 * 1000);
      await this.createMembership({
        memberId,
        mode,
        currentPackage: tier,
        startDate: start.toISOString(),
        endDate: end.toISOString(),
      });
      return { ok: true as const, created: true };
    }

    await this.updateMembership(String((existing as { id: string }).id), {
      mode,
      currentPackage: tier,
    });
    return { ok: true as const, created: false };
  }

  #allocKeyToCategory(key: string): "1:1" | "Elite" | "Octave" | "Group" | null {
    switch (key) {
      case "oneToOne":
        return "1:1";
      case "elite":
        return "Elite";
      case "octave":
        return "Octave";
      case "group":
        return "Group";
      default:
        return null;
    }
  }

  #extractSessionAllocFromTrainingBody(body: Record<string, unknown>): Record<string, number> {
    const out: Record<string, number> = {
      oneToOne: 0,
      elite: 0,
      octave: 0,
      group: 0,
    };
    const alloc = body.alloc;
    if (alloc && typeof alloc === "object") {
      const o = alloc as Record<string, unknown>;
      out.oneToOne = clampAlloc(Number(o.oneToOne ?? o.one_to_one ?? o.onetoone ?? 0));
      out.elite = clampAlloc(Number(o.elite ?? 0));
      out.octave = clampAlloc(Number(o.octave ?? 0));
      out.group = clampAlloc(Number(o.group ?? 0));
      return out;
    }
    const list = body.allocations;
    if (!Array.isArray(list)) return out;
    for (const entry of list) {
      const row = entry && typeof entry === "object" ? (entry as Record<string, unknown>) : {};
      const key = String(row.allocation_key ?? row.allocationKey ?? "")
        .trim()
        .toLowerCase()
        .replace(/[\s_-]/g, "");
      const val = clampAlloc(
        Number(row.allocation_value ?? row.allocationValue ?? row.value ?? 0),
      );
      if (key === "onetoone" || key === "11" || key === "1to1" || key === "personal" || key === "private") {
        out.oneToOne = val;
      } else if (key === "elite") out.elite = val;
      else if (key === "octave") out.octave = val;
      else if (key === "group") out.group = val;
    }
    return out;
  }

  async #getFirstTokenTypeIdByCategory(): Promise<Map<string, string>> {
    const { data, error } = await supabaseAdmin
      .from("session_types")
      .select("category, token_type_id, created_at")
      .order("category", { ascending: true })
      .order("created_at", { ascending: true });
    if (error) throw new HttpError(500, "Failed to load session types for allowances", error);
    const m = new Map<string, string>();
    for (const row of data ?? []) {
      const cat = String((row as { category: string }).category || "");
      const tid = String((row as { token_type_id: string }).token_type_id || "");
      if (cat && tid && !m.has(cat)) m.set(cat, tid);
    }
    return m;
  }

  async #syncMembershipSessionAllowances(
    membershipId: string,
    alloc: Record<string, number>,
  ) {
    const tokenByCat = await this.#getFirstTokenTypeIdByCategory();
    for (const key of ["oneToOne", "elite", "octave", "group"] as const) {
      const cat = this.#allocKeyToCategory(key);
      if (!cat) continue;
      const tokenTypeId = tokenByCat.get(cat);
      const weeklyAllowance = clampAlloc(alloc[key] ?? 0);
      if (!tokenTypeId) {
        if (weeklyAllowance > 0) {
          throw new HttpError(
            500,
            `Cannot save session counts: no session_types row for category "${cat}". Seed session types (with token_type_id) in the database.`,
          );
        }
        continue;
      }
      await this.addSessionAllowance({
        membershipId,
        tokenTypeId,
        weeklyAllowance,
      });
    }
  }

  /**
   * Admin dashboard: persist current training plan window + weekly session allowances.
   * PUT/PATCH/POST `/admin/members/:memberId/membership/training/current`
   */
  async putAdminMemberTrainingCurrent(memberId: string, body: Record<string, unknown>) {
    const { data: profile, error: profileErr } = await supabaseAdmin
      .from("profiles")
      .select("id")
      .eq("id", memberId)
      .maybeSingle();
    if (profileErr) throw new HttpError(500, "Failed to verify member", profileErr);
    if (!profile) throw new HttpError(404, "Member not found");

    const mode = normalizeDashboardMode(String(body.mode ?? "inperson"));
    const tier = normalizePlanTierValue(
      body.tier ?? body.current_package ?? body.pkg ?? body.package ?? body.currentPackage,
    );
    const planTypeRaw = String(body.plan_type ?? body.planType ?? "fixed")
      .trim()
      .toLowerCase();
    const isFixed = planTypeRaw !== "rolling";

    const startStr = String(body.start_date ?? body.startDate ?? "").trim();
    if (!startStr) throw new HttpError(400, "start_date is required");
    const startIso = parseCalendarDateToStartIso(startStr);

    const allocMode = String(body.allocation_mode ?? body.allocationMode ?? "sessions")
      .trim()
      .toLowerCase();

    const { data: existing, error: exErr } = await supabaseAdmin
      .from("member_memberships")
      .select("*")
      .eq("member_id", memberId)
      .eq("mode", mode)
      .maybeSingle();
    if (exErr) throw new HttpError(500, "Failed to load membership", exErr);

    let endIso: string;
    if (isFixed) {
      let endStr = String(body.end_date ?? body.endDate ?? "").trim();
      if (!endStr && existing?.end_date) {
        endStr = toDateOnly(String(existing.end_date));
      }
      if (!endStr) throw new HttpError(400, "end_date is required for fixed training plans");
      endIso = parseCalendarDateToEndIso(endStr);
    } else {
      endIso = new Date(new Date(startIso).getTime() + 365 * 24 * 60 * 60 * 1000).toISOString();
    }

    let membershipId: string;
    if (!existing) {
      const created = await this.createMembership({
        memberId,
        mode,
        currentPackage: tier,
        startDate: startIso,
        endDate: endIso,
      });
      membershipId = String((created as { id: string }).id);
    } else {
      membershipId = String((existing as { id: string }).id);
      await this.updateMembership(membershipId, {
        currentPackage: tier,
        startDate: startIso,
        endDate: endIso,
      });
    }

    if (allocMode !== "location") {
      const alloc = this.#extractSessionAllocFromTrainingBody(body);
      await this.#syncMembershipSessionAllowances(membershipId, alloc);
    }

    const membership = await this.getMembershipById(membershipId);
    const startYmd = toDateOnly(String(membership.start_date ?? ""));
    const endYmd = membership.end_date ? toDateOnly(String(membership.end_date)) : "";
    const alloc = this.#extractSessionAllocFromTrainingBody(body);
    const trainingCurrent = {
      planType: isFixed ? "fixed" : "rolling",
      plan_type: isFixed ? "fixed" : "rolling",
      startDate: startYmd,
      start_date: startYmd,
      endDate: endYmd,
      end_date: endYmd,
      allocations: { ...alloc },
      alloc: { ...alloc },
    };

    return {
      membership: {
        id: membership.id,
        memberId: membership.member_id,
        member_id: membership.member_id,
        mode: membership.mode,
        currentPackage: membership.current_package,
        current_package: membership.current_package,
        status: membership.status,
        startDate: startYmd,
        start_date: startYmd,
        endDate: endYmd,
        end_date: endYmd,
        updatedAt: membership.updated_at,
        updated_at: membership.updated_at,
      },
      training: {
        current: trainingCurrent,
        coversToday: membershipHasActivePlanWindow(membership as MembershipRow),
        covers_today: membershipHasActivePlanWindow(membership as MembershipRow),
      },
    };
  }

  async queueAdminMemberTrainingPlan(memberId: string, body: Record<string, unknown>) {
    return queueAdminTrainingPlan(memberId, body);
  }

  async cancelAdminMemberTrainingPlan(memberId: string, body: Record<string, unknown>) {
    return cancelAdminTrainingPlan(memberId, body);
  }

  /**
   * Admin dashboard: persist current (active) nutrition plan.
   * PUT/PATCH/POST `/admin/members/:memberId/membership/nutrition/current`
   */
  async putAdminMemberNutritionCurrent(memberId: string, body: Record<string, unknown>) {
    return upsertAdminNutritionCurrent(memberId, body);
  }

  async queueAdminMemberNutritionPlan(memberId: string, body: Record<string, unknown>) {
    return queueAdminNutritionPlan(memberId, body);
  }

  async cancelAdminMemberNutritionPlan(memberId: string, body: Record<string, unknown>) {
    return cancelAdminNutritionPlan(memberId, body);
  }
}
