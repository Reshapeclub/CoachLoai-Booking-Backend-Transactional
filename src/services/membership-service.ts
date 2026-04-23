import { supabaseAdmin } from "../db/supabase.js";
import { HttpError } from "../lib/http-error.js";

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
  const h = d.getHours();
  const m = d.getMinutes();
  const hour12 = h % 12 || 12;
  const ampm = h >= 12 ? "PM" : "AM";
  return `${hour12}:${String(m).padStart(2, "0")} ${ampm}`;
}

function normalizeDashboardMode(value: string | undefined): MembershipMode {
  return String(value || "")
    .trim()
    .toLowerCase() === "remote"
    ? "remote"
    : "inperson";
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
    const { data, error } = await supabaseAdmin
      .from("member_memberships")
      .update({ is_paused: false, updated_at: new Date().toISOString() })
      .eq("id", membershipId)
      .select()
      .single();
    if (error) throw new HttpError(500, "Failed to resume membership", error);
    return data;
  }

  async cancelMembershipPause(input: {
    membershipId: string;
    pauseId?: string;
    reverseExtensions?: boolean;
  }) {
    const reverseExtensions = input.reverseExtensions !== false;
    const { data: membership, error: membershipErr } = await supabaseAdmin
      .from("member_memberships")
      .select("id, end_date")
      .eq("id", input.membershipId)
      .maybeSingle();
    if (membershipErr) throw new HttpError(500, "Failed to load membership", membershipErr);
    if (!membership) throw new HttpError(404, "Membership not found");

    let pauseRowIds: string[] = [];
    if (input.pauseId) {
      const { data: pauseRow, error: pauseErr } = await supabaseAdmin
        .from("membership_pause_weeks")
        .select("id")
        .eq("membership_id", input.membershipId)
        .eq("id", input.pauseId)
        .maybeSingle();
      if (pauseErr) throw new HttpError(500, "Failed to load membership pause", pauseErr);
      if (pauseRow?.id) pauseRowIds = [String(pauseRow.id)];
    } else {
      const { data: latestPauseRows, error: latestPauseErr } = await supabaseAdmin
        .from("membership_pause_weeks")
        .select("id")
        .eq("membership_id", input.membershipId)
        .order("week_start", { ascending: false })
        .limit(1);
      if (latestPauseErr) {
        throw new HttpError(500, "Failed to resolve latest membership pause", latestPauseErr);
      }
      pauseRowIds = (latestPauseRows ?? []).map((row) => String((row as { id: string }).id));
    }

    if (!pauseRowIds.length) {
      return {
        ok: true,
        removedWeeks: 0,
        reversedDays: 0,
      };
    }

    const { error: deleteErr } = await supabaseAdmin
      .from("membership_pause_weeks")
      .delete()
      .in("id", pauseRowIds);
    if (deleteErr) throw new HttpError(500, "Failed to cancel membership pause", deleteErr);

    const removedWeeks = pauseRowIds.length;
    const reversedDays = reverseExtensions ? removedWeeks * 7 : 0;
    const currentEndDate = String((membership as { end_date?: string | null }).end_date ?? "");
    const currentEndMs = currentEndDate ? new Date(currentEndDate).getTime() : NaN;
    const nextEndDate =
      reverseExtensions && Number.isFinite(currentEndMs)
        ? new Date(currentEndMs - reversedDays * 86400000).toISOString()
        : currentEndDate || null;

    const { data: remainingPauseRows, error: remainingErr } = await supabaseAdmin
      .from("membership_pause_weeks")
      .select("id")
      .eq("membership_id", input.membershipId)
      .limit(1);
    if (remainingErr) throw new HttpError(500, "Failed to check remaining pauses", remainingErr);
    const hasRemainingPause = (remainingPauseRows ?? []).length > 0;

    const membershipPatch: {
      updated_at: string;
      is_paused: boolean;
      end_date?: string | null;
    } = {
      updated_at: new Date().toISOString(),
      is_paused: hasRemainingPause,
    };
    if (reverseExtensions && nextEndDate) {
      membershipPatch.end_date = nextEndDate;
    }

    const { error: membershipUpdateErr } = await supabaseAdmin
      .from("member_memberships")
      .update(membershipPatch)
      .eq("id", input.membershipId);
    if (membershipUpdateErr) {
      throw new HttpError(500, "Failed to update membership after pause cancel", membershipUpdateErr);
    }

    return {
      ok: true,
      removedWeeks,
      reversedDays,
      isPaused: hasRemainingPause,
      endDate: nextEndDate || currentEndDate || null,
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

    const trainingCurrent =
      membership && membershipPayload
        ? {
            planType: "fixed" as const,
            plan_type: "fixed" as const,
            startDate: membershipPayload.startDate,
            start_date: membershipPayload.start_date,
            endDate: membershipPayload.endDate,
            end_date: membershipPayload.end_date,
            allocations: { ...allocations },
            alloc: { ...allocations },
          }
        : null;

    let pauseHistory: Array<Record<string, unknown>> = [];
    if (membership) {
      const { data: pauseWeeks, error: pErr } = await supabaseAdmin
        .from("membership_pause_weeks")
        .select("id, week_start")
        .eq("membership_id", membership.id)
        .order("week_start", { ascending: true });
      if (pErr) throw new HttpError(500, "Failed to load membership pauses", pErr);
      pauseHistory = (pauseWeeks ?? []).map((pw) => {
        const p = pw as { id: string; week_start: string };
        const start = toDateOnly(p.week_start);
        const endMs = new Date(p.week_start).getTime() + 6 * 86400000;
        const endStr = toDateOnly(new Date(endMs).toISOString());
        return {
          id: p.id,
          startDate: start,
          start_date: start,
          endDate: endStr,
          end_date: endStr,
          weeks: 1,
          netExtendedDays: 0,
          net_extended_days: 0,
          sessionsPaused: true,
          sessions_paused: true,
          nutritionPaused: true,
          nutrition_paused: true,
        };
      });
    }

    const now = Date.now();
    const mapBookingRow = (b: Record<string, unknown>) => {
      const sessions = b.sessions as Record<string, unknown> | null | undefined;
      const st = sessions?.session_types as { name?: string; category?: string } | undefined;
      const startAt = sessions?.start_at as string | undefined;
      const date = toDateOnly(startAt);
      return {
        id: String(b.id ?? ""),
        sessionDate: date,
        session_date: date,
        date,
        sessionTime: extractTimeFromIso(startAt),
        session_time: extractTimeFromIso(startAt),
        time: extractTimeFromIso(startAt),
        sessionType: st?.name ?? st?.category ?? "",
        session_type: st?.name ?? st?.category ?? "",
        type: st?.name ?? st?.category ?? "",
        coachName: "",
        coach_name: "",
        coach: "",
        status: String(b.status ?? "booked"),
        mood: "",
        intensity: null as number | null,
        notes: "",
      };
    };

    const booked: ReturnType<typeof mapBookingRow>[] = [];
    const historySessions: ReturnType<typeof mapBookingRow>[] = [];
    for (const b of bookingRows) {
      const row = mapBookingRow(b);
      const status = String((b as { status?: string }).status ?? "");
      const sessions = (b as { sessions?: { start_at?: string } }).sessions;
      const startMs = sessions?.start_at ? new Date(sessions.start_at).getTime() : 0;
      const isPast = startMs > 0 && startMs < now;
      if (status === "booked" && !isPast) booked.push(row);
      else historySessions.push(row);
    }

    const syntheticHistory = this.#buildDashboardHistoryEvents(rows);

    return {
      membership: membershipPayload,
      training: {
        current: trainingCurrent,
        queue: [] as unknown[],
      },
      nutrition: {
        current: null,
        queue: [] as unknown[],
      },
      pause: {
        history: pauseHistory,
        pauseHistory,
        planPaused: Boolean(membership?.is_paused),
        is_paused: Boolean(membership?.is_paused),
        current: null,
        active: null,
      },
      gifts: [] as unknown[],
      access: {
        memberLocations: [] as string[],
        member_locations: [] as string[],
        trainingLevel: [] as string[],
        training_level: [] as string[],
        sessionAccess: [] as string[],
        session_access: [] as string[],
      },
      sessions: {
        booked,
        history: historySessions,
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

    let endIso: string;
    if (isFixed) {
      const endStr = String(body.end_date ?? body.endDate ?? "").trim();
      if (!endStr) throw new HttpError(400, "end_date is required for fixed training plans");
      endIso = parseCalendarDateToEndIso(endStr);
    } else {
      endIso = new Date(new Date(startIso).getTime() + 365 * 24 * 60 * 60 * 1000).toISOString();
    }

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

    return this.getMembershipById(membershipId);
  }
}
