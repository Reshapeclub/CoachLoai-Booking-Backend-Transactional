import { z } from "zod";
export const createSessionTypeSchema = z.object({ name: z.string().min(1), defaultCapacity: z.number().int().min(1), defaultDurationMins: z.union([z.literal(30), z.literal(45), z.literal(60)]) });
export const updateSessionTypeSchema = z.object({
  name: z.string().min(1).optional(),
  defaultCapacity: z.number().int().min(1).optional(),
  defaultDurationMins: z.union([z.literal(30), z.literal(45), z.literal(60)]).optional(),
}).refine((v) => Object.keys(v).length > 0, { message: "At least one field must be provided" });
export const createSessionSchema = z.object({
  sessionTypeId: z.string().min(1),
  coachId: z.string().min(1),
  locationId: z.string().nullable().optional(),
  start: z.string().datetime(),
  durationMins: z.union([z.literal(30), z.literal(45), z.literal(60)]).optional(),
  capacity: z.number().int().min(1).optional(),
  allowOvertime: z.boolean().optional(),
});
export const setCapacitySchema = z.object({ capacity: z.number().int().min(1) });
export const setCoachSchema = z.object({
  newCoachId: z.string().min(1),
  allowOvertime: z.boolean().optional(),
});
export const setSessionTypeSchema = z.object({ newSessionTypeId: z.string().min(1) });
export const refundModeSchema = z.object({ refund: z.enum(["refund","charge"]) });
export const createMembershipSchema = z.object({
  memberId: z.string().min(1),
  mode: z.enum(["inperson", "remote"]),
  currentPackage: z.enum(["structure", "pace", "performance"]).optional(),
  startDate: z.string().datetime(),
  endDate: z.string().datetime(),
});
export const updateMembershipSchema = z
  .object({
    mode: z.enum(["inperson", "remote"]).optional(),
    currentPackage: z.enum(["structure", "pace", "performance"]).optional(),
    isPaused: z.boolean().optional(),
    status: z.enum(["active", "paused", "ended", "terminated"]).optional(),
    startDate: z.string().datetime().optional(),
    endDate: z.string().datetime().nullable().optional(),
    terminationDate: z.string().datetime().nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: "At least one field must be provided" });
export const pauseMembershipSchema = z.object({
  startWeek: z.string().datetime(),
  endWeekInclusive: z.string().datetime(),
});
export const terminateMembershipSchema = z.object({
  terminationDate: z.string().datetime(),
});
export const issueTokensSchema = z.object({ memberId: z.string().min(1), tokenTypeId: z.string().min(1), quantity: z.number().int().min(1), expiry: z.string().datetime().optional() });
export const addMemberSessionTagSchema = z.object({
  memberId: z.string().uuid(),
  sessionTypeId: z.string().uuid(),
});
export const addSessionAllowanceSchema = z.object({
  tokenTypeId: z.string().uuid(),
  weeklyAllowance: z.number().int().min(0),
});
export const addAllowedSessionTypeSchema = z.object({
  membershipId: z.string().uuid(),
  sessionTypeId: z.string().uuid(),
});

// Coach schemas
export const createCoachSchema = z.object({
  userId: z.string().uuid(),
  weeklyHourLimitMins: z.number().int().min(0).max(10080).optional(),
  travelBufferMinutes: z.number().int().min(0).max(480).optional(),
});
export const updateCoachSchema = z.object({
  weeklyHourLimitMins: z.number().int().min(0).max(10080).optional(),
  travelBufferMinutes: z.number().int().min(0).max(480).optional(),
}).refine((v) => Object.keys(v).length > 0, { message: "At least one field must be provided" });
export const addCoachAvailabilitySchema = z.object({
  dayOfWeek: z.number().int().min(1).max(7),
  startMins: z.number().int().min(0).max(1439),
  endMins: z.number().int().min(1).max(1440),
}).refine((v) => v.endMins > v.startMins, { message: "endMins must be after startMins" });
export const addCoachHolidaySchema = z.object({
  startAt: z.string().datetime(),
  endAt: z.string().datetime(),
}).refine((v) => new Date(v.endAt) > new Date(v.startAt), { message: "endAt must be after startAt" });
export const addCoachSessionTypeSchema = z.object({
  coachUserId: z.string().uuid(),
  sessionTypeId: z.string().uuid(),
});

export const adminBookingsListQuerySchema = z.object({
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  memberId: z.string().uuid().optional(),
  sessionId: z.string().uuid().optional(),
  status: z.enum(["booked", "cancelled", "no_show"]).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});

export const createMeetingTypeSchema = z.object({
  name: z.string().min(1),
  code: z.string().min(1),
  durationMins: z.number().int().min(1),
  description: z.string().optional(),
  color: z.string().optional(),
  icon: z.string().optional(),
  displayOrder: z.number().int().min(0).optional(),
  isActive: z.boolean().optional(),
});

export const updateMeetingTypeSchema = z
  .object({
    name: z.string().min(1).optional(),
    code: z.string().min(1).optional(),
    durationMins: z.number().int().min(1).optional(),
    description: z.string().nullable().optional(),
    color: z.string().nullable().optional(),
    icon: z.string().nullable().optional(),
    displayOrder: z.number().int().min(0).optional(),
    isActive: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: "At least one field must be provided" });

export const adminMeetingSlotsQuerySchema = z.object({
  meetingTypeId: z.string().uuid().optional(),
  locationId: z.string().uuid().optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
});

export const createMeetingSlotSchema = z
  .object({
    meetingTypeId: z.string().uuid(),
    locationId: z.string().uuid(),
    slotStart: z.string().datetime(),
    slotEnd: z.string().datetime(),
    capacity: z.number().int().min(1).optional(),
    isActive: z.boolean().optional(),
  })
  .refine((v) => new Date(v.slotEnd) > new Date(v.slotStart), { message: "slotEnd must be after slotStart" });

export const updateMeetingSlotSchema = z
  .object({
    meetingTypeId: z.string().uuid().optional(),
    locationId: z.string().uuid().optional(),
    slotStart: z.string().datetime().optional(),
    slotEnd: z.string().datetime().optional(),
    capacity: z.number().int().min(1).optional(),
    isActive: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: "At least one field must be provided" })
  .refine(
    (v) => !v.slotStart || !v.slotEnd || new Date(v.slotEnd) > new Date(v.slotStart),
    { message: "slotEnd must be after slotStart" }
  );
