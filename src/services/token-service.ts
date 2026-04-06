import { supabaseAdmin } from "../db/supabase.js";
import { HttpError } from "../lib/http-error.js";

export class TokenService {
  private readonly unitAmountMinorCentsByName: Record<string, number> = {
    Elite: 3500,
    Group: 1500,
    Octave: 2500,
    "1:1": 9000,
  };

  async listPurchaseOptions() {
    const expiryPolicy = this.getPurchaseExpiryPolicy();
    const { data, error } = await supabaseAdmin
      .from("session_types")
      .select("id, name, token_type_id, color, icon, display_order, is_active")
      .eq("is_active", true)
      .order("display_order", { ascending: true })
      .order("created_at", { ascending: true });

    if (error) throw new HttpError(500, "Failed to fetch purchasable session options", error);

    return (data ?? [])
      .map((item) => {
        const unitAmountMinorCents = this.unitAmountMinorCentsByName[item.name];
        if (!unitAmountMinorCents) return null;
        return {
          id: item.id,
          name: item.name,
          tokenTypeId: item.token_type_id,
          color: item.color,
          icon: item.icon ?? (item.name === "Group" ? "👥" : null),
          unitAmountMinorCents,
          unitPrice: unitAmountMinorCents / 100,
          expiryPolicy,
        };
      })
      .filter((item): item is NonNullable<typeof item> => item !== null);
  }

  async getWallet(memberId: string) {
    const { data, error } = await supabaseAdmin
      .from("tokens")
      .select("*")
      .eq("member_id", memberId)
      .order("created_at", { ascending: false });
    if (error) throw new HttpError(500, "Failed to fetch token wallet", error);
    return (data ?? []).filter((t) => t.coach_id !== null);
  }

  async getAdditionalSessionsSummary(memberId: string) {
    const nowIso = new Date().toISOString();
    const { data: purchasedTokens, error: purchasedError } = await supabaseAdmin
      .from('tokens')
      .select('id, quantity, created_at, expiry_at, coach_id')
      .eq('member_id', memberId)
      .not('coach_id', 'is', null)
      .gt('expiry_at', nowIso)
      .order('created_at', { ascending: true });

    if (purchasedError) {
      throw new HttpError(500, "Failed to fetch additional purchased sessions", purchasedError);
    }

    const tokens = purchasedTokens ?? [];
    if (tokens.length === 0) {
      return {
        coachId: null,
        coachName: null,
        totalPurchased: 0,
        totalUsed: 0,
        sessionsRemaining: 0,
        startsAt: null,
        expiresAt: null,
      };
    }

    const tokenIds = tokens.map((t) => t.id);
    const { data: deductions, error: deductionsError } = await supabaseAdmin
      .from('booking_token_deductions')
      .select('token_id, quantity')
      .in('token_id', tokenIds);

    if (deductionsError) {
      throw new HttpError(500, "Failed to fetch additional sessions usage", deductionsError);
    }

    const usedByTokenId = new Map<string, number>();
    for (const row of deductions ?? []) {
      usedByTokenId.set(row.token_id, (usedByTokenId.get(row.token_id) ?? 0) + row.quantity);
    }

    const coachMap = new Map<string, {
      coachId: string;
      coachName?: string;
      totalPurchased: number;
      totalUsed: number;
      sessionsRemaining: number;
      startsAt: string | null;
      expiresAt: string | null;
    }>();

    for (const token of tokens) {
      if (!token.coach_id) continue;
      const coachId = token.coach_id;
      const entry = coachMap.get(coachId) ?? {
        coachId,
        totalPurchased: 0,
        totalUsed: 0,
        sessionsRemaining: 0,
        startsAt: null,
        expiresAt: null,
      };
      const used = usedByTokenId.get(token.id) ?? 0;

      entry.totalPurchased += token.quantity;
      entry.totalUsed += used;
      entry.sessionsRemaining += Math.max(0, token.quantity - used);

      if (!entry.startsAt || token.created_at < entry.startsAt) entry.startsAt = token.created_at;
      if (!entry.expiresAt || token.expiry_at > entry.expiresAt) entry.expiresAt = token.expiry_at;

      coachMap.set(coachId, entry);
    }

    const coachIds = Array.from(coachMap.keys());
    if (coachIds.length) {
      const { data: coaches } = await supabaseAdmin
        .from('coaches')
        .select('id, name')
        .in('id', coachIds);
      coaches?.forEach(c => {
        const entry = coachMap.get(c.id);
        if (entry) entry.coachName = c.name;
      });
    }
    return Array.from(coachMap.values());
  }

  private weeksForQuantity(quantity: number): number {
    if (quantity <= 4) return 4;
    if (quantity <= 8) return 8;
    return 12;
  }

  private getPurchaseExpiryPolicy() {
    return {
      bands: [
        { minQty: 1, maxQty: 4, expiryWeeks: 4, label: "4 weeks" },
        { minQty: 5, maxQty: 8, expiryWeeks: 8, label: "8 weeks" },
        { minQty: 9, maxQty: 12, expiryWeeks: 12, label: "12 weeks" },
      ]
    };
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
    coachId?: string;
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
        coach_id: input.coachId ?? null,
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
    coachId?: string;
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
        coach_id: input.coachId ?? null,
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
