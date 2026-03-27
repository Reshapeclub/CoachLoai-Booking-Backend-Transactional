import { z } from "zod";
export const createBookingSchema = z.object({ membershipId: z.string().min(1), sessionId: z.string().min(1) });
export const joinWaitlistSchema = z.object({ membershipId: z.string().min(1), sessionId: z.string().min(1) });
export const purchaseTokensCheckoutSchema = z.object({ membershipId: z.string().min(1), tokenTypeId: z.string().min(1), quantity: z.number().int().min(1).max(12) });
export const createMeetingSchema = z.object({
  meetingTypeId: z.string().uuid(),
  locationId: z.string().uuid().optional(),
  meetingStart: z.string().datetime(),
});
