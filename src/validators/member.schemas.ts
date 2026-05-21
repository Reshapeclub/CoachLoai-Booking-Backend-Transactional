import { z } from "zod";
export const createBookingSchema = z.object({ membershipId: z.string().min(1), sessionId: z.string().min(1) });
export const rebookBookingSchema = z.object({ membershipId: z.string().min(1).optional() });
export const joinWaitlistSchema = z.object({ membershipId: z.string().min(1), sessionId: z.string().min(1) });
export const purchaseTokensCheckoutSchema = z.object({ membershipId: z.string().min(1), tokenTypeId: z.string().min(1), quantity: z.number().int().min(1).max(12) });
export const createMeetingSchema = z.object({
  meetingTypeId: z.string().uuid(),
  locationId: z.string().uuid().optional(),
  meetingStart: z.string().datetime(),
});

export const memberMeetingsQuerySchema = z.object({
  status: z.enum(["booked", "cancelled", "no_show", "all"]).optional(),
  view: z.enum(["upcoming", "past", "all"]).optional(),
  from: z.string().optional(),
  to: z.string().optional(),
});
