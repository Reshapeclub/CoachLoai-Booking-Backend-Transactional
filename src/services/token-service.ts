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
      .select("id, name, category, token_type_id, color, icon, display_order, is_active, category_icon")
      .eq("is_active", true)
      .order("display_order", { ascending: true })
      .order("created_at", { ascending: true });

    if (error) throw new HttpError(500, "Failed to fetch purchasable session options", error);

    // Category-level tokens: show ONE purchasable option per category/tokenTypeId
    const byCategory = new Map<string, (typeof data)[number]>();
    for (const row of data ?? []) {
      const category = (row as { category?: string | null }).category ?? null;
      if (!category) continue;
      if (!this.unitAmountMinorCentsByName[category]) continue;
      if (!byCategory.has(category)) byCategory.set(category, row);
    }

    return Array.from(byCategory.entries()).map(([category, item]) => {
      const unitAmountMinorCents = this.unitAmountMinorCentsByName[category];
      return {
        id: item.id,
        name: category,
        tokenTypeId: item.token_type_id,
        color: item.color,
        icon: item.category_icon ?? (category === "Group" ? "👥" : null),
        unitAmountMinorCents,
        unitPrice: unitAmountMinorCents / 100,
        expiryPolicy,
      };
    });
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

  /** Admin id stored on gift tokens in `source_meta.created_by_admin_id` */
  #adminIdFromGiftMeta(meta: unknown): number | null {
    if (!meta || typeof meta !== "object") return null;
    const v = (meta as Record<string, unknown>).created_by_admin_id;
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string" && /^\d+$/.test(v.trim())) return parseInt(v.trim(), 10);
    return null;
  }

  /**
   * Additional sessions: purchased tokens (with coach) plus `source = gift`.
   * Issuer label: coach name when `coach_id` is set, otherwise admin name from gift meta.
   */
  async getAdditionalSessionsSummary(memberId: string) {
    const empty = {
      coachId: null as string | null,
      coachName: null as string | null,
      totalPurchased: 0,
      totalUsed: 0,
      sessionsRemaining: 0,
      startsAt: null as string | null,
      expiresAt: null as string | null,
    };

    const nowIso = new Date().toISOString();
    const { data: rawRows, error: fetchError } = await supabaseAdmin
      .from("tokens")
      .select("id, quantity, created_at, expiry_at, coach_id, source, source_meta")
      .eq("member_id", memberId)
      .in("source", ["purchase", "gift"])
      .gt("expiry_at", nowIso)
      .order("created_at", { ascending: true });

    if (fetchError) {
      throw new HttpError(500, "Failed to fetch additional sessions tokens", fetchError);
    }

    const tokens = (rawRows ?? []).filter((t) => {
      const src = String((t as { source?: string }).source ?? "");
      if (src === "gift") return true;
      if (src === "purchase" && (t as { coach_id?: string | null }).coach_id != null) return true;
      return false;
    }) as Array<{
      id: string;
      quantity: number;
      created_at: string;
      expiry_at: string;
      coach_id: string | null;
      source: string;
      source_meta: Record<string, unknown> | null;
    }>;

    if (tokens.length === 0) {
      return empty;
    }

    const tokenIds = tokens.map((t) => t.id);
    const { data: deductions, error: deductionsError } = await supabaseAdmin
      .from("booking_token_deductions")
      .select("token_id, quantity")
      .in("token_id", tokenIds);

    if (deductionsError) {
      throw new HttpError(500, "Failed to fetch additional sessions usage", deductionsError);
    }

    const usedByTokenId = new Map<string, number>();
    for (const row of deductions ?? []) {
      usedByTokenId.set(row.token_id, (usedByTokenId.get(row.token_id) ?? 0) + row.quantity);
    }

    type Bucket = {
      key: string;
      coachId: string | null;
      adminId: number | null;
      totalPurchased: number;
      totalUsed: number;
      sessionsRemaining: number;
      startsAt: string | null;
      expiresAt: string | null;
    };

    const bucketMap = new Map<string, Bucket>();

    for (const token of tokens) {
      const coachId = token.coach_id != null ? String(token.coach_id) : null;
      const adminId = coachId ? null : this.#adminIdFromGiftMeta(token.source_meta);
      const key = coachId ? `c:${coachId}` : `a:${adminId ?? "na"}`;

      const entry = bucketMap.get(key) ?? {
        key,
        coachId,
        adminId,
        totalPurchased: 0,
        totalUsed: 0,
        sessionsRemaining: 0,
        startsAt: null as string | null,
        expiresAt: null as string | null,
      };
      const used = usedByTokenId.get(token.id) ?? 0;

      entry.totalPurchased += token.quantity;
      entry.totalUsed += used;
      entry.sessionsRemaining += Math.max(0, token.quantity - used);

      if (!entry.startsAt || token.created_at < entry.startsAt) entry.startsAt = token.created_at;
      if (!entry.expiresAt || token.expiry_at > entry.expiresAt) entry.expiresAt = token.expiry_at;
      if (entry.adminId == null && adminId != null) entry.adminId = adminId;

      bucketMap.set(key, entry);
    }

    const coachIds = [...new Set([...bucketMap.values()].map((b) => b.coachId).filter(Boolean))] as string[];
    const adminIds = [...new Set([...bucketMap.values()].map((b) => b.adminId).filter((id): id is number => id != null))];

    const coachNameById = new Map<string, string>();
    if (coachIds.length) {
      const { data: coaches, error: coachesError } = await supabaseAdmin
        .from("coaches")
        .select("id, admins!coaches_user_id_fkey(name)")
        .in("id", coachIds);
      if (coachesError) {
        throw new HttpError(500, "Failed to fetch coach names for token summary", coachesError);
      }
      type CoachRow = { id: string; admins?: { name?: string | null } | null };
      for (const c of (coaches ?? []) as CoachRow[]) {
        const name = c.admins?.name != null ? String(c.admins.name).trim() : "";
        if (name) coachNameById.set(c.id, name);
      }
    }

    const adminNameById = new Map<number, string>();
    if (adminIds.length) {
      const { data: admins, error: adminsError } = await supabaseAdmin
        .from("admins")
        .select("id, name")
        .in("id", adminIds);
      if (adminsError) {
        throw new HttpError(500, "Failed to fetch admin names for gift token summary", adminsError);
      }
      for (const a of admins ?? []) {
        const row = a as { id: number; name?: string | null };
        const name = row.name != null ? String(row.name).trim() : "";
        if (name) adminNameById.set(row.id, name);
      }
    }

    const issuerLabels: string[] = [];
    for (const b of bucketMap.values()) {
      if (b.coachId) {
        const n = coachNameById.get(b.coachId) ?? "Coach";
        if (!issuerLabels.includes(n)) issuerLabels.push(n);
      } else if (b.adminId != null) {
        const n = adminNameById.get(b.adminId) ?? "Team";
        if (!issuerLabels.includes(n)) issuerLabels.push(n);
      } else {
        const n = "Team";
        if (!issuerLabels.includes(n)) issuerLabels.push(n);
      }
    }

    let totalPurchased = 0;
    let totalUsed = 0;
    let sessionsRemaining = 0;
    let startsAt: string | null = null;
    let expiresAt: string | null = null;

    for (const b of bucketMap.values()) {
      totalPurchased += b.totalPurchased;
      totalUsed += b.totalUsed;
      sessionsRemaining += b.sessionsRemaining;
      if (!startsAt || (b.startsAt && b.startsAt < startsAt)) startsAt = b.startsAt;
      if (!expiresAt || (b.expiresAt && b.expiresAt > expiresAt)) expiresAt = b.expiresAt;
    }

    const primaryCoachId = [...bucketMap.values()].find((b) => b.coachId != null)?.coachId ?? null;

    return {
      coachId: primaryCoachId,
      coachName: issuerLabels.length ? issuerLabels.join(", ") : null,
      totalPurchased,
      totalUsed,
      sessionsRemaining,
      startsAt,
      expiresAt,
    };
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

  // ── Membership gifts: stored as `tokens` rows with source = 'gift' ───────────

  private giftSessionCodeToCategory(code: string): string {
    const c = String(code).trim();
    if (c === "oneToOne") return "1:1";
    if (c === "elite") return "Elite";
    if (c === "octave") return "Octave";
    if (c === "group") return "Group";
    throw new HttpError(400, "Invalid session_type for gift");
  }

  private parseYmdToUtcStart(ymd: string): Date {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd).trim());
    if (!m) throw new HttpError(400, "Invalid date (expected YYYY-MM-DD)");
    return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 0, 0, 0, 0));
  }

  private parseYmdToUtcEndInclusive(ymd: string): Date {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd).trim());
    if (!m) throw new HttpError(400, "Invalid date (expected YYYY-MM-DD)");
    return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 23, 59, 59, 999));
  }

  private toYmdFromIso(iso: string): string {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "";
    return d.toISOString().slice(0, 10);
  }

  private async resolveTokenTypeIdForGift(sessionType: string): Promise<string> {
    const category = this.giftSessionCodeToCategory(sessionType);
    let { data, error } = await supabaseAdmin
      .from("session_types")
      .select("token_type_id")
      .eq("category", category)
      .eq("is_active", true)
      .order("display_order", { ascending: true })
      .limit(1)
      .maybeSingle();
    if (error) throw new HttpError(500, "Failed to resolve token type for gift", error);
    if (!data?.token_type_id) {
      const fallback = await supabaseAdmin
        .from("session_types")
        .select("token_type_id")
        .eq("category", category)
        .order("display_order", { ascending: true })
        .limit(1)
        .maybeSingle();
      if (fallback.error) throw new HttpError(500, "Failed to resolve token type for gift", fallback.error);
      if (!fallback.data?.token_type_id) {
        throw new HttpError(404, `No session type for category ${category}`);
      }
      return String(fallback.data.token_type_id);
    }
    return String(data.token_type_id);
  }

  private async ensureMemberExists(memberId: string): Promise<void> {
    const { data, error } = await supabaseAdmin.from("profiles").select("id").eq("id", memberId).maybeSingle();
    if (error) throw new HttpError(500, "Failed to verify member", error);
    if (!data) throw new HttpError(404, "Member not found");
  }

  private deriveGiftStatus(row: {
    quantity: number;
    expiry_at: string;
    source_meta?: Record<string, unknown> | null;
  }): "active" | "expired" | "cancelled" | "used" {
    const meta = (row.source_meta ?? {}) as Record<string, unknown>;
    if (meta.cancelled === true || meta.status === "cancelled") return "cancelled";
    if (row.quantity <= 0) return "used";
    if (new Date() > new Date(row.expiry_at)) return "expired";
    return "active";
  }

  private mapGiftTokenToPayload(
    row: Record<string, unknown>,
    usedFromBookings: number,
  ): Record<string, unknown> {
    const meta = (row.source_meta ?? {}) as Record<string, unknown>;
    const original = Number(meta.original_quantity);
    const qty = Number(row.quantity ?? 0);
    const amount = Number.isFinite(original) && original > 0 ? original : qty + usedFromBookings;
    const status = this.deriveGiftStatus({
      quantity: qty,
      expiry_at: String(row.expiry_at ?? ""),
      source_meta: meta,
    });
    return {
      id: row.id,
      token_id: row.id,
      membership_id: meta.membership_id ?? null,
      session_type: meta.session_type ?? null,
      amount,
      remaining: qty,
      start_date: meta.start_date ?? null,
      expiry_date: this.toYmdFromIso(String(row.expiry_at ?? "")),
      status,
      created_at: row.created_at,
      coach_id: row.coach_id ?? null,
    };
  }

  /** GET /admin/members/:memberId/membership/gifts — rows from `tokens` where source = gift */
  async listMemberGiftSessions(memberId: string) {
    await this.ensureMemberExists(memberId);
    const { data: rows, error } = await supabaseAdmin
      .from("tokens")
      .select("*")
      .eq("member_id", memberId)
      .eq("source", "gift")
      .order("created_at", { ascending: false });
    if (error) throw new HttpError(500, "Failed to list gift tokens", error);
    const list = rows ?? [];
    if (list.length === 0) return [];

    const ids = list.map((r) => String((r as { id: string }).id));
    const { data: dedRows, error: dedErr } = await supabaseAdmin
      .from("booking_token_deductions")
      .select("token_id, quantity")
      .in("token_id", ids);
    if (dedErr) throw new HttpError(500, "Failed to load gift token usage", dedErr);
    const usedByToken = new Map<string, number>();
    for (const d of dedRows ?? []) {
      const dr = d as { token_id: string; quantity: number };
      usedByToken.set(dr.token_id, (usedByToken.get(dr.token_id) ?? 0) + (dr.quantity ?? 0));
    }

    return list.map((r) => this.mapGiftTokenToPayload(r as Record<string, unknown>, usedByToken.get(String((r as { id: string }).id)) ?? 0));
  }

  async createMemberGiftSession(input: {
    memberId: string;
    mode?: "inperson" | "remote";
    sessionType: string;
    amount: number;
    startDateYmd: string;
    expiryDateYmd: string;
    coachId?: string | null;
    adminUserId?: string | null;
  }) {
    await this.ensureMemberExists(input.memberId);
    const start = this.parseYmdToUtcStart(input.startDateYmd);
    const endIncl = this.parseYmdToUtcEndInclusive(input.expiryDateYmd);
    if (endIncl.getTime() < start.getTime()) {
      throw new HttpError(400, "expiry_date must be on or after start_date");
    }

    const mode = input.mode ?? "inperson";
    const { data: mm, error: mmErr } = await supabaseAdmin
      .from("member_memberships")
      .select("id, end_date, termination_date")
      .eq("member_id", input.memberId)
      .eq("mode", mode)
      .maybeSingle();
    if (mmErr) throw new HttpError(500, "Failed to resolve membership for gift", mmErr);

    let expiryMs = endIncl.getTime();
    if (mm) {
      const endMs = new Date(mm.end_date).getTime();
      expiryMs = Math.min(expiryMs, endMs);
      if (mm.termination_date) {
        const termMs = new Date(mm.termination_date).getTime();
        expiryMs = Math.min(expiryMs, termMs - 1);
      }
    }
    const expiryIso = new Date(expiryMs).toISOString();

    const tokenTypeId = await this.resolveTokenTypeIdForGift(input.sessionType);
    const adminIdParsed =
      input.adminUserId != null && /^\d+$/.test(String(input.adminUserId).trim())
        ? parseInt(String(input.adminUserId).trim(), 10)
        : null;

    const sourceMeta: Record<string, unknown> = {
      session_type: input.sessionType,
      start_date: input.startDateYmd,
      expiry_date: input.expiryDateYmd,
      original_quantity: input.amount,
      mode,
    };
    if (mm?.id) sourceMeta.membership_id = mm.id;
    if (adminIdParsed != null) sourceMeta.created_by_admin_id = adminIdParsed;

    const { data, error } = await supabaseAdmin
      .from("tokens")
      .insert({
        member_id: input.memberId,
        token_type_id: tokenTypeId,
        quantity: input.amount,
        week_start: null,
        expiry_at: expiryIso,
        source: "gift",
        source_meta: sourceMeta,
        coach_id: input.coachId ?? null,
      })
      .select("*")
      .single();
    if (error) throw new HttpError(500, "Failed to create gift token entry", error);
    return this.mapGiftTokenToPayload(data as Record<string, unknown>, 0);
  }

  async patchMemberGiftSession(input: {
    memberId: string;
    giftTokenId: string;
    mode?: "inperson" | "remote";
    status?: "active" | "expired" | "cancelled" | "used";
    expiryDateYmd?: string;
  }) {
    await this.ensureMemberExists(input.memberId);
    const { data: row, error } = await supabaseAdmin
      .from("tokens")
      .select("*")
      .eq("id", input.giftTokenId)
      .eq("member_id", input.memberId)
      .eq("source", "gift")
      .maybeSingle();
    if (error) throw new HttpError(500, "Failed to load gift token", error);
    if (!row) throw new HttpError(404, "Gift token not found");

    const meta: Record<string, unknown> = { ...((row.source_meta ?? {}) as Record<string, unknown>) };
    const updates: Record<string, unknown> = {};

    if (input.expiryDateYmd !== undefined) {
      const endIncl = this.parseYmdToUtcEndInclusive(input.expiryDateYmd);
      const startYmd = String(meta.start_date ?? "");
      if (startYmd) {
        const start = this.parseYmdToUtcStart(startYmd);
        if (endIncl.getTime() < start.getTime()) {
          throw new HttpError(400, "expiry_date must be on or after start_date");
        }
      }
      updates.expiry_at = endIncl.toISOString();
      meta.expiry_date = input.expiryDateYmd;
    }

    if (input.status === "cancelled" || input.status === "used") {
      updates.quantity = 0;
      meta.status = input.status;
      if (input.status === "cancelled") meta.cancelled = true;
    } else if (input.status === "expired") {
      updates.expiry_at = new Date().toISOString();
      meta.marked_expired = true;
    }

    if (Object.keys(updates).length === 0) {
      throw new HttpError(400, "No valid updates");
    }

    updates.source_meta = meta;

    const { data: updated, error: uErr } = await supabaseAdmin
      .from("tokens")
      .update(updates)
      .eq("id", input.giftTokenId)
      .select("*")
      .single();
    if (uErr) throw new HttpError(500, "Failed to update gift token", uErr);

    const used =
      (
        await supabaseAdmin
          .from("booking_token_deductions")
          .select("quantity")
          .eq("token_id", input.giftTokenId)
      ).data?.reduce((s, r) => s + Number((r as { quantity: number }).quantity ?? 0), 0) ?? 0;

    return this.mapGiftTokenToPayload(updated as Record<string, unknown>, used);
  }

  async consumeMemberGiftSession(input: {
    memberId: string;
    giftTokenId: string;
    quantity: number;
    consumedOnYmd?: string;
    note?: string | null;
  }) {
    await this.ensureMemberExists(input.memberId);
    const { data: row, error } = await supabaseAdmin
      .from("tokens")
      .select("*")
      .eq("id", input.giftTokenId)
      .eq("member_id", input.memberId)
      .eq("source", "gift")
      .maybeSingle();
    if (error) throw new HttpError(500, "Failed to load gift token", error);
    if (!row) throw new HttpError(404, "Gift token not found");

    const meta = (row.source_meta ?? {}) as Record<string, unknown>;
    if (meta.cancelled === true || meta.status === "cancelled") {
      throw new HttpError(409, "Gift token is cancelled");
    }
    const status = this.deriveGiftStatus({
      quantity: row.quantity,
      expiry_at: row.expiry_at,
      source_meta: meta,
    });
    if (status !== "active") {
      throw new HttpError(409, `Gift token is not active (${status})`);
    }

    const when = input.consumedOnYmd
      ? this.parseYmdToUtcStart(input.consumedOnYmd)
      : new Date();
    if (when.getTime() > new Date(row.expiry_at).getTime()) {
      throw new HttpError(409, "Consumption date is after gift expiry");
    }

    const q = input.quantity;
    if (row.quantity < q) {
      throw new HttpError(409, "Quantity exceeds remaining gift balance");
    }

    const newQty = row.quantity - q;
    const nextMeta = { ...meta };
    const log = Array.isArray(nextMeta.manual_consumptions) ? [...(nextMeta.manual_consumptions as unknown[])] : [];
    log.push({
      quantity: q,
      consumed_on: input.consumedOnYmd ?? this.toYmdFromIso(new Date().toISOString()),
      note: input.note ?? null,
      at: new Date().toISOString(),
    });
    nextMeta.manual_consumptions = log;
    if (newQty === 0) nextMeta.status = "used";

    const { data: updated, error: uErr } = await supabaseAdmin
      .from("tokens")
      .update({ quantity: newQty, source_meta: nextMeta })
      .eq("id", input.giftTokenId)
      .select("*")
      .single();
    if (uErr) throw new HttpError(500, "Failed to consume gift token", uErr);

    const usedFromBookings =
      (
        await supabaseAdmin
          .from("booking_token_deductions")
          .select("quantity")
          .eq("token_id", input.giftTokenId)
      ).data?.reduce((s, r) => s + Number((r as { quantity: number }).quantity ?? 0), 0) ?? 0;

    return this.mapGiftTokenToPayload(updated as Record<string, unknown>, usedFromBookings);
  }
}
