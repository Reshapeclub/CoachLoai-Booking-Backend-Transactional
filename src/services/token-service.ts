import { supabaseAdmin } from "../db/supabase.js";
import { HttpError } from "../lib/http-error.js";

export class TokenService {
  async getWallet(memberId: string) {
    const { data, error } = await supabaseAdmin
      .from("tokens")
      .select("*")
      .eq("member_id", memberId)
      .order("created_at", { ascending: false });
    if (error) throw new HttpError(500, "Failed to fetch token wallet", error);
    return data ?? [];
  }

  private weeksForQuantity(quantity: number): number {
    if (quantity <= 4) return 4;
    if (quantity <= 8) return 8;
    return 12;
  }

  private computeExpiryIso(input: {
    purchaseDate: Date;
    quantity: number;
    membershipEndDate: Date;
    membershipTerminationDate: Date | null;
  }): string {
    const weeksToAdd = this.weeksForQuantity(input.quantity);
    const baseMs = input.purchaseDate.getTime() + weeksToAdd * 7 * 24 * 60 * 60 * 1000;

    const capTimes: number[] = [input.membershipEndDate.getTime()];
    if (input.membershipTerminationDate) capTimes.push(input.membershipTerminationDate.getTime());
    const cappedMs = Math.min(baseMs, ...capTimes);
    return new Date(cappedMs).toISOString();
  }

  private async getMembershipCapById(membershipId: string): Promise<{
    membershipEndDate: Date;
    membershipTerminationDate: Date | null;
  }> {
    const { data, error } = await supabaseAdmin
      .from("member_memberships")
      .select("end_date, termination_date")
      .eq("id", membershipId)
      .maybeSingle();

    if (error) throw new HttpError(500, "Failed to fetch membership for token cap", error);
    if (!data) throw new HttpError(404, "Membership not found for token cap");
    return {
      membershipEndDate: new Date(data.end_date),
      membershipTerminationDate: data.termination_date ? new Date(data.termination_date) : null,
    };
  }

  private async getLatestMembershipCapByMemberId(
    memberId: string
  ): Promise<{
    membershipEndDate: Date;
    membershipTerminationDate: Date | null;
  }> {
    const { data, error } = await supabaseAdmin
      .from("member_memberships")
      .select("id")
      .eq("member_id", memberId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) throw new HttpError(500, "Failed to fetch membership for token cap", error);
    if (!data) throw new HttpError(404, "No membership found for this member");

    return this.getMembershipCapById(data.id);
  }

  async issueAdminTokens(input: {
    memberId: string;
    tokenTypeId: string;
    quantity: number;
    expiryAt?: string;
  }) {
    const purchaseDate = new Date();
    const { membershipEndDate, membershipTerminationDate } =
      await this.getLatestMembershipCapByMemberId(input.memberId);

    const algorithmExpiryIso = this.computeExpiryIso({
      purchaseDate,
      quantity: input.quantity,
      membershipEndDate,
      membershipTerminationDate,
    });

    const finalExpiryIso = input.expiryAt
      ? (() => {
          const provided = new Date(input.expiryAt).getTime();
          const computed = new Date(algorithmExpiryIso).getTime();
          return new Date(Math.min(provided, computed)).toISOString();
        })()
      : algorithmExpiryIso;

    const { data, error } = await supabaseAdmin
      .from("tokens")
      .insert({
        member_id: input.memberId,
        token_type_id: input.tokenTypeId,
        quantity: input.quantity,
        expiry_at: finalExpiryIso,
        source: "admin",
        source_meta: { issuedAt: purchaseDate.toISOString() },
      })
      .select()
      .single();
    if (error) throw new HttpError(500, "Failed to issue admin tokens", error);
    return data;
  }

  async issuePurchasedTokensFromStripeSession(input: {
    stripeSessionId: string;
    memberId: string;
    membershipId: string;
    tokenTypeId: string;
    quantity: number;
    purchaseDate?: Date;
  }) {
    const { data: existing, error: existingError } = await supabaseAdmin
      .from("tokens")
      .select("id")
      .eq("member_id", input.memberId)
      .eq("token_type_id", input.tokenTypeId)
      .eq("source", "purchase")
      .contains("source_meta", { stripeSessionId: input.stripeSessionId })
      .limit(1)
      .maybeSingle();

    if (existingError) {
      throw new HttpError(500, "Failed checking idempotency for purchased tokens", existingError);
    }
    if (existing?.id) return existing;

    const purchaseDate = input.purchaseDate ?? new Date();
    const { membershipEndDate, membershipTerminationDate } =
      await this.getMembershipCapById(input.membershipId);

    const expiry_at = this.computeExpiryIso({
      purchaseDate,
      quantity: input.quantity,
      membershipEndDate,
      membershipTerminationDate,
    });

    const { data, error } = await supabaseAdmin
      .from("tokens")
      .insert({
        member_id: input.memberId,
        token_type_id: input.tokenTypeId,
        quantity: input.quantity,
        week_start: null,
        expiry_at,
        source: "purchase",
        source_meta: {
          stripeSessionId: input.stripeSessionId,
          membershipId: input.membershipId,
        },
      })
      .select()
      .single();

    if (error) throw new HttpError(500, "Failed to issue purchased tokens", error);
    return data;
  }

  async generateWeeklyTokens(weekStartIso: string) {
    const { data, error } = await supabaseAdmin.rpc("clm_generate_weekly_tokens", {
      p_week_start: weekStartIso,
      p_now: new Date().toISOString(),
    });
    if (error) throw new HttpError(500, "Failed to generate weekly tokens", error);
    return data;
  }
}
