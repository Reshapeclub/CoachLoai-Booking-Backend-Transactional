import { supabaseAdmin } from "../db/supabase.js";
import { HttpError } from "../lib/http-error.js";

export class BookingService {
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
    locationId?: string
  ) {
    const { data: user, error: userError } = await supabaseAdmin.from("profiles").select("*").eq("id", memberId).single();
    if (userError || !user) throw new HttpError(404, "Member not found");

    let query = supabaseAdmin
      .from("sessions")
      .select("*, session_types(*), coaches(profiles(full_name))")
      .gte("start_at", from ?? new Date().toISOString())
      .order("start_at", { ascending: true });
    if (to) query = query.lte("start_at", to);
    if (sessionTypeId) query = query.eq("session_type_id", sessionTypeId);
    const effectiveLocationId = locationId ?? user.location_id;
    if (effectiveLocationId) query = query.eq("location_id", effectiveLocationId);

    const { data: sessions, error } = await query;
    if (error) throw new HttpError(500, "Failed to fetch available sessions", error);
    const list = (sessions ?? []) as Array<
      Record<string, unknown> & { id: string; capacity: number; coaches?: { profiles?: { full_name?: string } } }
    >;
    if (list.length === 0) return [];

    const sessionIds = list.map((s) => s.id);

    const [bookedCountsRes, memberBookingsRes, memberWaitlistRes] = await Promise.all([
      supabaseAdmin.from("bookings").select("session_id").in("session_id", sessionIds).eq("status", "booked"),
      supabaseAdmin.from("bookings").select("session_id").eq("member_id", memberId).eq("status", "booked").in("session_id", sessionIds),
      supabaseAdmin.from("waiting_list_entries").select("session_id").eq("member_id", memberId).in("session_id", sessionIds),
    ]);

    const bookedBySession = new Map<string, number>();
    for (const row of bookedCountsRes.data ?? []) {
      const sid = (row as { session_id: string }).session_id;
      bookedBySession.set(sid, (bookedBySession.get(sid) ?? 0) + 1);
    }
    const memberBookedSessionIds = new Set((memberBookingsRes.data ?? []).map((r) => (r as { session_id: string }).session_id));
    const memberWaitlistSessionIds = new Set((memberWaitlistRes.data ?? []).map((r) => (r as { session_id: string }).session_id));

    return list.map((s) => {
      const coachName = s.coaches?.profiles?.full_name ?? null;
      const { coaches, ...rest } = s;
      const bookedCount = bookedBySession.get(s.id) ?? 0;
      const isFull = bookedCount >= s.capacity;
      const isBookedByMe = memberBookedSessionIds.has(s.id);
      const isOnWaitlist = memberWaitlistSessionIds.has(s.id);
      let status: "open" | "full" | "booked" = isBookedByMe ? "booked" : isFull ? "full" : "open";
      return {
        ...rest,
        coach_name: coachName,
        booked_count: bookedCount,
        status,
        isBookedByMe,
        isOnWaitlist,
      };
    });
  }

  async getSessionDetail(sessionId: string) {
    const { data, error } = await supabaseAdmin
      .from("sessions")
      .select("*, session_types(*), coaches(profiles(full_name))")
      .eq("id", sessionId)
      .single();
    if (error) throw new HttpError(404, "Session not found", error);
    const s = data as Record<string, unknown> & { coaches?: { profiles?: { full_name?: string } } };
    const coachName = s?.coaches?.profiles?.full_name ?? null;
    const { coaches, ...rest } = s ?? {};
    return { ...rest, coach_name: coachName };
  }

  async createBooking(input: { memberId: string; membershipId: string; sessionId: string }) {
    const { data, error } = await supabaseAdmin.rpc("clm_create_booking", {
      p_member_id: input.memberId,
      p_membership_id: input.membershipId,
      p_session_id: input.sessionId,
      p_now: new Date().toISOString(),
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

  async joinWaitlist(input: { memberId: string; membershipId: string; sessionId: string }) {
    const { data, error } = await supabaseAdmin.rpc("clm_join_waitlist", {
      p_member_id: input.memberId,
      p_membership_id: input.membershipId,
      p_session_id: input.sessionId,
      p_now: new Date().toISOString(),
    });
    if (error) throw new HttpError(422, "Failed to join waiting list", error);
    return data;
  }

  async getBookings(memberId: string, status?: string) {
    let query = supabaseAdmin.from("bookings").select("*, sessions(*, session_types(*))").eq("member_id", memberId).order("booked_at", { ascending: false });
    if (status === "upcoming") query = query.eq("status", "booked");
    if (status === "past") query = query.neq("status", "booked");
    const { data, error } = await query;
    if (error) throw new HttpError(500, "Failed to fetch bookings", error);
    return data ?? [];
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
    let sessionIdsInRange: string[] | undefined;
    if (filters.from != null || filters.to != null) {
      let sq = supabaseAdmin.from("sessions").select("id");
      if (filters.from) sq = sq.gte("start_at", filters.from);
      if (filters.to) sq = sq.lte("start_at", filters.to);
      const { data: sessRows, error: sessErr } = await sq;
      if (sessErr) throw new HttpError(500, "Failed to resolve sessions for date filter", sessErr);
      sessionIdsInRange = (sessRows ?? []).map((r) => (r as { id: string }).id);
      if (sessionIdsInRange.length === 0) return [];
    }

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
    if (sessionIdsInRange) query = query.in("session_id", sessionIdsInRange);

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

  async adminCancelSession(input: { sessionId: string; refund: "refund" | "charge"; adminId: string }) {
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
