import { DateTime } from "luxon";
import { supabaseAdmin } from "../db/supabase.js";
import { HttpError } from "../lib/http-error.js";
import {
  assertBookableStartNotPast,
  isStartInPast,
  maxIso,
  ukBookingNowIso,
  ukDayBoundsUtcIso,
} from "../lib/uk-booking-time.js";

function toLondonRotaParts(iso: string): { dayOfWeek: number; minutesFromMidnight: number; weekStartDate: string } {
  const dt = DateTime.fromISO(iso, { zone: "utc" }).setZone("Europe/London");
  if (!dt.isValid) throw new HttpError(400, `Invalid datetime: ${iso}`);
  const dayOfWeek = dt.weekday; // luxon: 1=Mon..7=Sun
  const minutesFromMidnight = dt.hour * 60 + dt.minute;
  const weekStartDate = dt.startOf("week").toISODate();
  if (!weekStartDate) throw new HttpError(400, `Could not derive week start for: ${iso}`);
  return { dayOfWeek, minutesFromMidnight, weekStartDate };
}

type CoachDayAvailabilityRow = {
  start_mins: number;
  end_mins: number;
  location_id: string | null;
};

function minsToHHMM(mins: number): string {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/** Gap in minutes between non-overlapping blocks on the same day; -1 if they overlap. */
function sameDayTravelGapMinutes(
  aStart: number,
  aEnd: number,
  bStart: number,
  bEnd: number,
): number {
  if (aEnd <= bStart) return bStart - aEnd;
  if (bEnd <= aStart) return aStart - bEnd;
  return -1;
}

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

  async deleteMeetingType(meetingTypeId: string) {
    const { error } = await supabaseAdmin.from("meeting_types").delete().eq("id", meetingTypeId);
    if (error) {
      if ((error as { code?: string }).code === "23503") {
        throw new HttpError(409, "Cannot delete meeting type while slots or meetings still reference it", error);
      }
      throw new HttpError(500, "Failed to delete meeting type", error);
    }
    return { ok: true };
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

    const dayBounds = ukDayBoundsUtcIso(input.date);
    if (!dayBounds) throw new HttpError(400, "Invalid date, expected YYYY-MM-DD");
    const nowIso = ukBookingNowIso();
    const queryFrom = maxIso(dayBounds.from, nowIso);

    const { data: slots, error: slotError } = await supabaseAdmin
      .from("meeting_slots")
      .select("*")
      .eq("meeting_type_id", input.meetingTypeId)
      .eq("location_id", effectiveLocationId)
      .eq("is_active", true)
      .gte("slot_start", queryFrom)
      .lt("slot_start", dayBounds.to)
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
      slots: slotList
        .filter((slot) => !isStartInPast(String(slot.slot_start), nowIso))
        .map((slot) => {
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
      .select("*, meeting_types(*), locations(*), coaches!meeting_slots_coach_id_fkey(id, admins(name, id))")
      .order("slot_start", { ascending: true });

    if (filters.meetingTypeId) query = query.eq("meeting_type_id", filters.meetingTypeId);
    if (filters.locationId) query = query.eq("location_id", filters.locationId);
    if (filters.from) query = query.gte("slot_start", filters.from);
    if (filters.to) query = query.lte("slot_start", filters.to);

    const { data: slots, error: slotsError } = await query;
    if (slotsError) throw new HttpError(500, "Failed to fetch meeting slots", slotsError);

    if (!slots || slots.length === 0) return [];

    // Fetch all bookings for these slots to calculate counts
    const { data: bookings, error: bookingsError } = await supabaseAdmin
      .from("track_meetings")
      .select("meeting_type_id, location_id, meeting_start")
      .gte("meeting_start", filters.from || slots[0].slot_start)
      .lte("meeting_start", filters.to || slots[slots.length - 1].slot_start)
      .eq("status", "booked");

    if (bookingsError) throw new HttpError(500, "Failed to fetch bookings for counts", bookingsError);

    // Merge counts into slots
    const slotsWithCounts = slots.map(s => {
      const bookedCount = bookings.filter(b => 
        b.meeting_type_id === s.meeting_type_id &&
        b.location_id === s.location_id &&
        new Date(b.meeting_start).getTime() === new Date(s.slot_start).getTime()
      ).length;
      return { ...s, booked_count: bookedCount };
    });

    return slotsWithCounts;
  }

  async createMeetingSlot(input: {
    meetingTypeId: string;
    locationId: string;
    coachId?: string | null;
    slotStart: string;
    slotEnd: string;
    capacity?: number;
    isActive?: boolean;
  }) {
    if (input.coachId) {
      await this.assertCoachMeetingSlotConstraints(
        input.coachId,
        input.locationId,
        input.slotStart,
        input.slotEnd,
      );
    }
    const { data, error } = await supabaseAdmin
      .from("meeting_slots")
      .insert({
        meeting_type_id: input.meetingTypeId,
        location_id: input.locationId,
        coach_id: input.coachId ?? null,
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

  private async assertCoachMeetingSlotConstraints(
    coachId: string,
    locationId: string,
    slotStart: string,
    slotEnd: string,
    excludeMeetingSlotId?: string,
  ) {
    await this.assertSlotInCoachMeetingWindows(coachId, slotStart, slotEnd);
    await this.assertSlotDoesNotOverlapSessionRota(coachId, slotStart, slotEnd);
    await this.assertSlotDoesNotOverlapBookedSessions(coachId, slotStart, slotEnd);
    await this.assertMeetingSlotTravelBuffer(coachId, locationId, slotStart, slotEnd, excludeMeetingSlotId);
  }

  private async fetchCoachTravelBufferMinutes(coachId: string): Promise<number> {
    const { data: coachRow, error } = await supabaseAdmin
      .from("coaches")
      .select("travel_buffer_minutes")
      .eq("id", coachId)
      .single();
    if (error || !coachRow) return 30;
    return Math.max(
      0,
      Math.floor(Number((coachRow as { travel_buffer_minutes?: number | null }).travel_buffer_minutes ?? 30)),
    );
  }

  private async fetchCoachDayAvailabilityMins(
    coachId: string,
    kind: "session" | "meeting",
    dayOfWeek: number,
    weekStartDate: string,
  ): Promise<Array<{ start_mins: number; end_mins: number }>> {
    const rows = await this.fetchCoachDayAvailabilityWithLocation(coachId, kind, dayOfWeek, weekStartDate);
    return rows.map((r) => ({ start_mins: r.start_mins, end_mins: r.end_mins }));
  }

  private async fetchCoachDayAvailabilityWithLocation(
    coachId: string,
    kind: "session" | "meeting",
    dayOfWeek: number,
    weekStartDate: string,
  ): Promise<CoachDayAvailabilityRow[]> {
    const { data: weekRows, error: weekErr } = await supabaseAdmin
      .from("coach_availability")
      .select("start_mins, end_mins, location_id")
      .eq("coach_id", coachId)
      .eq("kind", kind)
      .eq("day_of_week", dayOfWeek)
      .eq("week_start_date", weekStartDate);
    if (weekErr) throw new HttpError(500, "Failed to fetch coach availability", weekErr);
    if ((weekRows ?? []).length > 0) return (weekRows ?? []) as CoachDayAvailabilityRow[];

    const { data: defaultRows, error: defaultErr } = await supabaseAdmin
      .from("coach_availability")
      .select("start_mins, end_mins, location_id")
      .eq("coach_id", coachId)
      .eq("kind", kind)
      .eq("day_of_week", dayOfWeek)
      .is("week_start_date", null);
    if (defaultErr) throw new HttpError(500, "Failed to fetch coach availability", defaultErr);
    return (defaultRows ?? []) as CoachDayAvailabilityRow[];
  }

  private assertSameDayTravelGapOrThrow(
    buffer: number,
    newLoc: string,
    newStart: number,
    newEnd: number,
    otherStart: number,
    otherEnd: number,
    otherLoc: string | null,
    context: string,
  ): void {
    const other = otherLoc ? String(otherLoc).trim() : "";
    if (!other || other === newLoc) return;
    const gap = sameDayTravelGapMinutes(newStart, newEnd, otherStart, otherEnd);
    if (gap >= 0 && gap < buffer) {
      throw new HttpError(
        400,
        `Allow at least ${buffer} minutes travel time between commitments at different locations on the same day (${context}: ${minsToHHMM(otherStart)}-${minsToHHMM(otherEnd)} then ${minsToHHMM(newStart)}-${minsToHHMM(newEnd)}).`,
      );
    }
  }

  private async assertMeetingSlotTravelBuffer(
    coachId: string,
    locationId: string,
    slotStart: string,
    slotEnd: string,
    excludeMeetingSlotId?: string,
  ): Promise<void> {
    const startParts = toLondonRotaParts(slotStart);
    const endParts = toLondonRotaParts(slotEnd);
    if (endParts.dayOfWeek !== startParts.dayOfWeek) return;

    const newLoc = String(locationId).trim();
    if (!newLoc) return;

    const buffer = await this.fetchCoachTravelBufferMinutes(coachId);
    if (buffer <= 0) return;

    const S = startParts.minutesFromMidnight;
    const E = endParts.minutesFromMidnight;
    const dayOfWeek = startParts.dayOfWeek;
    const weekStartDate = startParts.weekStartDate;

    const londonYmd = DateTime.fromISO(slotStart, { zone: "utc" })
      .setZone("Europe/London")
      .toISODate();
    if (!londonYmd) return;
    const dayBounds = ukDayBoundsUtcIso(londonYmd);
    if (!dayBounds) return;

    const checkRota = (rows: CoachDayAvailabilityRow[], label: string) => {
      for (const r of rows) {
        this.assertSameDayTravelGapOrThrow(
          buffer,
          newLoc,
          S,
          E,
          Number(r.start_mins),
          Number(r.end_mins),
          r.location_id,
          label,
        );
      }
    };

    checkRota(
      await this.fetchCoachDayAvailabilityWithLocation(coachId, "session", dayOfWeek, weekStartDate),
      "session rota",
    );
    checkRota(
      await this.fetchCoachDayAvailabilityWithLocation(coachId, "meeting", dayOfWeek, weekStartDate),
      "meeting rota",
    );

    const { data: otherSlots, error: slotsErr } = await supabaseAdmin
      .from("meeting_slots")
      .select("id, slot_start, slot_end, location_id")
      .eq("coach_id", coachId)
      .lt("slot_start", dayBounds.to)
      .gt("slot_end", dayBounds.from);
    if (slotsErr) throw new HttpError(500, "Failed to check meeting slot travel buffer", slotsErr);

    for (const slot of otherSlots ?? []) {
      if (excludeMeetingSlotId && slot.id === excludeMeetingSlotId) continue;
      const parts = toLondonRotaParts(slot.slot_start as string);
      const endSlot = toLondonRotaParts(slot.slot_end as string);
      if (parts.dayOfWeek !== dayOfWeek || endSlot.dayOfWeek !== dayOfWeek) continue;
      this.assertSameDayTravelGapOrThrow(
        buffer,
        newLoc,
        S,
        E,
        parts.minutesFromMidnight,
        endSlot.minutesFromMidnight,
        slot.location_id as string | null,
        "meeting slot",
      );
    }

    const { data: sessions, error: sessErr } = await supabaseAdmin
      .from("sessions")
      .select("start_at, end_at, location_id")
      .eq("coach_id", coachId)
      .eq("is_cancelled", false)
      .is("deleted_at", null)
      .lt("start_at", dayBounds.to)
      .gt("end_at", dayBounds.from);
    if (sessErr) throw new HttpError(500, "Failed to check session travel buffer", sessErr);

    for (const sess of sessions ?? []) {
      const parts = toLondonRotaParts(sess.start_at as string);
      const endSess = toLondonRotaParts(sess.end_at as string);
      if (parts.dayOfWeek !== dayOfWeek || endSess.dayOfWeek !== dayOfWeek) continue;
      this.assertSameDayTravelGapOrThrow(
        buffer,
        newLoc,
        S,
        E,
        parts.minutesFromMidnight,
        endSess.minutesFromMidnight,
        sess.location_id as string | null,
        "booked session",
      );
    }
  }

  private async assertSlotInCoachMeetingWindows(coachId: string, slotStart: string, slotEnd: string) {
    const startParts = toLondonRotaParts(slotStart);
    const endParts = toLondonRotaParts(slotEnd);
    if (endParts.dayOfWeek !== startParts.dayOfWeek) {
      throw new HttpError(400, "Meeting slot must start and end on the same day");
    }
    if (endParts.minutesFromMidnight <= startParts.minutesFromMidnight) {
      throw new HttpError(400, "Meeting slot end must be after start");
    }

    const dayOfWeek = startParts.dayOfWeek;
    const weekStartDate = startParts.weekStartDate;
    const availRows = await this.fetchCoachDayAvailabilityMins(coachId, "meeting", dayOfWeek, weekStartDate);

    if (availRows.length === 0) {
      throw new HttpError(
        400,
        "Coach has no meeting availability windows for this day. Configure the meeting rota first.",
      );
    }
    const inWindow = availRows.some(
      (r) =>
        startParts.minutesFromMidnight >= Number(r.start_mins) &&
        endParts.minutesFromMidnight <= Number(r.end_mins),
    );
    if (!inWindow) {
      throw new HttpError(400, "Meeting slot is outside the coach's meeting availability windows");
    }
  }

  private async assertSlotDoesNotOverlapSessionRota(coachId: string, slotStart: string, slotEnd: string) {
    const startParts = toLondonRotaParts(slotStart);
    const endParts = toLondonRotaParts(slotEnd);
    const S = startParts.minutesFromMidnight;
    const E = endParts.minutesFromMidnight;
    const sessionRows = await this.fetchCoachDayAvailabilityMins(
      coachId,
      "session",
      startParts.dayOfWeek,
      startParts.weekStartDate,
    );
    for (const r of sessionRows) {
      const s = Number(r.start_mins);
      const e = Number(r.end_mins);
      if (S < e && s < E) {
        throw new HttpError(
          400,
          "Meeting slot overlaps this coach's session availability. Choose a time outside session rota or adjust rota first.",
        );
      }
    }
  }

  private async assertSlotDoesNotOverlapBookedSessions(coachId: string, slotStart: string, slotEnd: string) {
    const { data, error } = await supabaseAdmin
      .from("sessions")
      .select("id")
      .eq("coach_id", coachId)
      .eq("is_cancelled", false)
      .is("deleted_at", null)
      .lt("start_at", slotEnd)
      .gt("end_at", slotStart)
      .limit(1);
    if (error) throw new HttpError(500, "Failed to check session conflicts", error);
    if ((data ?? []).length > 0) {
      throw new HttpError(400, "Meeting slot overlaps an existing session for this coach");
    }
  }

  async updateMeetingSlot(
    meetingSlotId: string,
    input: {
      meetingTypeId?: string;
      locationId?: string;
      coachId?: string | null;
      slotStart?: string;
      slotEnd?: string;
      capacity?: number;
      isActive?: boolean;
    }
  ) {
    if (
      input.coachId !== undefined ||
      input.locationId !== undefined ||
      input.slotStart !== undefined ||
      input.slotEnd !== undefined
    ) {
      const { data: existing, error: fetchErr } = await supabaseAdmin
        .from("meeting_slots")
        .select("coach_id, location_id, slot_start, slot_end")
        .eq("id", meetingSlotId)
        .single();
      if (fetchErr || !existing) throw new HttpError(404, "Meeting slot not found");
      const nextCoachId = input.coachId !== undefined ? input.coachId : existing.coach_id;
      const nextLocationId = input.locationId ?? existing.location_id;
      const nextStart = input.slotStart ?? existing.slot_start;
      const nextEnd = input.slotEnd ?? existing.slot_end;
      if (nextCoachId) {
        await this.assertCoachMeetingSlotConstraints(
          nextCoachId,
          nextLocationId,
          nextStart,
          nextEnd,
          meetingSlotId,
        );
      }
    }

    const updates: Record<string, unknown> = {};
    if (input.meetingTypeId !== undefined) updates.meeting_type_id = input.meetingTypeId;
    if (input.locationId !== undefined) updates.location_id = input.locationId;
    if (input.coachId !== undefined) updates.coach_id = input.coachId;
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

  async listMeetingsForSlot(filters: {
    meetingTypeId: string;
    locationId: string;
    meetingStart: string;
  }) {
    const { data, error } = await supabaseAdmin
      .from("track_meetings")
      .select("*, profiles(*)")
      .eq("meeting_type_id", filters.meetingTypeId)
      .eq("location_id", filters.locationId)
      .eq("meeting_start", filters.meetingStart)
      .eq("status", "booked");
    if (error) throw new HttpError(500, "Failed to fetch slot meetings", error);
    return data ?? [];
  }

  async getEligibility(memberId: string) {
    const { data, error } = await supabaseAdmin
      .from("track_meetings")
      .select("*, meeting_types(*), locations(*)")
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
      .select("id, duration_mins, name")
      .eq("id", input.meetingTypeId)
      .eq("is_active", true)
      .maybeSingle();
    if (typeError) throw new HttpError(500, "Failed to fetch meeting type", typeError);
    if (!meetingType) throw new HttpError(404, "Meeting type not found");


    const meetingStartDate = new Date(input.meetingStart);
    if (Number.isNaN(meetingStartDate.getTime())) throw new HttpError(400, "Invalid meetingStart");
    assertBookableStartNotPast(meetingStartDate.toISOString());
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
    if (!slot) throw new HttpError(422, "Selected slot is not available or already booked");

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

    const { data: locationRow } = await supabaseAdmin
      .from("locations")
      .select("name")
      .eq("id", effectiveLocationId)
      .maybeSingle();

    const notificationPayload = {
      meetingId: data.id,
      meetingTypeId: input.meetingTypeId,
      meetingTypeName: (meetingType.name as string) ?? "Meeting",
      locationId: effectiveLocationId,
      locationName: (locationRow?.name as string) ?? "",
      meetingStart: meetingStartDate.toISOString(),
      meetingEnd: meetingEndDate.toISOString(),
    };

    const { error: notifyError } = await supabaseAdmin.from("notifications").insert([
      {
        member_id: input.memberId,
        channel: "in_app",
        type: "meeting_confirmed",
        payload: notificationPayload,
      },
      {
        member_id: input.memberId,
        channel: "email",
        type: "meeting_confirmed",
        payload: notificationPayload,
      },
    ]);
    if (notifyError) {
      console.error("[meeting-service] Failed to queue meeting confirmation notifications:", notifyError);
    }

    await supabaseAdmin.from("audit_logs").insert({
      actor_type: "member",
      actor_id: input.memberId,
      action: "meeting.create",
      meta: {
        meetingId: data.id,
        meetingTypeId: input.meetingTypeId,
        locationId: effectiveLocationId,
        meetingStart: meetingStartDate.toISOString(),
      },
    });

    return data;
  }
}
