import { supabaseAdmin } from "../db/supabase.js";
import { MembershipService } from "../services/membership-service.js";
import {
  activateDueQueuedNutritionPlansIfNeeded,
  activateDueQueuedTrainingPlansIfNeeded,
} from "../services/membership-plan-service.js";

function calendarTodayYmd(): string {
  return new Date().toISOString().slice(0, 10);
}

export type ActivateDueQueuedPlansResult = {
  scanned: number;
  trainingActivated: number;
  nutritionActivated: number;
};

/**
 * Activate queued training/nutrition plans whose start_date is today or earlier
 */
export async function runActivateDueQueuedPlans(): Promise<ActivateDueQueuedPlansResult> {
  const today = calendarTodayYmd();
  const membershipIds = new Set<string>();

  const [trainingResp, nutritionResp] = await Promise.all([
    supabaseAdmin
      .from("membership_training_plans")
      .select("membership_id")
      .eq("status", "queued")
      .lte("start_date", today),
    supabaseAdmin
      .from("membership_nutrition_plans")
      .select("membership_id")
      .eq("status", "queued")
      .lte("start_date", today),
  ]);

  if (trainingResp.error) {
    const msg = String(trainingResp.error.message ?? "");
    if (!msg.includes("does not exist") && !msg.includes("relation")) {
      throw trainingResp.error;
    }
  } else {
    for (const row of trainingResp.data ?? []) {
      const id = String((row as { membership_id: string }).membership_id ?? "").trim();
      if (id) membershipIds.add(id);
    }
  }

  if (nutritionResp.error) {
    const msg = String(nutritionResp.error.message ?? "");
    if (!msg.includes("does not exist") && !msg.includes("relation")) {
      throw nutritionResp.error;
    }
  } else {
    for (const row of nutritionResp.data ?? []) {
      const id = String((row as { membership_id: string }).membership_id ?? "").trim();
      if (id) membershipIds.add(id);
    }
  }

  let trainingActivated = 0;
  let nutritionActivated = 0;
  const membershipService = new MembershipService();

  for (const membershipId of membershipIds) {
    const { data: membership, error: mmErr } = await supabaseAdmin
      .from("member_memberships")
      .select("*")
      .eq("id", membershipId)
      .maybeSingle();
    if (mmErr) throw mmErr;
    if (!membership) continue;

    const trainingResult = await activateDueQueuedTrainingPlansIfNeeded(
      membership as Record<string, unknown>,
    );
    if (trainingResult) {
      const allocationMode = String(trainingResult.allocationMode ?? "sessions");
      if (allocationMode !== "location" && trainingResult.allocations.length > 0) {
        await membershipService.applyTrainingAllocationsFromPlan(
          membershipId,
          trainingResult.allocations,
        );
      }
      trainingActivated += 1;
    }

    const nutritionDone = await activateDueQueuedNutritionPlansIfNeeded(membershipId);
    if (nutritionDone) nutritionActivated += 1;
  }

  return {
    scanned: membershipIds.size,
    trainingActivated,
    nutritionActivated,
  };
}
