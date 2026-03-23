import { supabaseAdmin } from "../db/supabase.js";
import { HttpError } from "../lib/http-error.js";

type MembershipMode = "inperson" | "remote";
type PlanTier = "structure" | "pace" | "performance";

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
}
