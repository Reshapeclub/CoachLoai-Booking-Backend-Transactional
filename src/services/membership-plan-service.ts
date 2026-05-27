import { supabaseAdmin } from "../db/supabase.js";
import { HttpError } from "../lib/http-error.js";
import {
  calendarTodayYmd,
  membershipAdminRetainsPastCurrentPlan,
  membershipCoversToday,
  shouldPromoteQueuedTrainingPlanToday,
  shouldSyncQueuedPlanToMembership,
  shouldWriteQueuedPlanOntoMembershipRow,
} from "../lib/membership-plan-sync-rules.js";

export {
  calendarDayAfter,
  membershipCoversToday,
  queuedPlanIsImmediateSuccessor,
  shouldPromoteQueuedTrainingPlanToday,
  membershipAdminRetainsPastCurrentPlan,
  shouldSyncQueuedPlanToMembership,
  shouldWriteQueuedPlanOntoMembershipRow,
} from "../lib/membership-plan-sync-rules.js";

type PlanType = "fixed" | "rolling";
type AllocationMode = "sessions" | "location";
type PlanStatus = "active" | "queued" | "completed" | "cancelled";
type PlanTier = "structure" | "pace" | "performance";

const SESSION_ALLOCATION_KEYS = new Set(["oneToOne", "elite", "octave", "group"]);
const LOCATION_ALLOCATION_KEYS = new Set(["gym", "home"]);

type AllocationRow = { allocation_key: string; allocation_value: number };

function planDateFromBody(value: unknown, field: string): string {
  const raw = String(value ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    throw new HttpError(400, `${field} must be YYYY-MM-DD`);
  }
  return raw;
}

function normalizePlanType(value: unknown): PlanType {
  const s = String(value ?? "fixed").trim().toLowerCase();
  if (s === "rolling") return "rolling";
  return "fixed";
}

function normalizeAllocationMode(value: unknown): AllocationMode {
  const s = String(value ?? "sessions").trim().toLowerCase();
  return s === "location" ? "location" : "sessions";
}

function normalizeTier(value: unknown): PlanTier {
  const s = String(value ?? "pace").trim().toLowerCase();
  if (s === "structure") return "structure";
  if (s === "performance") return "performance";
  return "pace";
}

function validatePlanDates(planType: PlanType, startDate: string, endDate?: string | null) {
  if (planType === "fixed" && !endDate) {
    throw new HttpError(400, "plan_type=fixed requires end_date");
  }
  if (endDate && endDate < startDate) {
    throw new HttpError(400, "end_date must be on or after start_date");
  }
}

function parseAllocationsFromBody(body: Record<string, unknown>): AllocationRow[] {
  const list = body.allocations;
  if (Array.isArray(list)) {
    return list.map((entry) => {
      const row = entry && typeof entry === "object" ? (entry as Record<string, unknown>) : {};
      return {
        allocation_key: String(row.allocation_key ?? row.allocationKey ?? "").trim(),
        allocation_value: Math.trunc(Number(row.allocation_value ?? row.allocationValue ?? 0)),
      };
    });
  }
  const alloc = body.alloc;
  if (alloc && typeof alloc === "object" && !Array.isArray(alloc)) {
    return Object.entries(alloc as Record<string, unknown>).map(([key, val]) => ({
      allocation_key: key,
      allocation_value: Math.trunc(Number(val ?? 0)),
    }));
  }
  return [];
}

function validateAllocationList(
  allocationMode: AllocationMode,
  allocations: AllocationRow[],
  required = false,
) {
  if (!allocations.length) {
    if (required) throw new HttpError(400, "allocations are required");
    return;
  }
  const keySet = allocationMode === "sessions" ? SESSION_ALLOCATION_KEYS : LOCATION_ALLOCATION_KEYS;
  const seen = new Set<string>();
  for (const item of allocations) {
    if (!item.allocation_key) throw new HttpError(400, "allocation_key is required");
    if (!keySet.has(item.allocation_key)) {
      throw new HttpError(400, `Invalid allocation_key ${item.allocation_key} for ${allocationMode}`);
    }
    if (seen.has(item.allocation_key)) {
      throw new HttpError(400, `Duplicate allocation_key ${item.allocation_key}`);
    }
    seen.add(item.allocation_key);
    if (!Number.isInteger(item.allocation_value) || item.allocation_value < 0 || item.allocation_value > 7) {
      throw new HttpError(400, "allocation_value must be an integer between 0 and 7");
    }
  }
}

function allocationsToRecord(allocations: AllocationRow[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const row of allocations) {
    out[row.allocation_key] = row.allocation_value;
  }
  return out;
}

async function getMembershipForMember(memberId: string, modeInput?: string) {
  const mode =
    String(modeInput ?? "inperson").trim().toLowerCase() === "remote" ? "remote" : "inperson";
  const { data, error } = await supabaseAdmin
    .from("member_memberships")
    .select("*")
    .eq("member_id", memberId)
    .eq("mode", mode)
    .maybeSingle();
  if (error) throw new HttpError(500, "Failed to load membership", error);
  if (!data) throw new HttpError(404, "Membership not found for member/mode");
  return data as Record<string, unknown>;
}

async function getTrainingPlansWithAllocations(membershipId: string) {
  const { data: plans, error } = await supabaseAdmin
    .from("membership_training_plans")
    .select("*")
    .eq("membership_id", membershipId)
    .order("created_at", { ascending: false });
  if (error) throw new HttpError(500, "Failed to fetch training plans", error);

  const planIds = (plans ?? []).map((p) => String((p as { id: string }).id));
  if (!planIds.length) return [];

  const { data: allocations, error: allocErr } = await supabaseAdmin
    .from("membership_training_plan_allocations")
    .select("training_plan_id, allocation_key, allocation_value")
    .in("training_plan_id", planIds);
  if (allocErr) throw new HttpError(500, "Failed to fetch training plan allocations", allocErr);

  const byPlan = new Map<string, AllocationRow[]>();
  for (const row of allocations ?? []) {
    const planId = String((row as { training_plan_id: string }).training_plan_id);
    const list = byPlan.get(planId) ?? [];
    list.push({
      allocation_key: String((row as { allocation_key: string }).allocation_key),
      allocation_value: Number((row as { allocation_value: number }).allocation_value),
    });
    byPlan.set(planId, list);
  }

  return (plans ?? []).map((plan) => {
    const row = plan as Record<string, unknown>;
    return {
      ...row,
      allocations: byPlan.get(String(row.id ?? "")) ?? [],
    };
  });
}

async function getNutritionPlans(membershipId: string) {
  const { data, error } = await supabaseAdmin
    .from("membership_nutrition_plans")
    .select("*")
    .eq("membership_id", membershipId)
    .order("created_at", { ascending: false });
  if (error) throw new HttpError(500, "Failed to fetch nutrition plans", error);
  return (data ?? []) as Array<Record<string, unknown>>;
}

function effectiveDateFromCancelBody(body: Record<string, unknown>, field: string): string {
  return planDateFromBody(
    body.effective_date ??
      body.effectiveDate ??
      body.scheduled_date ??
      body.scheduledDate,
    field,
  );
}

async function resolveTrainingPlanForCancel(
  membershipId: string,
  body: Record<string, unknown>,
  targetStatus: string,
): Promise<Record<string, unknown>> {
  const planId = String(body.id ?? body.queue_id ?? body.queueId ?? "").trim();

  if (planId) {
    const { data, error } = await supabaseAdmin
      .from("membership_training_plans")
      .select("*")
      .eq("id", planId)
      .eq("membership_id", membershipId)
      .maybeSingle();
    if (error) throw new HttpError(500, "Failed to load training plan", error);
    if (!data) throw new HttpError(404, "Training plan not found for id");
    const status = String((data as Record<string, unknown>).status);
    if (status === "cancelled" || status === "completed") {
      throw new HttpError(404, `Training plan is already ${status}`);
    }
    return data as Record<string, unknown>;
  }

  const startRaw = body.start_date ?? body.startDate;
  if (startRaw) {
    const planType = normalizePlanType(body.plan_type ?? body.planType);
    const startDate = planDateFromBody(startRaw, "start_date");
    const endDate =
      planType === "fixed" && (body.end_date ?? body.endDate)
        ? planDateFromBody(body.end_date ?? body.endDate, "end_date")
        : null;
    const matched = await findExistingQueuedTrainingPlan(
      membershipId,
      startDate,
      planType,
      endDate,
    );
    if (matched) return matched;
  }

  const { data, error } = await supabaseAdmin
    .from("membership_training_plans")
    .select("*")
    .eq("membership_id", membershipId)
    .eq("status", targetStatus)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new HttpError(500, "Failed to load training plan", error);
  if (!data) throw new HttpError(404, `No ${targetStatus} training plan found`);
  return data as Record<string, unknown>;
}

async function resolveNutritionPlanForCancel(
  membershipId: string,
  body: Record<string, unknown>,
  targetStatus: string,
): Promise<Record<string, unknown>> {
  const planId = String(body.id ?? body.queue_id ?? body.queueId ?? "").trim();

  if (planId) {
    const { data, error } = await supabaseAdmin
      .from("membership_nutrition_plans")
      .select("*")
      .eq("id", planId)
      .eq("membership_id", membershipId)
      .maybeSingle();
    if (error) throw new HttpError(500, "Failed to load nutrition plan", error);
    if (!data) throw new HttpError(404, "Nutrition plan not found for id");
    const status = String((data as Record<string, unknown>).status);
    if (status === "cancelled" || status === "completed") {
      throw new HttpError(404, `Nutrition plan is already ${status}`);
    }
    return data as Record<string, unknown>;
  }

  const startRaw = body.start_date ?? body.startDate;
  if (startRaw) {
    const planType = normalizePlanType(body.plan_type ?? body.planType);
    const tier = normalizeTier(body.tier ?? body.pkg ?? body.package);
    const startDate = planDateFromBody(startRaw, "start_date");
    const endDate =
      planType === "fixed" && (body.end_date ?? body.endDate)
        ? planDateFromBody(body.end_date ?? body.endDate, "end_date")
        : null;
    const matched = await findExistingQueuedNutritionPlan(
      membershipId,
      startDate,
      planType,
      endDate,
      tier,
    );
    if (matched) return matched;
  }

  const { data, error } = await supabaseAdmin
    .from("membership_nutrition_plans")
    .select("*")
    .eq("membership_id", membershipId)
    .eq("status", targetStatus)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new HttpError(500, "Failed to load nutrition plan", error);
  if (!data) throw new HttpError(404, `No ${targetStatus} nutrition plan found`);
  return data as Record<string, unknown>;
}

async function findQueuedTrainingPlanByStart(
  membershipId: string,
  startDate: string,
  planType: PlanType,
) {
  const { data, error } = await supabaseAdmin
    .from("membership_training_plans")
    .select("*")
    .eq("membership_id", membershipId)
    .eq("status", "queued")
    .eq("start_date", startDate)
    .eq("plan_type", planType)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new HttpError(500, "Failed to look up queued training plan by start", error);
  return data as Record<string, unknown> | null;
}

function queuedPlanDateRangesOverlap(
  startA: string,
  endA: string | null,
  startB: string,
  endB: string | null,
): boolean {
  const endAYmd = endA ?? "9999-12-31";
  const endBYmd = endB ?? "9999-12-31";
  return startA <= endBYmd && startB <= endAYmd;
}

async function assertQueuedTrainingPlanNoOverlap(
  membershipId: string,
  startDate: string,
  endDate: string | null,
  excludePlanId?: string,
) {
  const { data: rows, error } = await supabaseAdmin
    .from("membership_training_plans")
    .select("id, start_date, end_date")
    .eq("membership_id", membershipId)
    .eq("status", "queued");
  if (error) throw new HttpError(500, "Failed to validate queued training plans", error);
  for (const row of rows ?? []) {
    const plan = row as { id: string; start_date: string; end_date: string | null };
    if (excludePlanId && String(plan.id) === excludePlanId) continue;
    if (
      queuedPlanDateRangesOverlap(
        startDate,
        endDate,
        String(plan.start_date ?? ""),
        plan.end_date ? String(plan.end_date) : null,
      )
    ) {
      const existingEnd = plan.end_date ? String(plan.end_date) : "rolling";
      throw new HttpError(
        409,
        `Queued plan ${startDate}–${endDate ?? "rolling"} overlaps existing queued plan ${plan.start_date}–${existingEnd}`,
      );
    }
  }
}

async function findExistingQueuedTrainingPlan(
  membershipId: string,
  startDate: string,
  planType: PlanType,
  endDate: string | null,
) {
  let query = supabaseAdmin
    .from("membership_training_plans")
    .select("*")
    .eq("membership_id", membershipId)
    .eq("status", "queued")
    .eq("start_date", startDate)
    .eq("plan_type", planType);
  query = endDate ? query.eq("end_date", endDate) : query.is("end_date", null);
  const { data, error } = await query
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new HttpError(500, "Failed to look up queued training plan", error);
  return data as Record<string, unknown> | null;
}

async function findExistingQueuedNutritionPlan(
  membershipId: string,
  startDate: string,
  planType: PlanType,
  endDate: string | null,
  tier: PlanTier,
) {
  let query = supabaseAdmin
    .from("membership_nutrition_plans")
    .select("*")
    .eq("membership_id", membershipId)
    .eq("status", "queued")
    .eq("start_date", startDate)
    .eq("plan_type", planType)
    .eq("tier", tier);
  query = endDate ? query.eq("end_date", endDate) : query.is("end_date", null);
  const { data, error } = await query
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new HttpError(500, "Failed to look up queued nutrition plan", error);
  return data as Record<string, unknown> | null;
}

async function saveTrainingAllocations(planId: string, allocations: AllocationRow[]) {
  const { error: delErr } = await supabaseAdmin
    .from("membership_training_plan_allocations")
    .delete()
    .eq("training_plan_id", planId);
  if (delErr) throw new HttpError(500, "Failed to clear training allocations", delErr);
  if (!allocations.length) return;
  const { error: insErr } = await supabaseAdmin.from("membership_training_plan_allocations").insert(
    allocations.map((row) => ({
      training_plan_id: planId,
      allocation_key: row.allocation_key,
      allocation_value: row.allocation_value,
    })),
  );
  if (insErr) throw new HttpError(500, "Failed to save training allocations", insErr);
}

export function mapTrainingPlanForDashboard(
  plan: Record<string, unknown>,
  membershipPackage: string,
) {
  const allocations = (plan.allocations as AllocationRow[] | undefined) ?? [];
  const alloc = allocationsToRecord(allocations);
  const start = String(plan.start_date ?? "");
  const end = plan.end_date ? String(plan.end_date) : "";
  let durationWeeks: number | null = null;
  if (start && end) {
    const startMs = new Date(`${start}T12:00:00`).getTime();
    const endMs = new Date(`${end}T12:00:00`).getTime();
    if (Number.isFinite(startMs) && Number.isFinite(endMs) && endMs >= startMs) {
      durationWeeks = Math.max(1, Math.ceil((endMs - startMs + 86400000) / (7 * 86400000)));
    }
  }
  const pkg = normalizeTier(membershipPackage);
  return {
    id: String(plan.id ?? ""),
    queueId: String(plan.id ?? ""),
    queue_id: String(plan.id ?? ""),
    pkg,
    tier: pkg,
    package: pkg,
    start,
    startDate: start,
    start_date: start,
    end,
    endDate: end,
    end_date: end,
    planType: String(plan.plan_type ?? "fixed"),
    plan_type: String(plan.plan_type ?? "fixed"),
    allocationMode: String(plan.allocation_mode ?? "sessions") === "location" ? "location" : "sessions",
    allocation_mode: String(plan.allocation_mode ?? "sessions"),
    alloc,
    allocations: alloc,
    status: String(plan.status ?? "queued"),
  };
}

export function mapNutritionPlanForDashboard(plan: Record<string, unknown>) {
  const start = String(plan.start_date ?? "");
  const end = plan.end_date ? String(plan.end_date) : "";
  const tier = normalizeTier(plan.tier);
  return {
    id: String(plan.id ?? ""),
    queueId: String(plan.id ?? ""),
    queue_id: String(plan.id ?? ""),
    pkg: tier,
    tier,
    package: tier,
    start,
    startDate: start,
    start_date: start,
    end,
    endDate: end,
    end_date: end,
    planType: String(plan.plan_type ?? "fixed"),
    plan_type: String(plan.plan_type ?? "fixed"),
    status: String(plan.status ?? "queued"),
  };
}

export async function getActiveNutritionPlanForMembership(membershipId: string) {
  const { data, error } = await supabaseAdmin
    .from("membership_nutrition_plans")
    .select("*")
    .eq("membership_id", membershipId)
    .eq("status", "active")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new HttpError(500, "Failed to fetch active nutrition plan", error);
  return data as Record<string, unknown> | null;
}

function clampAllocValue(n: number): number {
  return Math.max(0, Math.min(7, Math.trunc(n)));
}

function allocRowsToSessionCounts(allocations: AllocationRow[]): Record<string, number> {
  const out: Record<string, number> = { oneToOne: 0, elite: 0, octave: 0, group: 0 };
  for (const row of allocations) {
    const key = String(row.allocation_key ?? "").trim();
    if (SESSION_ALLOCATION_KEYS.has(key)) {
      out[key] = clampAllocValue(row.allocation_value);
    }
  }
  return out;
}

function membershipDatesMatchQueuedPlan(
  membership: Record<string, unknown>,
  plan: Record<string, unknown>,
): boolean {
  const planStart = String(plan.start_date ?? "").slice(0, 10);
  const planEnd = plan.end_date ? String(plan.end_date).slice(0, 10) : "";
  const mmStart = membership.start_date ? String(membership.start_date).slice(0, 10) : "";
  const mmEnd = membership.end_date ? String(membership.end_date).slice(0, 10) : "";
  return planStart === mmStart && planEnd === mmEnd && String(membership.status ?? "") === "active";
}

async function getTokenTypeIdByCategory(): Promise<Map<string, string>> {
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

const ALLOC_KEY_TO_CATEGORY: Record<string, string> = {
  oneToOne: "1:1",
  elite: "Elite",
  octave: "Octave",
  group: "Group",
};

async function syncMembershipSessionAllowancesFromPlan(
  membershipId: string,
  allocations: AllocationRow[],
) {
  const alloc = allocRowsToSessionCounts(allocations);
  const tokenByCat = await getTokenTypeIdByCategory();
  for (const key of ["oneToOne", "elite", "octave", "group"] as const) {
    const cat = ALLOC_KEY_TO_CATEGORY[key];
    const tokenTypeId = tokenByCat.get(cat);
    const weeklyAllowance = clampAllocValue(alloc[key] ?? 0);
    if (!tokenTypeId) {
      if (weeklyAllowance > 0) {
        throw new HttpError(
          500,
          `Cannot save session counts: no session_types row for category "${cat}".`,
        );
      }
      continue;
    }
    const { error } = await supabaseAdmin.from("membership_session_allowances").upsert(
      {
        membership_id: membershipId,
        token_type_id: tokenTypeId,
        weekly_allowance: weeklyAllowance,
      },
      { onConflict: "membership_id,token_type_id" },
    );
    if (error) throw new HttpError(500, "Failed to sync session allowances", error);
  }
}

async function markQueuedTrainingPlanActive(membershipId: string, planId: string): Promise<void> {
  const now = new Date().toISOString();
  // Complete other active rows first — unique index allows only one active per membership.
  const { error: completeErr } = await supabaseAdmin
    .from("membership_training_plans")
    .update({ status: "completed", updated_at: now })
    .eq("membership_id", membershipId)
    .eq("status", "active")
    .neq("id", planId);
  if (completeErr) {
    throw new HttpError(500, "Failed to complete prior active training plan", completeErr);
  }

  const { error: planErr } = await supabaseAdmin
    .from("membership_training_plans")
    .update({ status: "active", updated_at: now })
    .eq("id", planId);
  if (planErr) throw new HttpError(500, "Failed to mark training plan active", planErr);
}

async function markQueuedNutritionPlanActive(membershipId: string, planId: string): Promise<void> {
  const now = new Date().toISOString();
  const { error: completeErr } = await supabaseAdmin
    .from("membership_nutrition_plans")
    .update({ status: "completed", updated_at: now })
    .eq("membership_id", membershipId)
    .eq("status", "active")
    .neq("id", planId);
  if (completeErr) {
    throw new HttpError(500, "Failed to complete prior active nutrition plan", completeErr);
  }

  const { error: planErr } = await supabaseAdmin
    .from("membership_nutrition_plans")
    .update({ status: "active", updated_at: now })
    .eq("id", planId);
  if (planErr) throw new HttpError(500, "Failed to mark nutrition plan active", planErr);
}

/** Mirrors `clm_find_membership_overlapping_window` for a membership row. */
function membershipOverlapsBookingWindow(
  membership: Record<string, unknown>,
  windowStartIso: string,
  windowEndIso: string,
): boolean {
  const status = String(membership.status ?? "active").trim().toLowerCase();
  if (status !== "active") return false;

  const windowStartMs = new Date(windowStartIso).getTime();
  const windowEndMs = new Date(windowEndIso).getTime();
  const mmStartMs = new Date(String(membership.start_date ?? "")).getTime();
  const mmEndMs = new Date(String(membership.end_date ?? "")).getTime();
  if (
    !Number.isFinite(windowStartMs) ||
    !Number.isFinite(windowEndMs) ||
    !Number.isFinite(mmStartMs) ||
    !Number.isFinite(mmEndMs)
  ) {
    return false;
  }
  if (mmStartMs >= windowEndMs) return false;
  if (mmEndMs <= windowStartMs) return false;

  const termMs = membership.termination_date
    ? new Date(String(membership.termination_date)).getTime()
    : NaN;
  if (Number.isFinite(termMs) && termMs <= windowStartMs) return false;
  return true;
}

function queuedPlanOverlapsBookingWindow(
  plan: Record<string, unknown>,
  windowStartYmd: string,
  windowEndYmd: string,
): boolean {
  if (String(plan.status ?? "") !== "queued") return false;
  const planStart = String(plan.start_date ?? "").slice(0, 10);
  const planEnd = plan.end_date ? String(plan.end_date).slice(0, 10) : null;
  if (!planStart || planStart >= windowEndYmd) return false;
  if (planEnd && planEnd <= windowStartYmd) return false;
  return true;
}

/** True when `member_memberships` spans the entire browse/booking window (not just intersects it). */
function membershipFullyCoversBookingWindow(
  membership: Record<string, unknown>,
  windowStartIso: string,
  windowEndIso: string,
): boolean {
  if (!membershipOverlapsBookingWindow(membership, windowStartIso, windowEndIso)) {
    return false;
  }
  const windowStartMs = new Date(windowStartIso).getTime();
  const windowEndMs = new Date(windowEndIso).getTime();
  const mmStartMs = new Date(String(membership.start_date ?? "")).getTime();
  const mmEndMs = new Date(String(membership.end_date ?? "")).getTime();
  if (
    !Number.isFinite(windowStartMs) ||
    !Number.isFinite(windowEndMs) ||
    !Number.isFinite(mmStartMs) ||
    !Number.isFinite(mmEndMs)
  ) {
    return false;
  }
  if (mmStartMs > windowStartMs) return false;
  if (mmEndMs < windowEndMs) return false;
  return true;
}

function trainingPlanStartMs(plan: Record<string, unknown>): number {
  return new Date(`${String(plan.start_date ?? "").slice(0, 10)}T00:00:00.000Z`).getTime();
}

function trainingPlanEndMs(plan: Record<string, unknown>): number {
  const planType = normalizePlanType(plan.plan_type);
  if (planType === "fixed" && plan.end_date) {
    return new Date(`${String(plan.end_date).slice(0, 10)}T23:59:59.999Z`).getTime();
  }
  const startMs = trainingPlanStartMs(plan);
  return startMs + 365 * 24 * 60 * 60 * 1000;
}

export type MembershipBrowseContext = {
  membershipId: string;
  filterStartMs: number;
  filterEndMs: number;
  allowedTokenTypeIds: Set<string>;
};

/**
 * Browse/schedule context without mutating `member_memberships`.
 * Unions the live membership window with overlapping queued training plans.
 */
export async function resolveMembershipBrowseContext(
  memberId: string,
  windowStartIso: string,
  windowEndIso: string,
): Promise<MembershipBrowseContext | null> {
  const windowStartMs = new Date(windowStartIso).getTime();
  const windowEndMs = new Date(windowEndIso).getTime();
  if (!Number.isFinite(windowStartMs) || !Number.isFinite(windowEndMs)) return null;

  const { data: mm, error: mmErr } = await supabaseAdmin
    .from("member_memberships")
    .select("*")
    .eq("member_id", memberId)
    .eq("mode", "inperson")
    .maybeSingle();
  if (mmErr) throw new HttpError(500, "Failed to load membership for browse", mmErr);
  if (!mm) return null;

  const membership = mm as Record<string, unknown>;
  const membershipId = String(membership.id ?? "");
  if (!membershipId) return null;

  let filterStartMs: number | null = null;
  let filterEndMs: number | null = null;

  const includeInterval = (startMs: number, endMs: number) => {
    const segStart = Math.max(startMs, windowStartMs);
    const segEnd = Math.min(endMs, windowEndMs);
    if (!Number.isFinite(segStart) || !Number.isFinite(segEnd) || segEnd <= segStart) return;
    filterStartMs = filterStartMs == null ? segStart : Math.min(filterStartMs, segStart);
    filterEndMs = filterEndMs == null ? segEnd : Math.max(filterEndMs, segEnd);
  };

  if (membershipOverlapsBookingWindow(membership, windowStartIso, windowEndIso)) {
    const mmStartMs = new Date(String(membership.start_date ?? "")).getTime();
    const mmEndMs = new Date(String(membership.end_date ?? "")).getTime();
    if (Number.isFinite(mmStartMs) && Number.isFinite(mmEndMs)) {
      includeInterval(mmStartMs, mmEndMs);
    }
  }

  const windowStartYmd = windowStartIso.slice(0, 10);
  const windowEndYmd = windowEndIso.slice(0, 10);
  const plans = await getTrainingPlansWithAllocations(membershipId);
  const overlappingQueued = plans
    .filter((p) =>
      queuedPlanOverlapsBookingWindow(p as Record<string, unknown>, windowStartYmd, windowEndYmd),
    )
    .sort((a, b) =>
      String((a as Record<string, unknown>).start_date ?? "").localeCompare(
        String((b as Record<string, unknown>).start_date ?? ""),
      ),
    );

  const allowedTokenTypeIds = new Set<string>();
  const { data: allowanceRows, error: allowanceErr } = await supabaseAdmin
    .from("membership_session_allowances")
    .select("token_type_id, weekly_allowance")
    .eq("membership_id", membershipId)
    .gt("weekly_allowance", 0);
  if (allowanceErr) {
    throw new HttpError(500, "Failed to fetch membership allowances for browse", allowanceErr);
  }
  for (const row of allowanceRows ?? []) {
    const tokenTypeId = String((row as { token_type_id?: string }).token_type_id ?? "");
    if (tokenTypeId) allowedTokenTypeIds.add(tokenTypeId);
  }

  const tokenByCat = await getTokenTypeIdByCategory();
  for (const plan of overlappingQueued) {
    const row = plan as Record<string, unknown>;
    includeInterval(trainingPlanStartMs(row), trainingPlanEndMs(row));
    const alloc = allocRowsToSessionCounts((row.allocations as AllocationRow[] | undefined) ?? []);
    for (const key of ["oneToOne", "elite", "octave", "group"] as const) {
      if ((alloc[key] ?? 0) <= 0) continue;
      const tokenTypeId = tokenByCat.get(ALLOC_KEY_TO_CATEGORY[key]);
      if (tokenTypeId) allowedTokenTypeIds.add(tokenTypeId);
    }
  }

  if (filterStartMs == null || filterEndMs == null) return null;

  return {
    membershipId,
    filterStartMs,
    filterEndMs,
    allowedTokenTypeIds,
  };
}

async function writeQueuedTrainingPlanToMembership(
  membershipId: string,
  plan: Record<string, unknown>,
  allocations: AllocationRow[],
): Promise<void> {
  const { startIso, endIso } = planWindowToIso(plan);
  const now = new Date().toISOString();
  const allocationMode = String(plan.allocation_mode ?? "sessions");
  const planId = String(plan.id ?? "");
  const queuedStart = String(plan.start_date ?? "").slice(0, 10);

  const { error: mmErr } = await supabaseAdmin
    .from("member_memberships")
    .update({
      status: "active",
      termination_date: null,
      start_date: startIso,
      end_date: endIso,
      updated_at: now,
    })
    .eq("id", membershipId);
  if (mmErr) {
    throw new HttpError(500, "Failed to apply queued plan dates for booking", mmErr);
  }

  if (allocationMode !== "location" && allocations.length > 0) {
    await syncMembershipSessionAllowancesFromPlan(membershipId, allocations);
  }

  if (planId && shouldPromoteQueuedTrainingPlanToday(queuedStart)) {
    await markQueuedTrainingPlanActive(membershipId, planId);
  }
}

/** Apply queued plan onto member_memberships even when admin sync rules would skip (browse window only). */
async function forceApplyQueuedTrainingPlanToMembershipForBooking(
  membership: Record<string, unknown>,
  plan: Record<string, unknown>,
  allocations: AllocationRow[],
): Promise<void> {
  const membershipId = String(membership.id ?? "");
  if (!membershipId) return;
  await writeQueuedTrainingPlanToMembership(membershipId, plan, allocations);
}

/** Copy queued plan dates onto member_memberships so booking can use future start dates. */
export async function applyQueuedTrainingPlanToMembershipForBooking(
  membership: Record<string, unknown>,
  plan: Record<string, unknown>,
  allocations: AllocationRow[],
): Promise<boolean> {
  const membershipId = String(membership.id ?? "");
  const queuedStart = String(plan.start_date ?? "").slice(0, 10);
  if (!membershipId || !queuedStart) return false;
  if (!shouldSyncQueuedPlanToMembership(membership, queuedStart)) return false;

  await writeQueuedTrainingPlanToMembership(membershipId, plan, allocations);
  return true;
}

/**
 * Resolve membership for session browse/booking window.
 * Falls back to queued `membership_training_plans` when `member_memberships` does not overlap.
 */
export async function resolveMembershipIdForBookingWindow(
  memberId: string,
  windowStartIso: string,
  windowEndIso: string,
): Promise<string | null> {
  const { data, error } = await supabaseAdmin.rpc("clm_find_membership_overlapping_window", {
    p_member_id: memberId,
    p_window_start: windowStartIso,
    p_window_end: windowEndIso,
  });
  if (error) throw new HttpError(500, "Failed to resolve membership for window", error);

  const { data: mm, error: mmErr } = await supabaseAdmin
    .from("member_memberships")
    .select("*")
    .eq("member_id", memberId)
    .eq("mode", "inperson")
    .maybeSingle();
  if (mmErr) throw new HttpError(500, "Failed to load membership for booking window", mmErr);
  if (!mm) return null;

  const membership = mm as Record<string, unknown>;
  const membershipId = String(membership.id ?? "");
  if (!membershipId) return null;

  // RPC overlap is enough for booking (do not require MM to span the full 28-day window).
  if (data) return String(data);

  if (membershipOverlapsBookingWindow(membership, windowStartIso, windowEndIso)) {
    return membershipId;
  }

  const windowStartYmd = windowStartIso.slice(0, 10);
  const windowEndYmd = windowEndIso.slice(0, 10);
  const plans = await getTrainingPlansWithAllocations(membershipId);
  const overlappingQueued = plans
    .filter((p) =>
      queuedPlanOverlapsBookingWindow(
        p as Record<string, unknown>,
        windowStartYmd,
        windowEndYmd,
      ),
    )
    .sort((a, b) =>
      String((a as Record<string, unknown>).start_date ?? "").localeCompare(
        String((b as Record<string, unknown>).start_date ?? ""),
      ),
    );

  if (!overlappingQueued.length) return null;

  const plan = overlappingQueued[0] as Record<string, unknown>;
  const planAllocations = (plan.allocations as AllocationRow[] | undefined) ?? [];
  const queuedStartForRetain = String(plan.start_date ?? "").slice(0, 10);

  if (shouldWriteQueuedPlanOntoMembershipRow(membership, queuedStartForRetain)) {
    const applied = await applyQueuedTrainingPlanToMembershipForBooking(
      membership,
      plan,
      planAllocations,
    );
    if (
      !applied &&
      !membershipAdminRetainsPastCurrentPlan(membership, {
        queuedStartYmd: queuedStartForRetain,
      })
    ) {
      await forceApplyQueuedTrainingPlanToMembershipForBooking(
        membership,
        plan,
        planAllocations,
      );
    }
  }

  const { data: retry, error: retryErr } = await supabaseAdmin.rpc(
    "clm_find_membership_overlapping_window",
    {
      p_member_id: memberId,
      p_window_start: windowStartIso,
      p_window_end: windowEndIso,
    },
  );
  if (retryErr) {
    throw new HttpError(500, "Failed to resolve membership after queued plan apply", retryErr);
  }
  return retry ? String(retry) : membershipId;
}

/**
 * Membership id for GET /member/booking-context (current member, not a specific session).
 * Tries overlap window, then active-membership RPC, then a direct row lookup (includes paused weeks).
 */
export async function resolveMembershipIdForBookingContext(
  memberId: string,
  nowIso: string,
): Promise<string | null> {
  const horizonEnd = new Date(new Date(nowIso).getTime() + 28 * 86400000).toISOString();
  const fromWindow = await resolveMembershipIdForBookingWindow(memberId, nowIso, horizonEnd);
  if (fromWindow) return fromWindow;

  const { data: activeId, error: activeErr } = await supabaseAdmin.rpc(
    "clm_find_active_membership",
    { p_member_id: memberId, p_now: nowIso },
  );
  if (activeErr) {
    throw new HttpError(500, "Failed to find active membership for booking context", activeErr);
  }
  if (activeId) return String(activeId);

  const { data: row, error: rowErr } = await supabaseAdmin
    .from("member_memberships")
    .select("id")
    .eq("member_id", memberId)
    .eq("mode", "inperson")
    .eq("status", "active")
    .lte("start_date", nowIso)
    .gt("end_date", nowIso)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (rowErr) {
    throw new HttpError(500, "Failed to load member membership for booking context", rowErr);
  }
  return row?.id ? String(row.id) : null;
}

function membershipRowHasActivePlanWindow(membership: Record<string, unknown>): boolean {
  const status = String(membership.status ?? "active").trim().toLowerCase();
  if (status === "terminated" || status === "ended") return false;
  const termMs = membership.termination_date
    ? new Date(String(membership.termination_date)).getTime()
    : NaN;
  if (Number.isFinite(termMs) && termMs <= Date.now()) return false;
  const today = calendarTodayYmd();
  const endYmd = membership.end_date ? String(membership.end_date).slice(0, 10) : "";
  if (endYmd && endYmd < today) return false;
  const startYmd = membership.start_date ? String(membership.start_date).slice(0, 10) : "";
  if (startYmd && startYmd > today) return false;
  return true;
}

function planWindowToIso(plan: Record<string, unknown>): { startIso: string; endIso: string } {
  const planType = normalizePlanType(plan.plan_type);
  const startDate = String(plan.start_date ?? "").slice(0, 10);
  const startIso = `${startDate}T00:00:00.000Z`;
  let endIso: string;
  if (planType === "fixed" && plan.end_date) {
    endIso = `${String(plan.end_date).slice(0, 10)}T23:59:59.999Z`;
  } else {
    endIso = new Date(new Date(startIso).getTime() + 365 * 24 * 60 * 60 * 1000).toISOString();
  }
  return { startIso, endIso };
}

/**
 * Promote a due queued plan onto `member_memberships` when the current window has ended.
 */
export async function promoteQueuedTrainingPlanToMembershipIfDue(
  membership: Record<string, unknown>,
  plan: Record<string, unknown>,
  allocations: AllocationRow[],
): Promise<boolean> {
  const membershipId = String(membership.id ?? "");
  if (!membershipId) return false;

  const queuedStart = String(plan.start_date ?? "").slice(0, 10);
  if (!shouldPromoteQueuedTrainingPlanToday(queuedStart)) return false;
  if (membershipCoversToday(membership)) return false;
  if (
    membershipAdminRetainsPastCurrentPlan(membership, { queuedStartYmd: queuedStart })
  ) {
    return false;
  }
  if (membershipRowHasActivePlanWindow(membership)) return false;

  const planId = String(plan.id ?? "");
  const alreadyOnMembership = membershipDatesMatchQueuedPlan(membership, plan);

  if (!alreadyOnMembership) {
    await writeQueuedTrainingPlanToMembership(membershipId, plan, allocations);
  } else if (allocations.length > 0) {
    const allocationMode = String(plan.allocation_mode ?? "sessions");
    if (allocationMode !== "location") {
      await syncMembershipSessionAllowancesFromPlan(membershipId, allocations);
    }
  }

  if (planId) {
    await markQueuedTrainingPlanActive(membershipId, planId);
  }

  return true;
}

/**
 * When the membership window has ended (cancelled, terminated, or past end_date) and a
 * queued training plan's start_date is today or earlier, copy it onto `member_memberships`.
 */
export async function activateDueQueuedTrainingPlansIfNeeded(
  membership: Record<string, unknown>,
): Promise<{
  allocationMode: string;
  allocations: AllocationRow[];
} | null> {
  const membershipId = String(membership.id ?? "");
  if (!membershipId) return null;

  const today = calendarTodayYmd();
  const plans = await getTrainingPlansWithAllocations(membershipId);
  const dueQueued = plans
    .filter((p) => {
      const row = p as Record<string, unknown>;
      if (String(row.status) !== "queued") return false;
      const start = String(row.start_date ?? "").slice(0, 10);
      return start && start <= today;
    })
    .sort((a, b) =>
      String((a as Record<string, unknown>).start_date ?? "").localeCompare(
        String((b as Record<string, unknown>).start_date ?? ""),
      ),
    );
  if (!dueQueued.length) return null;

  const plan = dueQueued[0] as Record<string, unknown>;
  const planAllocations = (plan.allocations as AllocationRow[] | undefined) ?? [];
  const promoted = await promoteQueuedTrainingPlanToMembershipIfDue(
    membership,
    plan,
    planAllocations,
  );
  if (!promoted) return null;

  return {
    allocationMode: String(plan.allocation_mode ?? "sessions"),
    allocations: planAllocations,
  };
}

/** Promote the earliest due queued nutrition plan when none is active. */
export async function activateDueQueuedNutritionPlansIfNeeded(membershipId: string): Promise<boolean> {
  const active = await getActiveNutritionPlanForMembership(membershipId);
  if (active) return false;

  const today = calendarTodayYmd();
  const plans = await getNutritionPlans(membershipId);
  const dueQueued = plans
    .filter((p) => {
      if (String(p.status) !== "queued") return false;
      const start = String(p.start_date ?? "").slice(0, 10);
      return start && start <= today;
    })
    .sort((a, b) => String(a.start_date ?? "").localeCompare(String(b.start_date ?? "")));
  if (!dueQueued.length) return false;

  const plan = dueQueued[0];
  const planId = String(plan.id ?? "");
  const now = new Date().toISOString();
  const tier = normalizeTier(plan.tier);

  await markQueuedNutritionPlanActive(membershipId, planId);

  const { error: pkgErr } = await supabaseAdmin
    .from("member_memberships")
    .update({ current_package: tier, updated_at: now })
    .eq("id", membershipId);
  if (pkgErr) throw new HttpError(500, "Failed to sync nutrition tier on membership", pkgErr);

  return true;
}

/** PUT/PATCH/POST `/admin/members/:memberId/membership/nutrition/current` */
export async function upsertAdminNutritionCurrent(
  memberId: string,
  body: Record<string, unknown>,
) {
  const membership = await getMembershipForMember(memberId, body.mode as string | undefined);
  const membershipId = String(membership.id);
  const planType = normalizePlanType(body.plan_type ?? body.planType);
  const tier = normalizeTier(
    body.tier ?? body.current_package ?? body.package ?? body.pkg ?? membership.current_package,
  );
  const startDate = planDateFromBody(body.start_date ?? body.startDate, "start_date");
  const endDate =
    planType === "fixed"
      ? planDateFromBody(body.end_date ?? body.endDate, "end_date")
      : null;
  validatePlanDates(planType, startDate, endDate);
  const now = new Date().toISOString();

  const { data: existingActive, error: exErr } = await supabaseAdmin
    .from("membership_nutrition_plans")
    .select("*")
    .eq("membership_id", membershipId)
    .eq("status", "active")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (exErr) throw new HttpError(500, "Failed to load active nutrition plan", exErr);

  let plan: Record<string, unknown>;
  if (existingActive) {
    const { data: updated, error: updErr } = await supabaseAdmin
      .from("membership_nutrition_plans")
      .update({
        tier,
        plan_type: planType,
        start_date: startDate,
        end_date: endDate,
        note: body.note != null ? String(body.note) : null,
        updated_at: now,
      })
      .eq("id", String((existingActive as { id: string }).id))
      .select("*")
      .single();
    if (updErr) throw new HttpError(500, "Failed to update nutrition plan", updErr);
    plan = updated as Record<string, unknown>;
  } else {
    const { data: inserted, error: insErr } = await supabaseAdmin
      .from("membership_nutrition_plans")
      .insert({
        membership_id: membershipId,
        tier,
        plan_type: planType,
        status: "active",
        start_date: startDate,
        end_date: endDate,
        note: body.note != null ? String(body.note) : null,
      })
      .select("*")
      .single();
    if (insErr) throw new HttpError(500, "Failed to create nutrition plan", insErr);
    plan = inserted as Record<string, unknown>;
  }

  return mapNutritionPlanForDashboard(plan);
}

export async function loadMembershipPlanQueues(
  membershipId: string,
  membershipPackage: string,
): Promise<{ trainingQueue: Record<string, unknown>[]; nutritionQueue: Record<string, unknown>[] }> {
  try {
    const trainingPlans = await getTrainingPlansWithAllocations(membershipId);
    const nutritionPlans = await getNutritionPlans(membershipId);
    return {
      trainingQueue: trainingPlans
        .filter((p) => String((p as Record<string, unknown>).status) === "queued")
        .map((p) =>
          mapTrainingPlanForDashboard(p as Record<string, unknown>, membershipPackage),
        ),
      nutritionQueue: nutritionPlans
        .filter((p) => String(p.status) === "queued")
        .map((p) => mapNutritionPlanForDashboard(p)),
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("does not exist") || msg.includes("relation")) {
      return { trainingQueue: [], nutritionQueue: [] };
    }
    throw e;
  }
}

export async function queueAdminTrainingPlan(memberId: string, body: Record<string, unknown>) {
  const membership = await getMembershipForMember(memberId, body.mode as string | undefined);
  const membershipId = String(membership.id);
  const planType = normalizePlanType(body.plan_type ?? body.planType);
  const allocationMode = normalizeAllocationMode(body.allocation_mode ?? body.allocationMode);
  const startDate = planDateFromBody(body.start_date ?? body.startDate, "start_date");
  const endDate =
    planType === "fixed"
      ? planDateFromBody(body.end_date ?? body.endDate, "end_date")
      : null;
  validatePlanDates(planType, startDate, endDate);
  const allocations = parseAllocationsFromBody(body);
  validateAllocationList(allocationMode, allocations, false);

  let planId = String(body.id ?? body.queue_id ?? body.queueId ?? "").trim();
  if (!planId) {
    const byStart = await findQueuedTrainingPlanByStart(membershipId, startDate, planType);
    if (byStart?.id) planId = String(byStart.id);
    else {
      const duplicate = await findExistingQueuedTrainingPlan(
        membershipId,
        startDate,
        planType,
        endDate,
      );
      if (duplicate?.id) planId = String(duplicate.id);
    }
  }
  await assertQueuedTrainingPlanNoOverlap(
    membershipId,
    startDate,
    endDate,
    planId || undefined,
  );
  const now = new Date().toISOString();
  let plan: Record<string, unknown>;

  if (planId) {
    const { data: existing, error: exErr } = await supabaseAdmin
      .from("membership_training_plans")
      .select("*")
      .eq("id", planId)
      .eq("membership_id", membershipId)
      .eq("status", "queued")
      .maybeSingle();
    if (exErr) throw new HttpError(500, "Failed to load queued training plan", exErr);
    if (!existing) throw new HttpError(404, "Queued training plan not found");

    const { data: updated, error: updErr } = await supabaseAdmin
      .from("membership_training_plans")
      .update({
        plan_type: planType,
        start_date: startDate,
        end_date: endDate,
        allocation_mode: allocationMode,
        note: body.note != null ? String(body.note) : null,
        updated_at: now,
      })
      .eq("id", planId)
      .select("*")
      .single();
    if (updErr) throw new HttpError(500, "Failed to update queued training plan", updErr);
    plan = updated as Record<string, unknown>;
    await saveTrainingAllocations(planId, allocations);
  } else {
    const { data: inserted, error: insErr } = await supabaseAdmin
      .from("membership_training_plans")
      .insert({
        membership_id: membershipId,
        plan_type: planType,
        status: "queued",
        start_date: startDate,
        end_date: endDate,
        allocation_mode: allocationMode,
        note: body.note != null ? String(body.note) : null,
      })
      .select("*")
      .single();
    if (insErr) throw new HttpError(500, "Failed to queue training plan", insErr);
    plan = inserted as Record<string, unknown>;
    await saveTrainingAllocations(String(plan.id), allocations);
  }

  const allocationsSaved = allocations.length
    ? allocations
    : (
        await supabaseAdmin
          .from("membership_training_plan_allocations")
          .select("allocation_key, allocation_value")
          .eq("training_plan_id", String(plan.id))
      ).data?.map((row) => ({
        allocation_key: String((row as { allocation_key: string }).allocation_key),
        allocation_value: Number((row as { allocation_value: number }).allocation_value),
      })) ?? [];

  const planWithAlloc = { ...plan, allocations: allocationsSaved };

  const { data: refreshedPlan } = await supabaseAdmin
    .from("membership_training_plans")
    .select("*")
    .eq("id", String(plan.id))
    .maybeSingle();
  const planForResponse = refreshedPlan
    ? { ...(refreshedPlan as Record<string, unknown>), allocations: allocationsSaved }
    : planWithAlloc;

  await promoteQueuedTrainingPlanToMembershipIfDue(
    membership as Record<string, unknown>,
    planForResponse,
    allocationsSaved,
  );

  const queued = (await getTrainingPlansWithAllocations(membershipId))
    .filter((p) => String((p as Record<string, unknown>).status) === "queued")
    .map((p) =>
      mapTrainingPlanForDashboard(
        p as Record<string, unknown>,
        String(membership.current_package ?? "pace"),
      ),
    );

  const mapped = mapTrainingPlanForDashboard(
    planForResponse,
    String(membership.current_package ?? "pace"),
  );

  return { ...mapped, created: mapped, queued };
}

/** Admin dashboard: cancel current plan stored on `member_memberships` (via training/current). */
export async function cancelAdminActiveTrainingMembership(
  memberId: string,
  body: Record<string, unknown>,
) {
  const membership = await getMembershipForMember(memberId, body.mode as string | undefined);
  const membershipId = String(membership.id);
  const status = String(membership.status ?? "active").toLowerCase();
  if (status === "terminated" || status === "ended") {
    throw new HttpError(404, "No active membership plan found");
  }
  const existingTermMs = membership.termination_date
    ? new Date(String(membership.termination_date)).getTime()
    : NaN;
  if (Number.isFinite(existingTermMs) && existingTermMs <= Date.now()) {
    throw new HttpError(404, "Membership is already terminated");
  }

  const cancelMode = String(body.cancel_mode ?? body.cancelMode ?? "immediate").toLowerCase();
  if (!["immediate", "end", "scheduled"].includes(cancelMode)) {
    throw new HttpError(400, "cancel_mode must be immediate, end, or scheduled");
  }

  const endYmd = membership.end_date
    ? String(membership.end_date).slice(0, 10)
    : "";
  let effectiveYmd: string;
  if (cancelMode === "scheduled") {
    effectiveYmd = effectiveDateFromCancelBody(body, "effective_date");
  } else if (cancelMode === "end") {
    if (!endYmd) throw new HttpError(400, "end cancellation requires membership end_date");
    effectiveYmd = endYmd;
  } else {
    effectiveYmd = new Date().toISOString().slice(0, 10);
  }

  const terminationIso =
    cancelMode === "immediate" ? new Date().toISOString() : `${effectiveYmd}T23:59:59.999Z`;

  const now = new Date().toISOString();
  const { data: updated, error: updErr } = await supabaseAdmin
    .from("member_memberships")
    .update({
      status: "terminated",
      termination_date: terminationIso,
      updated_at: now,
    })
    .eq("id", membershipId)
    .select("*")
    .single();
  if (updErr) throw new HttpError(500, "Failed to cancel membership plan", updErr);

  await supabaseAdmin
    .from("membership_training_plans")
    .update({
      status: "cancelled",
      cancel_mode: cancelMode,
      cancel_effective_date: effectiveYmd,
      cancel_reason: body.reason != null ? String(body.reason) : null,
      cancelled_at: now,
      updated_at: now,
    })
    .eq("membership_id", membershipId)
    .eq("status", "active");

  const membershipPackage = String(membership.current_package ?? "pace");
  const queued = (await getTrainingPlansWithAllocations(membershipId))
    .filter((p) => String((p as Record<string, unknown>).status) === "queued")
    .map((p) =>
      mapTrainingPlanForDashboard(p as Record<string, unknown>, membershipPackage),
    );

  const cancelled = mapTrainingPlanForDashboard(
    {
      id: membershipId,
      status: "cancelled",
      plan_type: "fixed",
      start_date: String((updated as { start_date?: string }).start_date ?? "").slice(0, 10),
      end_date: endYmd || null,
      cancel_mode: cancelMode,
      cancel_effective_date: effectiveYmd,
      allocations: [],
    },
    membershipPackage,
  );

  return {
    cancelled,
    membership: updated,
    queued,
  };
}

export async function cancelAdminTrainingPlan(memberId: string, body: Record<string, unknown>) {
  const targetStatus = String(body.target_status ?? body.targetStatus ?? "active").toLowerCase();
  if (targetStatus !== "active" && targetStatus !== "queued") {
    throw new HttpError(400, "target_status must be active or queued");
  }
  if (targetStatus === "active") {
    return cancelAdminActiveTrainingMembership(memberId, body);
  }

  const membership = await getMembershipForMember(memberId, body.mode as string | undefined);
  const membershipId = String(membership.id);
  const cancelMode = String(body.cancel_mode ?? body.cancelMode ?? "immediate").toLowerCase();
  if (!["immediate", "end", "scheduled"].includes(cancelMode)) {
    throw new HttpError(400, "cancel_mode must be immediate, end, or scheduled");
  }

  const plan = await resolveTrainingPlanForCancel(membershipId, body, targetStatus);

  const startDate = String(plan.start_date ?? "");
  const endDate = plan.end_date ? String(plan.end_date) : null;
  let effectiveDate = startDate;
  if (cancelMode === "scheduled") {
    effectiveDate = effectiveDateFromCancelBody(body, "effective_date");
  } else if (cancelMode === "end") {
    if (!endDate) throw new HttpError(400, "end cancellation requires plan end_date");
    effectiveDate = endDate;
  } else {
    effectiveDate = new Date().toISOString().slice(0, 10);
  }

  const { data: cancelled, error: cancelErr } = await supabaseAdmin
    .from("membership_training_plans")
    .update({
      status: "cancelled",
      cancel_mode: cancelMode,
      cancel_effective_date: effectiveDate,
      cancel_reason: body.reason != null ? String(body.reason) : null,
      cancelled_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", String(plan.id))
    .select("*")
    .single();
  if (cancelErr) throw new HttpError(500, "Failed to cancel training plan", cancelErr);

  const membershipPackage = String(membership.current_package ?? "pace");
  const queued = (await getTrainingPlansWithAllocations(membershipId))
    .filter((p) => String((p as Record<string, unknown>).status) === "queued")
    .map((p) =>
      mapTrainingPlanForDashboard(p as Record<string, unknown>, membershipPackage),
    );

  return {
    cancelled: mapTrainingPlanForDashboard(
      cancelled as Record<string, unknown>,
      membershipPackage,
    ),
    queued,
  };
}

export async function queueAdminNutritionPlan(memberId: string, body: Record<string, unknown>) {
  const membership = await getMembershipForMember(memberId, body.mode as string | undefined);
  const membershipId = String(membership.id);
  const planType = normalizePlanType(body.plan_type ?? body.planType);
  const tier = normalizeTier(
    body.tier ?? body.current_package ?? body.package ?? body.pkg ?? membership.current_package,
  );
  const startDate = planDateFromBody(body.start_date ?? body.startDate, "start_date");
  const endDate =
    planType === "fixed"
      ? planDateFromBody(body.end_date ?? body.endDate, "end_date")
      : null;
  validatePlanDates(planType, startDate, endDate);

  let planId = String(body.id ?? body.queue_id ?? body.queueId ?? "").trim();
  if (!planId) {
    const duplicate = await findExistingQueuedNutritionPlan(
      membershipId,
      startDate,
      planType,
      endDate,
      tier,
    );
    if (duplicate?.id) planId = String(duplicate.id);
  }
  const now = new Date().toISOString();
  let plan: Record<string, unknown>;

  if (planId) {
    const { data: existing, error: exErr } = await supabaseAdmin
      .from("membership_nutrition_plans")
      .select("*")
      .eq("id", planId)
      .eq("membership_id", membershipId)
      .eq("status", "queued")
      .maybeSingle();
    if (exErr) throw new HttpError(500, "Failed to load queued nutrition plan", exErr);
    if (!existing) throw new HttpError(404, "Queued nutrition plan not found");

    const { data: updated, error: updErr } = await supabaseAdmin
      .from("membership_nutrition_plans")
      .update({
        tier,
        plan_type: planType,
        start_date: startDate,
        end_date: endDate,
        note: body.note != null ? String(body.note) : null,
        updated_at: now,
      })
      .eq("id", planId)
      .select("*")
      .single();
    if (updErr) throw new HttpError(500, "Failed to update queued nutrition plan", updErr);
    plan = updated as Record<string, unknown>;
  } else {
    const { data: inserted, error: insErr } = await supabaseAdmin
      .from("membership_nutrition_plans")
      .insert({
        membership_id: membershipId,
        tier,
        plan_type: planType,
        status: "queued",
        start_date: startDate,
        end_date: endDate,
        note: body.note != null ? String(body.note) : null,
      })
      .select("*")
      .single();
    if (insErr) throw new HttpError(500, "Failed to queue nutrition plan", insErr);
    plan = inserted as Record<string, unknown>;
  }

  const savedNutritionPlanId = String(plan.id ?? "");
  if (savedNutritionPlanId && startDate <= calendarTodayYmd()) {
    await markQueuedNutritionPlanActive(membershipId, savedNutritionPlanId);
    await supabaseAdmin
      .from("member_memberships")
      .update({ current_package: tier, updated_at: now })
      .eq("id", membershipId);
  }

  const queued = (await getNutritionPlans(membershipId))
    .filter((p) => String(p.status) === "queued")
    .map((p) => mapNutritionPlanForDashboard(p));

  const mapped = mapNutritionPlanForDashboard(plan);
  return { ...mapped, created: mapped, queued };
}

export async function cancelAdminNutritionPlan(memberId: string, body: Record<string, unknown>) {
  const membership = await getMembershipForMember(memberId, body.mode as string | undefined);
  const membershipId = String(membership.id);
  const targetStatus = String(body.target_status ?? body.targetStatus ?? "queued").toLowerCase();
  if (targetStatus !== "active" && targetStatus !== "queued") {
    throw new HttpError(400, "target_status must be active or queued");
  }
  const cancelMode = String(body.cancel_mode ?? body.cancelMode ?? "immediate").toLowerCase();
  if (!["immediate", "end", "scheduled"].includes(cancelMode)) {
    throw new HttpError(400, "cancel_mode must be immediate, end, or scheduled");
  }

  const plan = await resolveNutritionPlanForCancel(membershipId, body, targetStatus);

  const endDate = plan.end_date ? String(plan.end_date) : null;
  let effectiveDate = String(plan.start_date ?? "");
  if (cancelMode === "scheduled") {
    effectiveDate = effectiveDateFromCancelBody(body, "effective_date");
  } else if (cancelMode === "end") {
    if (!endDate) throw new HttpError(400, "end cancellation requires plan end_date");
    effectiveDate = endDate;
  } else {
    effectiveDate = new Date().toISOString().slice(0, 10);
  }

  const { data: cancelled, error: cancelErr } = await supabaseAdmin
    .from("membership_nutrition_plans")
    .update({
      status: "cancelled",
      cancel_mode: cancelMode,
      cancel_effective_date: effectiveDate,
      cancel_reason: body.reason != null ? String(body.reason) : null,
      cancelled_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", String(plan.id))
    .select("*")
    .single();
  if (cancelErr) throw new HttpError(500, "Failed to cancel nutrition plan", cancelErr);

  const queued = (await getNutritionPlans(membershipId))
    .filter((p) => String(p.status) === "queued")
    .map((p) => mapNutritionPlanForDashboard(p));

  return {
    cancelled: mapNutritionPlanForDashboard(cancelled as Record<string, unknown>),
    queued,
  };
}
