import { supabaseAdmin } from "../db/supabase.js";
import { HttpError } from "../lib/http-error.js";

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
    const duplicate = await findExistingQueuedTrainingPlan(
      membershipId,
      startDate,
      planType,
      endDate,
    );
    if (duplicate?.id) planId = String(duplicate.id);
  }
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

  const queued = (await getTrainingPlansWithAllocations(membershipId))
    .filter((p) => String((p as Record<string, unknown>).status) === "queued")
    .map((p) =>
      mapTrainingPlanForDashboard(
        p as Record<string, unknown>,
        String(membership.current_package ?? "pace"),
      ),
    );

  const mapped = mapTrainingPlanForDashboard(
    { ...plan, allocations: allocationsSaved },
    String(membership.current_package ?? "pace"),
  );

  return { ...mapped, created: mapped, queued };
}

export async function cancelAdminTrainingPlan(memberId: string, body: Record<string, unknown>) {
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

  const planId = String(body.id ?? body.queue_id ?? body.queueId ?? "").trim();
  let plan: Record<string, unknown> | null = null;

  if (planId) {
    const { data, error } = await supabaseAdmin
      .from("membership_training_plans")
      .select("*")
      .eq("id", planId)
      .eq("membership_id", membershipId)
      .maybeSingle();
    if (error) throw new HttpError(500, "Failed to load training plan", error);
    plan = data as Record<string, unknown> | null;
    if (!plan || String(plan.status) !== targetStatus) {
      throw new HttpError(404, `No ${targetStatus} training plan found for id`);
    }
  } else {
    const { data, error } = await supabaseAdmin
      .from("membership_training_plans")
      .select("*")
      .eq("membership_id", membershipId)
      .eq("status", targetStatus)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw new HttpError(500, "Failed to load training plan", error);
    plan = data as Record<string, unknown> | null;
    if (!plan) throw new HttpError(404, `No ${targetStatus} training plan found`);
  }

  const startDate = String(plan.start_date ?? "");
  const endDate = plan.end_date ? String(plan.end_date) : null;
  let effectiveDate = startDate;
  if (cancelMode === "scheduled") {
    effectiveDate = planDateFromBody(
      body.effective_date ?? body.effectiveDate,
      "effective_date",
    );
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

  const planId = String(body.id ?? body.queue_id ?? body.queueId ?? "").trim();
  let plan: Record<string, unknown> | null = null;

  if (planId) {
    const { data, error } = await supabaseAdmin
      .from("membership_nutrition_plans")
      .select("*")
      .eq("id", planId)
      .eq("membership_id", membershipId)
      .maybeSingle();
    if (error) throw new HttpError(500, "Failed to load nutrition plan", error);
    plan = data as Record<string, unknown> | null;
    if (!plan || String(plan.status) !== targetStatus) {
      throw new HttpError(404, `No ${targetStatus} nutrition plan found for id`);
    }
  } else {
    const { data, error } = await supabaseAdmin
      .from("membership_nutrition_plans")
      .select("*")
      .eq("membership_id", membershipId)
      .eq("status", targetStatus)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw new HttpError(500, "Failed to load nutrition plan", error);
    plan = data as Record<string, unknown> | null;
    if (!plan) throw new HttpError(404, `No ${targetStatus} nutrition plan found`);
  }

  const endDate = plan.end_date ? String(plan.end_date) : null;
  let effectiveDate = String(plan.start_date ?? "");
  if (cancelMode === "scheduled") {
    effectiveDate = planDateFromBody(
      body.effective_date ?? body.effectiveDate,
      "effective_date",
    );
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
