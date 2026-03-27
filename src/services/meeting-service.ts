import { supabaseAdmin } from "../db/supabase.js";
import { HttpError } from "../lib/http-error.js";

export class MeetingService {
  async listMeetingTypesAdmin() {
    const { data, error } = await supabaseAdmin
      .from("meeting_types")
      .select("*")
      .order("display_order", { ascending: true });
    if (error) throw new HttpError(500, "Failed to fetch meeting types", error);
    return data ?? [];
  }

  async createMeetingType(input: {
    name: string;
    code: string;
    durationMins: number;
    description?: string;
    color?: string;
    icon?: string;
    displayOrder?: number;
    isActive?: boolean;
  }) {
    const { data, error } = await supabaseAdmin
      .from("meeting_types")
      .insert({
        name: input.name,
        code: input.code,
        duration_mins: input.durationMins,
        description: input.description ?? null,
        color: input.color ?? null,
        icon: input.icon ?? null,
        display_order: input.displayOrder ?? 0,
        is_active: input.isActive ?? true,
      })
      .select()
      .single();
    if (error) throw new HttpError(500, "Failed to create meeting type", error);
    return data;
  }

  async updateMeetingType(
    meetingTypeId: string,
    input: {
      name?: string;
      code?: string;
      durationMins?: number;
      description?: string | null;
      color?: string | null;
      icon?: string | null;
      displayOrder?: number;
      isActive?: boolean;
    }
  ) {
    const updates: Record<string, unknown> = {};
    if (input.name !== undefined) updates.name = input.name;
    if (input.code !== undefined) updates.code = input.code;
    if (input.durationMins !== undefined) updates.duration_mins = input.durationMins;
    if (input.description !== undefined) updates.description = input.description;
    if (input.color !== undefined) updates.color = input.color;
    if (input.icon !== undefined) updates.icon = input.icon;
    if (input.displayOrder !== undefined) updates.display_order = input.displayOrder;
    if (input.isActive !== undefined) updates.is_active = input.isActive;

    const { data, error } = await supabaseAdmin
      .from("meeting_types")
      .update(updates)
      .eq("id", meetingTypeId)
      .select()
      .single();
    if (error) throw new HttpError(500, "Failed to update meeting type", error);
    return data;
  }

  async listMeetingTypes() {
    const { data, error } = await supabaseAdmin
      .from("meeting_types")
      .select("*")
      .eq("is_active", true)
      .order("display_order", { ascending: true });
    if (error) throw new HttpError(500, "Failed to fetch meeting types", error);
    return data ?? [];
  }

  async getAvailability(
    memberId: string,
    input: { meetingTypeId: string; date: string; locationId?: string }
  ) {
    const { data: profile, error: profileError } = await supabaseAdmin
      .from("profiles")
      .select("location_id")
      .eq("id", memberId)
      .maybeSingle();
    if (profileError) throw new HttpError(500, "Failed to fetch profile", profileError);

    const effectiveLocationId = input.locationId ?? profile?.location_id ?? null;
    if (!effectiveLocationId) {
      throw new HttpError(400, "locationId is required when member profile has no location");
    }

    const { data: meetingType, error: typeError } = await supabaseAdmin
      .from("meeting_types")
      .select("*")
      .eq("id", input.meetingTypeId)
      .eq("is_active", true)
      .maybeSingle();
    if (typeError) throw new HttpError(500, "Failed to fetch meeting type", typeError);
    if (!meetingType) throw new HttpError(404, "Meeting type not found");

    const dayStart = new Date(`${input.date}T00:00:00.000Z`);
    if (Number.isNaN(dayStart.getTime())) throw new HttpError(400, "Invalid date, expected YYYY-MM-DD");
    const dayEnd = new Date(dayStart);
    dayEnd.setUTCDate(dayEnd.getUTCDate() + 1);

    const { data: slots, error: slotError } = await supabaseAdmin
      .from("meeting_slots")
      .select("*")
      .eq("meeting_type_id", input.meetingTypeId)
      .eq("location_id", effectiveLocationId)
      .eq("is_active", true)
      .gte("slot_start", dayStart.toISOString())
      .lt("slot_start", dayEnd.toISOString())
      .order("slot_start", { ascending: true });
    if (slotError) throw new HttpError(500, "Failed to fetch meeting slots", slotError);

    const slotList = slots ?? [];
    if (slotList.length === 0) {
      return { meetingType, locationId: effectiveLocationId, date: input.date, slots: [] };
    }

    const slotStarts = slotList.map((s) => s.slot_start);
    const { data: bookedRows, error: bookedError } = await supabaseAdmin
      .from("track_meetings")
      .select("meeting_start")
      .eq("meeting_type_id", input.meetingTypeId)
      .eq("location_id", effectiveLocationId)
      .eq("status", "booked")
      .in("meeting_start", slotStarts);
    if (bookedError) throw new HttpError(500, "Failed to fetch booked meetings", bookedError);

    const bookedCountByStart = new Map<string, number>();
    for (const row of bookedRows ?? []) {
      const key = (row as { meeting_start: string }).meeting_start;
      bookedCountByStart.set(key, (bookedCountByStart.get(key) ?? 0) + 1);
    }

    return {
      meetingType,
      locationId: effectiveLocationId,
      date: input.date,
      slots: slotList.map((slot) => {
        const bookedCount = bookedCountByStart.get(slot.slot_start) ?? 0;
        const isOpen = bookedCount < slot.capacity;
        return {
          ...slot,
          bookedCount,
          status: isOpen ? "open" : "booked",
        };
      }),
    };
  }

  async listMeetingSlotsAdmin(filters: {
    meetingTypeId?: string;
    locationId?: string;
    from?: string;
    to?: string;
  }) {
    let query = supabaseAdmin
      .from("meeting_slots")
      .select("*, meeting_types(*), locations(*)")
      .order("slot_start", { ascending: true });

    if (filters.meetingTypeId) query = query.eq("meeting_type_id", filters.meetingTypeId);
    if (filters.locationId) query = query.eq("location_id", filters.locationId);
    if (filters.from) query = query.gte("slot_start", filters.from);
    if (filters.to) query = query.lte("slot_start", filters.to);

    const { data, error } = await query;
    if (error) throw new HttpError(500, "Failed to fetch meeting slots", error);
    return data ?? [];
  }

  async createMeetingSlot(input: {
    meetingTypeId: string;
    locationId: string;
    slotStart: string;
    slotEnd: string;
    capacity?: number;
    isActive?: boolean;
  }) {
    const { data, error } = await supabaseAdmin
      .from("meeting_slots")
      .insert({
        meeting_type_id: input.meetingTypeId,
        location_id: input.locationId,
        slot_start: input.slotStart,
        slot_end: input.slotEnd,
        capacity: input.capacity ?? 1,
        is_active: input.isActive ?? true,
      })
      .select()
      .single();
    if (error) throw new HttpError(500, "Failed to create meeting slot", error);
    return data;
  }

  async updateMeetingSlot(
    meetingSlotId: string,
    input: {
      meetingTypeId?: string;
      locationId?: string;
      slotStart?: string;
      slotEnd?: string;
      capacity?: number;
      isActive?: boolean;
    }
  ) {
    const updates: Record<string, unknown> = {};
    if (input.meetingTypeId !== undefined) updates.meeting_type_id = input.meetingTypeId;
    if (input.locationId !== undefined) updates.location_id = input.locationId;
    if (input.slotStart !== undefined) updates.slot_start = input.slotStart;
    if (input.slotEnd !== undefined) updates.slot_end = input.slotEnd;
    if (input.capacity !== undefined) updates.capacity = input.capacity;
    if (input.isActive !== undefined) updates.is_active = input.isActive;

    const { data, error } = await supabaseAdmin
      .from("meeting_slots")
      .update(updates)
      .eq("id", meetingSlotId)
      .select()
      .single();
    if (error) throw new HttpError(500, "Failed to update meeting slot", error);
    return data;
  }

  async deleteMeetingSlot(meetingSlotId: string) {
    const { error } = await supabaseAdmin.from("meeting_slots").delete().eq("id", meetingSlotId);
    if (error) throw new HttpError(500, "Failed to delete meeting slot", error);
    return { ok: true };
  }

  async getEligibility(memberId: string) {
    const { data, error } = await supabaseAdmin
      .from("track_meetings")
      .select("*")
      .eq("member_id", memberId)
      .order("meeting_start", { ascending: false });
    if (error) throw new HttpError(500, "Failed to fetch meetings", error);
    return {
      performance: { eligible: true, nextEligibleDate: null },
      pace: { eligible: true, nextEligibleDate: null },
      structure: { eligible: true, nextEligibleDate: null },
      history: data ?? [],
    };
  }

  async createMeeting(input: {
    memberId: string;
    meetingTypeId: string;
    locationId?: string;
    meetingStart: string;
  }) {
    const { data: profile, error: profileError } = await supabaseAdmin
      .from("profiles")
      .select("location_id")
      .eq("id", input.memberId)
      .maybeSingle();
    if (profileError) throw new HttpError(500, "Failed to fetch profile", profileError);

    const effectiveLocationId = input.locationId ?? profile?.location_id ?? null;
    if (!effectiveLocationId) {
      throw new HttpError(400, "locationId is required when member profile has no location");
    }

    const { data: meetingType, error: typeError } = await supabaseAdmin
      .from("meeting_types")
      .select("id, duration_mins")
      .eq("id", input.meetingTypeId)
      .eq("is_active", true)
      .maybeSingle();
    if (typeError) throw new HttpError(500, "Failed to fetch meeting type", typeError);
    if (!meetingType) throw new HttpError(404, "Meeting type not found");

    const meetingStartDate = new Date(input.meetingStart);
    if (Number.isNaN(meetingStartDate.getTime())) throw new HttpError(400, "Invalid meetingStart");
    const meetingEndDate = new Date(
      meetingStartDate.getTime() + (meetingType.duration_mins as number) * 60 * 1000
    );

    const { data: slot, error: slotError } = await supabaseAdmin
      .from("meeting_slots")
      .select("id, capacity")
      .eq("meeting_type_id", input.meetingTypeId)
      .eq("location_id", effectiveLocationId)
      .eq("slot_start", meetingStartDate.toISOString())
      .eq("is_active", true)
      .maybeSingle();
    if (slotError) throw new HttpError(500, "Failed to validate meeting slot", slotError);
    if (!slot) throw new HttpError(422, "Selected slot is not available");

    const { count, error: countError } = await supabaseAdmin
      .from("track_meetings")
      .select("*", { count: "exact", head: true })
      .eq("meeting_type_id", input.meetingTypeId)
      .eq("location_id", effectiveLocationId)
      .eq("meeting_start", meetingStartDate.toISOString())
      .eq("status", "booked");
    if (countError) throw new HttpError(500, "Failed to validate meeting capacity", countError);
    if ((count ?? 0) >= (slot.capacity as number)) throw new HttpError(422, "Meeting slot is full");

    const { data, error } = await supabaseAdmin
      .from("track_meetings")
      .insert({
        member_id: input.memberId,
        meeting_type_id: input.meetingTypeId,
        location_id: effectiveLocationId,
        meeting_start: meetingStartDate.toISOString(),
        meeting_end: meetingEndDate.toISOString(),
        status: "booked",
      })
      .select()
      .single();
    if (error) throw new HttpError(500, "Failed to create meeting", error);
    return data;
  }
}
