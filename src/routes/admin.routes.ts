import express, { Router } from "express";
import type { NextFunction, Request, Response } from "express";
import { z } from "zod";
import { requireAdminAuth } from "../middleware/auth.js";
import { requireAdminTableAccess } from "../middleware/roles.js";
import { validate } from "../utils/validate.js";
import {
  createSessionTypeSchema,
  updateSessionTypeSchema,
  createSessionSchema,
  updateSessionSchema,
  setCapacitySchema,
  setCoachSchema,
  setSessionTypeSchema,
  refundModeSchema,
  bulkDeleteFutureSessionsSchema,
  createMembershipSchema,
  updateMembershipSchema,
  pauseMembershipSchema,
  pauseAdminMemberMembershipSchema,
  cancelPauseMembershipSchema,
  cancelAdminMemberMembershipPauseSchema,
  resumeAdminMemberMembershipPauseSchema,
  queueMembershipPlanSchema,
  cancelMembershipPlanSchema,
  terminateMembershipSchema,
  issueTokensSchema,
  addMemberSessionTagSchema,
  addSessionAllowanceSchema,
  addAllowedSessionTypeSchema,
  putMemberDashboardMembershipAccessSchema,
  patchMemberDashboardMembershipSchema,
  createAdminMemberGiftSessionSchema,
  patchAdminMemberGiftSessionSchema,
  consumeAdminMemberGiftSessionSchema,
  createCoachSchema,
  updateCoachSchema,
  addCoachAvailabilitySchema,
  replaceCoachAvailabilitySchema,
  coachAvailabilityQuerySchema,
  addCoachHolidaySchema,
  addCoachSessionTypeSchema,
  adminBookingsListQuerySchema,
  adminWaitlistEntriesQuerySchema,
  adminMoveBookingSchema,
  createMeetingTypeSchema,
  updateMeetingTypeSchema,
  adminMeetingSlotsQuerySchema,
  createMeetingSlotSchema,
  updateMeetingSlotSchema,
  updateSessionTypesByCategorySchema,
  createLocationSchema,
  updateLocationSchema,
} from "../validators/admin.schemas.js";
import { memberMeetingsQuerySchema } from "../validators/member.schemas.js";
import { SessionService } from "../services/session-service.js";
import { CoachService } from "../services/coach-service.js";
import { MembershipService } from "../services/membership-service.js";
import { TokenService } from "../services/token-service.js";
import { BookingService } from "../services/booking-service.js";
import { MeetingService } from "../services/meeting-service.js";
import { validateCoachForSession } from "../services/coach-roster-validator.js";
import { supabaseAdmin } from "../db/supabase.js";
import { HttpError } from "../lib/http-error.js";
import { runWeeklyTokenGeneration } from "../jobs/weekly-token-generation.js";
import { provisionStaffAuthAccount, rollbackStaffAuthAccount } from "../services/staff-provisioning.js";
import { sendStaffWelcomeEmail } from "../services/staff-welcome-email.js";

const router = Router();
const sessionService = new SessionService();
const coachService = new CoachService();
const membershipService = new MembershipService();
const tokenService = new TokenService();
const bookingService = new BookingService();
const meetingService = new MeetingService();

router.use(requireAdminAuth, requireAdminTableAccess());
// Admin session types routes
router.get('/session-types', async (req, res, next) => {
  try {
    const grouped =
      req.query.grouped === "1" ||
      req.query.grouped === "true" ||
      req.query.grouped === "yes";
    const data = grouped
      ? await sessionService.listSessionTypesGrouped()
      : await sessionService.listSessionTypes();
    res.json({ ok: true, data });
  } catch (e) {
    next(e);
  }
});
router.get('/session-types/category/:category', async (req, res, next) => {
  try {
    const category = validate(z.object({ category: z.enum(["1:1", "Elite", "Octave", "Group"]) }), req.params).category;
    res.json({ ok: true, data: await sessionService.listSessionTypesByCategory(category) });
  } catch (e) {
    next(e);
  }
});
router.post('/session-types', async (req, res, next) => { try { const body = validate(createSessionTypeSchema, req.body); res.json({ ok: true, data: await sessionService.createSessionType(body) }); } catch (e) { next(e); } });
// More specific path first so "category" is never captured as :sessionTypeId.
router.patch('/session-types/category/:category', async (req, res, next) => {
  try {
    const category = validate(z.object({ category: z.enum(["1:1", "Elite", "Octave", "Group"]) }), req.params).category;
    const body = validate(updateSessionTypesByCategorySchema, req.body);
    res.json({ ok: true, data: await sessionService.updateSessionTypesByCategory(category, body) });
  } catch (e) {
    next(e);
  }
});
router.patch('/session-types/:sessionTypeId', async (req, res, next) => { try { const body = validate(updateSessionTypeSchema, req.body); res.json({ ok: true, data: await sessionService.updateSessionType(req.params.sessionTypeId, body) }); } catch (e) { next(e); } });
// Admin session routes
router.get('/waitlist-entries', async (req, res, next) => {
  try {
    const q = validate(adminWaitlistEntriesQuerySchema, req.query);
    res.json({ ok: true, data: await bookingService.listAdminWaitlistEntries({ from: q.from, to: q.to }) });
  } catch (e) {
    next(e);
  }
});
router.get('/sessions', async (req, res, next) => { try { const from = typeof req.query.from === 'string' ? req.query.from : undefined; const to = typeof req.query.to === 'string' ? req.query.to : undefined; const includeDeleted = req.query.include_deleted === 'true' || req.query.include_deleted === '1'; res.json({ ok: true, data: await sessionService.listSessions(from, to, { includeDeleted }) }); } catch (e) { next(e); } });
router.post("/sessions/bulk-delete-future", async (req, res, next) => {
  try {
    const body = validate(bulkDeleteFutureSessionsSchema, req.body);
    res.json({ ok: true, data: await sessionService.adminBulkDeleteFutureSessions(body) });
  } catch (e) {
    next(e);
  }
});
router.get('/sessions/:sessionId/members', async (req, res, next) => { try { res.json({ ok: true, data: await sessionService.getSessionMembers(req.params.sessionId) }); } catch (e) { next(e); } });
router.get('/sessions/:sessionId/waitlist', async (req, res, next) => { try { res.json({ ok: true, data: await bookingService.getSessionWaitlist(req.params.sessionId) }); } catch (e) { next(e); } });
router.post('/sessions', async (req, res, next) => { try { const body = validate(createSessionSchema, req.body); const { data: st, error } = await supabaseAdmin.from('session_types').select('*').eq('id', body.sessionTypeId).single(); if (error || !st) throw new HttpError(404, 'Session type not found'); const start = new Date(body.start); const end = new Date(start.getTime() + (body.durationMins ?? st.default_duration_mins) * 60 * 1000); const trainingLevel = body.trainingLevel; res.json({ ok: true, data: await sessionService.createSession({ sessionTypeId: body.sessionTypeId, tokenTypeId: body.tokenTypeId ?? st.token_type_id, coachId: body.coachId, locationId: body.locationId ?? null, isOnline: body.isOnline ?? false, startAt: start.toISOString(), endAt: end.toISOString(), capacity: body.capacity ?? st.default_capacity, allowOvertime: body.allowOvertime, trainingLevel }) }); } catch (e) { next(e); } });
router.patch('/sessions/:sessionId', async (req, res, next) => { try { const body = validate(updateSessionSchema, req.body); const trainingLevel = body.trainingLevel; res.json({ ok: true, data: await sessionService.updateSession(req.params.sessionId, { ...body, trainingLevel }) }); } catch (e) { next(e); } });
router.patch('/sessions/:sessionId/capacity', async (req, res, next) => { try { const body = validate(setCapacitySchema, req.body); res.json({ ok: true, data: await sessionService.setCapacity(req.params.sessionId, body.capacity) }); } catch (e) { next(e); } });
router.patch('/sessions/:sessionId/coach', async (req, res, next) => { try { const body = validate(setCoachSchema, req.body); res.json({ ok: true, data: await sessionService.setCoach(req.params.sessionId, body.newCoachId, { allowOvertime: body.allowOvertime, ignoreSessionIds: body.ignoreSessionIds }) }); } catch (e) { next(e); } });
router.patch('/sessions/:sessionId/type', async (req, res, next) => { try { const body = validate(setSessionTypeSchema, req.body); const { data: st, error } = await supabaseAdmin.from('session_types').select('*').eq('id', body.newSessionTypeId).single(); if (error || !st) throw new HttpError(404, 'Session type not found'); res.json({ ok: true, data: await sessionService.setSessionType(req.params.sessionId, body.newSessionTypeId, st.token_type_id) }); } catch (e) { next(e); } });
router.post('/sessions/:sessionId/cancel', async (req, res, next) => {
  try {
    const body = validate(refundModeSchema, req.body);
    const { data: session, error: sessionErr } = await supabaseAdmin
      .from("sessions")
      .select("coach_id")
      .eq("id", req.params.sessionId)
      .is("deleted_at", null)
      .single();
    if (sessionErr || !session) throw new HttpError(404, "Session not found");
    if (!session.coach_id) throw new HttpError(422, "Session has no assigned coach");
    res.json(
      await bookingService.adminCancelSession({
        sessionId: req.params.sessionId,
        refund: body.refund,
        adminId: session.coach_id,
      }),
    );
  } catch (e) { next(e); }
});
router.delete("/sessions/:sessionId", async (req, res, next) => {
  try {
    const { sessionId } = validate(z.object({ sessionId: z.string().uuid() }), req.params);
    await sessionService.adminDeleteSession(sessionId);
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});
router.post("/sessions/:sessionId/restore", async (req, res, next) => {
  try {
    const { sessionId } = validate(z.object({ sessionId: z.string().uuid() }), req.params);
    await sessionService.adminRestoreSession(sessionId);
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});
router.post("/sessions/:sessionId/reinstate", async (req, res, next) => {
  try {
    const { sessionId } = validate(z.object({ sessionId: z.string().uuid() }), req.params);
    const { data: session, error: sessionErr } = await supabaseAdmin
      .from("sessions")
      .select("id, coach_id, session_type_id, location_id, start_at, end_at, is_cancelled")
      .eq("id", sessionId)
      .is("deleted_at", null)
      .single();
    if (sessionErr || !session) throw new HttpError(404, "Session not found");
    if (session.is_cancelled !== true) throw new HttpError(422, "Session is not cancelled");
    if (!session.coach_id) throw new HttpError(422, "Session has no assigned coach");

    await validateCoachForSession({
      coachId: session.coach_id,
      sessionTypeId: session.session_type_id,
      locationId: session.location_id,
      startAt: session.start_at,
      endAt: session.end_at,
      excludeSessionId: sessionId,
    });

    const { error: updErr } = await supabaseAdmin
      .from("sessions")
      .update({ is_cancelled: false })
      .eq("id", sessionId);
    if (updErr) throw new HttpError(500, "Failed to reinstate session", updErr);

    await supabaseAdmin.from("audit_logs").insert({
      actor_type: "admin",
      actor_id: req.user?.id ?? null,
      action: "session.admin_reinstate",
      meta: { sessionId },
    });

    res.json({ ok: true, data: { sessionId, is_cancelled: false } });
  } catch (e) {
    next(e);
  }
});
// Admin fetch bookings routes
router.get('/bookings', async (req, res, next) => { try { const q = validate(adminBookingsListQuerySchema, req.query); res.json({ ok: true, data: await bookingService.listAdminBookings({ from: q.from, to: q.to, memberId: q.memberId, sessionId: q.sessionId, status: q.status, limit: q.limit }) }); } catch (e) { next(e); } });
router.get('/bookings/:bookingId', async (req, res, next) => { try { res.json({ ok: true, data: await bookingService.getAdminBookingById(req.params.bookingId) }); } catch (e) { next(e); } });
router.post('/bookings/:bookingId/remove-member', async (req, res, next) => { try { const body = validate(refundModeSchema, req.body); res.json(await bookingService.adminRemoveMember({ bookingId: req.params.bookingId, refund: body.refund, adminId: req.user!.id })); } catch (e) { next(e); } });
router.post('/bookings/:bookingId/no-show', async (req, res, next) => { try { res.json(await bookingService.adminMarkNoShow({ bookingId: req.params.bookingId, adminId: req.user!.id })); } catch (e) { next(e); } });
router.post('/bookings/:bookingId/move-to-session', async (req, res, next) => {
  try {
    const body = validate(adminMoveBookingSchema, req.body);
    const data = await bookingService.adminMoveBookingToSession({
      bookingId: req.params.bookingId,
      targetSessionId: body.targetSessionId,
      adminId: req.user!.id,
      overrideEligibility: body.overrideEligibility,
    });
    res.json({ ok: true, data });
  } catch (e) {
    next(e);
  }
});
// Admin membership routes
router.post('/memberships', async (req, res, next) => { try { const body = validate(createMembershipSchema, req.body); res.json({ ok: true, data: await membershipService.createMembership({ memberId: body.memberId, mode: body.mode, currentPackage: body.currentPackage, startDate: body.startDate, endDate: body.endDate }) }); } catch (e) { next(e); } });
router.get('/memberships/:membershipId', async (req, res, next) => { try { res.json({ ok: true, data: await membershipService.getMembershipById(req.params.membershipId) }); } catch (e) { next(e); } });
router.patch('/memberships/:membershipId', async (req, res, next) => { try { const body = validate(updateMembershipSchema, req.body); res.json({ ok: true, data: await membershipService.updateMembership(req.params.membershipId, { mode: body.mode, currentPackage: body.currentPackage, isPaused: body.isPaused, status: body.status, startDate: body.startDate, endDate: body.endDate, terminationDate: body.terminationDate }) }); } catch (e) { next(e); } });
router.post('/memberships/:membershipId/pause', async (req, res, next) => { try { const body = validate(pauseMembershipSchema, req.body); res.json({ ok: true, data: await membershipService.pauseMembership({ membershipId: req.params.membershipId, startWeek: body.startWeek, endWeekInclusive: body.endWeekInclusive }) }); } catch (e) { next(e); } });
router.post('/memberships/:membershipId/pause/cancel', async (req, res, next) => { try { const body = validate(cancelPauseMembershipSchema, req.body); res.json({ ok: true, data: await membershipService.cancelMembershipPause({ membershipId: req.params.membershipId, pauseId: body.pause_id ?? body.pauseId, reverseExtensions: body.reverse_extensions ?? body.reverseExtensions, cancelScope: body.pause_id ?? body.pauseId ? 'single' : 'all' }) }); } catch (e) { next(e); } });
router.post('/memberships/:membershipId/resume', async (req, res, next) => { try { res.json({ ok: true, data: await membershipService.resumeMembership(req.params.membershipId) }); } catch (e) { next(e); } });
router.post('/memberships/:membershipId/terminate', async (req, res, next) => { try { const body = validate(terminateMembershipSchema, req.body); res.json({ ok: true, data: await membershipService.terminateMembership({ membershipId: req.params.membershipId, terminationDate: body.terminationDate }) }); } catch (e) { next(e); } });
router.post('/memberships/:membershipId/session-allowances', async (req, res, next) => { try { const body = validate(addSessionAllowanceSchema, req.body); res.json({ ok: true, data: await membershipService.addSessionAllowance({ membershipId: req.params.membershipId, tokenTypeId: body.tokenTypeId, weeklyAllowance: body.weeklyAllowance }) }); } catch (e) { next(e); } });
router.post('/memberships/:membershipId/session-types/:sessionTypeId', async (req, res, next) => { try { const { membershipId, sessionTypeId } = validate(addAllowedSessionTypeSchema, { membershipId: req.params.membershipId, sessionTypeId: req.params.sessionTypeId }); res.json({ ok: true, data: await membershipService.addAllowedSessionType({ membershipId, sessionTypeId }) }); } catch (e) { next(e); } });
// Admin dashboard MemberProfile — memberships tab (must be before /members/:memberId/tokens)
router.get('/members/:memberId/membership/history', async (req, res, next) => {
  try {
    const { memberId } = validate(z.object({ memberId: z.string().uuid() }), req.params);
    const rows = await membershipService.getAdminMemberMembershipHistory(memberId);
    res.json({ ok: true, data: rows });
  } catch (e) {
    next(e);
  }
});
// Gift sessions: stored on `tokens` with source = 'gift' (must be before /members/:memberId/membership single-segment routes if any conflict — none)
router.get("/members/:memberId/membership/gifts", async (req, res, next) => {
  try {
    const { memberId } = validate(z.object({ memberId: z.string().uuid() }), req.params);
    const data = await tokenService.listMemberGiftSessions(memberId);
    res.json({ ok: true, data });
  } catch (e) {
    next(e);
  }
});
router.post("/members/:memberId/membership/gifts", async (req, res, next) => {
  try {
    const { memberId } = validate(z.object({ memberId: z.string().uuid() }), req.params);
    const raw = req.body as Record<string, unknown>;
    const body = validate(createAdminMemberGiftSessionSchema, raw);
    const sessionType = String(body.session_type ?? body.sessionType ?? "");
    const startYmd = String(body.start_date ?? body.startDate ?? "");
    const expiryYmd = String(body.expiry_date ?? body.expiryDate ?? "");
    const data = await tokenService.createMemberGiftSession({
      memberId,
      mode: body.mode,
      sessionType,
      amount: body.amount,
      startDateYmd: startYmd,
      expiryDateYmd: expiryYmd,
      coachId: body.coachId ?? null,
      adminUserId: req.user?.id ?? null,
    });
    res.status(201).json({ ok: true, data });
  } catch (e) {
    next(e);
  }
});
router.post("/members/:memberId/membership/gifts/:giftId/consume", async (req, res, next) => {
  try {
    const { memberId, giftId } = validate(
      z.object({ memberId: z.string().uuid(), giftId: z.string().uuid() }),
      req.params,
    );
    const raw = req.body as Record<string, unknown>;
    const body = validate(consumeAdminMemberGiftSessionSchema, raw);
    const consumedOn = body.consumed_on ?? body.consumedOn;
    const data = await tokenService.consumeMemberGiftSession({
      memberId,
      giftTokenId: giftId,
      quantity: body.quantity,
      consumedOnYmd: typeof consumedOn === "string" ? consumedOn : undefined,
      note: body.note ?? null,
    });
    res.json({ ok: true, data });
  } catch (e) {
    next(e);
  }
});
router.patch("/members/:memberId/membership/gifts/:giftId", async (req, res, next) => {
  try {
    const { memberId, giftId } = validate(
      z.object({ memberId: z.string().uuid(), giftId: z.string().uuid() }),
      req.params,
    );
    const raw = req.body as Record<string, unknown>;
    const body = validate(patchAdminMemberGiftSessionSchema, raw);
    const expiryYmd = body.expiry_date ?? body.expiryDate;
    const data = await tokenService.patchMemberGiftSession({
      memberId,
      giftTokenId: giftId,
      mode: body.mode,
      status: body.status,
      expiryDateYmd: typeof expiryYmd === "string" ? expiryYmd : undefined,
    });
    res.json({ ok: true, data });
  } catch (e) {
    next(e);
  }
});
router.get('/members/:memberId/membership', async (req, res, next) => {
  try {
    const { memberId } = validate(z.object({ memberId: z.string().uuid() }), req.params);
    const mode = typeof req.query.mode === "string" ? req.query.mode : undefined;
    // Use full member booking history so Training tab session history is complete.
    const bookings = await bookingService.getBookings(memberId);
    const data = await membershipService.getAdminMemberMembershipAggregate(memberId, { mode }, bookings as Array<Record<string, unknown>>);
    res.json({ ok: true, data });
  } catch (e) {
    next(e);
  }
});
router.patch('/members/:memberId/membership', async (req, res, next) => {
  try {
    const { memberId } = validate(z.object({ memberId: z.string().uuid() }), req.params);
    const body = validate(patchMemberDashboardMembershipSchema, req.body);
    const tier = body.current_package ?? body.currentPackage ?? "pace";
    const mode = body.mode ?? "inperson";
    const result = await membershipService.patchAdminMemberMembership(memberId, {
      mode,
      currentPackage: tier,
    });
    res.json({ ok: true, data: result });
  } catch (e) {
    next(e);
  }
});
router.post('/members/:memberId/membership/pause', async (req, res, next) => {
  try {
    const { memberId } = validate(z.object({ memberId: z.string().uuid() }), req.params);
    const body = validate(pauseAdminMemberMembershipSchema, req.body);
    const data = await membershipService.pauseAdminMemberMembership(memberId, body);
    res.json({ ok: true, data });
  } catch (e) {
    next(e);
  }
});
router.post('/members/:memberId/membership/pause/cancel', async (req, res, next) => {
  try {
    const { memberId } = validate(z.object({ memberId: z.string().uuid() }), req.params);
    const body = validate(cancelAdminMemberMembershipPauseSchema, req.body);
    const data = await membershipService.cancelAdminMemberMembershipPause(memberId, body);
    res.json({ ok: true, data });
  } catch (e) {
    next(e);
  }
});
router.post('/members/:memberId/membership/pause/resume', async (req, res, next) => {
  try {
    const { memberId } = validate(z.object({ memberId: z.string().uuid() }), req.params);
    const body = validate(resumeAdminMemberMembershipPauseSchema, req.body);
    const data = await membershipService.resumeAdminMemberMembershipPause(memberId, body);
    res.json({ ok: true, data });
  } catch (e) {
    next(e);
  }
});
router.put('/members/:memberId/membership/access', async (req, res, next) => {
  try {
    const { memberId } = validate(z.object({ memberId: z.string().uuid() }), req.params);
    const body = validate(putMemberDashboardMembershipAccessSchema, req.body);
    const result = await membershipService.putAdminMemberMembershipAccess(memberId, {
      member_locations: body.member_locations,
      training_level: body.training_level,
      session_access: body.session_access,
    });
    res.json({ ok: true, data: result });
  } catch (e) {
    next(e);
  }
});
const putMemberTrainingCurrentHandler = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { memberId } = validate(z.object({ memberId: z.string().uuid() }), req.params);
    const body =
      req.body && typeof req.body === "object" && !Array.isArray(req.body)
        ? (req.body as Record<string, unknown>)
        : {};
    const data = await membershipService.putAdminMemberTrainingCurrent(memberId, body);
    res.json({ ok: true, data });
  } catch (e) {
    next(e);
  }
};
router.put('/members/:memberId/membership/training/current', putMemberTrainingCurrentHandler);
router.patch('/members/:memberId/membership/training/current', putMemberTrainingCurrentHandler);
router.post('/members/:memberId/membership/training/current', putMemberTrainingCurrentHandler);
const putMemberNutritionCurrentHandler = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { memberId } = validate(z.object({ memberId: z.string().uuid() }), req.params);
    const body =
      req.body && typeof req.body === "object" && !Array.isArray(req.body)
        ? (req.body as Record<string, unknown>)
        : {};
    const data = await membershipService.putAdminMemberNutritionCurrent(memberId, body);
    res.json({ ok: true, data });
  } catch (e) {
    next(e);
  }
};
router.put('/members/:memberId/membership/nutrition/current', putMemberNutritionCurrentHandler);
router.patch('/members/:memberId/membership/nutrition/current', putMemberNutritionCurrentHandler);
router.post('/members/:memberId/membership/nutrition/current', putMemberNutritionCurrentHandler);
const postMemberTrainingQueueHandler = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { memberId } = validate(z.object({ memberId: z.string().uuid() }), req.params);
    const body = validate(queueMembershipPlanSchema, req.body);
    const data = await membershipService.queueAdminMemberTrainingPlan(memberId, body);
    res.json({ ok: true, data });
  } catch (e) {
    next(e);
  }
};
router.post('/members/:memberId/membership/training/queue', postMemberTrainingQueueHandler);
router.put('/members/:memberId/membership/training/queue', postMemberTrainingQueueHandler);
router.patch('/members/:memberId/membership/training/queue', postMemberTrainingQueueHandler);
const postMemberTrainingCancelHandler = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { memberId } = validate(z.object({ memberId: z.string().uuid() }), req.params);
    const body = validate(cancelMembershipPlanSchema, req.body);
    const data = await membershipService.cancelAdminMemberTrainingPlan(memberId, body);
    res.json({ ok: true, data });
  } catch (e) {
    next(e);
  }
};
router.post('/members/:memberId/membership/training/cancel', postMemberTrainingCancelHandler);
router.put('/members/:memberId/membership/training/cancel', postMemberTrainingCancelHandler);
router.patch('/members/:memberId/membership/training/cancel', postMemberTrainingCancelHandler);
const postMemberNutritionQueueHandler = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { memberId } = validate(z.object({ memberId: z.string().uuid() }), req.params);
    const body = validate(queueMembershipPlanSchema, req.body);
    const data = await membershipService.queueAdminMemberNutritionPlan(memberId, body);
    res.json({ ok: true, data });
  } catch (e) {
    next(e);
  }
};
router.post('/members/:memberId/membership/nutrition/queue', postMemberNutritionQueueHandler);
router.put('/members/:memberId/membership/nutrition/queue', postMemberNutritionQueueHandler);
router.patch('/members/:memberId/membership/nutrition/queue', postMemberNutritionQueueHandler);
const postMemberNutritionCancelHandler = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { memberId } = validate(z.object({ memberId: z.string().uuid() }), req.params);
    const body = validate(cancelMembershipPlanSchema, req.body);
    const data = await membershipService.cancelAdminMemberNutritionPlan(memberId, body);
    res.json({ ok: true, data });
  } catch (e) {
    next(e);
  }
};
router.post('/members/:memberId/membership/nutrition/cancel', postMemberNutritionCancelHandler);
router.put('/members/:memberId/membership/nutrition/cancel', postMemberNutritionCancelHandler);
router.patch('/members/:memberId/membership/nutrition/cancel', postMemberNutritionCancelHandler);
router.get('/members/:memberId/meetings', async (req, res, next) => {
  try {
    const { memberId } = validate(z.object({ memberId: z.string().uuid() }), req.params);
    const q = validate(memberMeetingsQuerySchema, req.query);
    res.json({ ok: true, data: await meetingService.listMemberMeetings(memberId, q) });
  } catch (e) {
    next(e);
  }
});
router.post('/tokens/issue', async (req, res, next) => { try { const body = validate(issueTokensSchema, req.body); res.json({ ok: true, data: await tokenService.issueAdminTokens({ memberId: body.memberId, tokenTypeId: body.tokenTypeId, quantity: body.quantity, expiryAt: body.expiry, coachId: body.coachId }) }); } catch (e) { next(e); } });
// Admin token generation routes for testing will be removed later
router.get('/tokens/generate-weekly', async (req, res, next) => { try { const result = await runWeeklyTokenGeneration(); res.json({ ok: true, data: result }); } catch (e) { next(e); } });
// Admin member routes
router.get('/members/:memberId/tokens', async (req, res, next) => { try { res.json({ ok: true, data: await tokenService.getWallet(req.params.memberId) }); } catch (e) { next(e); } });
router.post('/members/:memberId/session-types/:sessionTypeId', async (req, res, next) => { try { const { memberId, sessionTypeId } = validate(addMemberSessionTagSchema, req.params); const { data, error } = await supabaseAdmin.from('member_session_tags').upsert({ member_id: memberId, session_type_id: sessionTypeId }, { onConflict: 'member_id,session_type_id' }).select().single(); if (error) throw new HttpError(500, 'Failed to add session type for member', error); res.json({ ok: true, data }); } catch (e) { next(e); } });
router.delete('/members/:memberId/session-types/:sessionTypeId', async (req, res, next) => { try { const { memberId, sessionTypeId } = req.params; const { error } = await supabaseAdmin.from('member_session_tags').delete().eq('member_id', memberId).eq('session_type_id', sessionTypeId); if (error) throw new HttpError(500, 'Failed to remove session type for member', error); res.json({ ok: true }); } catch (e) { next(e); } });
router.get('/members/:memberId/session-types', async (req, res, next) => { try { const { data, error } = await supabaseAdmin.from('member_session_tags').select('*, session_types(*)').eq('member_id', req.params.memberId); if (error) throw new HttpError(500, 'Failed to fetch member session types', error); res.json({ ok: true, data: data ?? [] }); } catch (e) { next(e); } });
// Admin coach routes
router.get('/coaches', async (req, res, next) => { try { res.json({ ok: true, data: await coachService.listCoaches() }); } catch (e) { next(e); } });
router.get('/coaches/rota-snapshot', async (req, res, next) => {
  try {
    const q = validate(
      z.object({
        weekStartDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        includeHolidays: z
          .union([z.boolean(), z.literal("true"), z.literal("false"), z.literal("1"), z.literal("0")])
          .optional(),
      }),
      req.query,
    );
    const includeHolidays =
      q.includeHolidays === true || q.includeHolidays === "true" || q.includeHolidays === "1";
    const data = await coachService.getRotaSnapshot(q.weekStartDate, includeHolidays);
    res.json({ ok: true, data });
  } catch (e) { next(e); }
});
router.get('/coaches/:coachUserId', async (req, res, next) => { try { res.json({ ok: true, data: await coachService.getCoach(req.params.coachUserId) }); } catch (e) { next(e); } });
router.post('/coaches', async (req, res, next) => { try { const body = validate(createCoachSchema, req.body); res.json({ ok: true, data: await coachService.createCoach({ userId: body.userId, weeklyHourLimitMins: body.weeklyHourLimitMins, travelBufferMinutes: body.travelBufferMinutes }) }); } catch (e) { next(e); } });
router.patch('/coaches/:coachUserId', async (req, res, next) => { try { const body = validate(updateCoachSchema, req.body); res.json({ ok: true, data: await coachService.updateCoach(req.params.coachUserId, body) }); } catch (e) { next(e); } });
router.delete('/coaches/:coachUserId', async (req, res, next) => { try { res.json(await coachService.deleteCoach(req.params.coachUserId)); } catch (e) { next(e); } });
router.get('/coaches/:coachUserId/availability', async (req, res, next) => { try { const q = validate(coachAvailabilityQuerySchema, req.query); res.json({ ok: true, data: await coachService.getCoachAvailability(req.params.coachUserId, q.weekStartDate, q.kind) }); } catch (e) { next(e); } });
// Replace full weekly pattern; must be registered before POST /availability (add single window).
router.put('/coaches/:coachUserId/availability', async (req, res, next) => { try { const body = validate(replaceCoachAvailabilitySchema, req.body); res.json({ ok: true, data: await coachService.replaceCoachAvailability(req.params.coachUserId, body.windows, body.weekStartDate, body.kind) }); } catch (e) { next(e); } });
router.post('/coaches/:coachUserId/availability/replace', async (req, res, next) => { try { const body = validate(replaceCoachAvailabilitySchema, req.body); res.json({ ok: true, data: await coachService.replaceCoachAvailability(req.params.coachUserId, body.windows, body.weekStartDate, body.kind) }); } catch (e) { next(e); } });
router.post('/coaches/:coachUserId/availability', async (req, res, next) => { try { const body = validate(addCoachAvailabilitySchema, req.body); res.json({ ok: true, data: await coachService.addCoachAvailability({ coachUserId: req.params.coachUserId, dayOfWeek: body.dayOfWeek, startMins: body.startMins, endMins: body.endMins, weekStartDate: body.weekStartDate, kind: body.kind }) }); } catch (e) { next(e); } });
router.delete('/coaches/:coachUserId/availability/:availabilityId', async (req, res, next) => { try { res.json(await coachService.removeCoachAvailability(req.params.availabilityId)); } catch (e) { next(e); } });
router.get('/coaches/:coachUserId/holidays', async (req, res, next) => { try { res.json({ ok: true, data: await coachService.getCoachHolidays(req.params.coachUserId) }); } catch (e) { next(e); } });
router.post('/coaches/:coachUserId/holidays', async (req, res, next) => { try { const body = validate(addCoachHolidaySchema, req.body); res.json({ ok: true, data: await coachService.addCoachHoliday({ coachUserId: req.params.coachUserId, startAt: body.startAt, endAt: body.endAt }) }); } catch (e) { next(e); } });
router.delete('/coaches/:coachUserId/holidays/:holidayId', async (req, res, next) => { try { res.json(await coachService.removeCoachHoliday(req.params.holidayId)); } catch (e) { next(e); } });
router.get('/coaches/:coachUserId/session-types', async (req, res, next) => { try { res.json({ ok: true, data: await coachService.getCoachAllowedSessionTypes(req.params.coachUserId) }); } catch (e) { next(e); } });
router.post('/coaches/:coachUserId/session-types/:sessionTypeId', async (req, res, next) => { try { const { coachUserId, sessionTypeId } = validate(addCoachSessionTypeSchema, { coachUserId: req.params.coachUserId, sessionTypeId: req.params.sessionTypeId }); res.json({ ok: true, data: await coachService.addCoachAllowedSessionType({ coachUserId, sessionTypeId }) }); } catch (e) { next(e); } });
router.delete('/coaches/:coachUserId/session-types/:sessionTypeId', async (req, res, next) => { try { await coachService.removeCoachAllowedSessionType(req.params.coachUserId, req.params.sessionTypeId); res.json({ ok: true }); } catch (e) { next(e); } });
// Staff (admins table)
const STAFF_ADMIN_SELECT =
  "id, name, email, role, location_id, phone, photo_url, created_at, is_active, deactivation_reason, deactivated_at, deactivated_by_admin_id";

function isCoachLikeRole(role: unknown): boolean {
  if (typeof role !== "string") return false;
  const normalized = role.trim().toLowerCase().replace(/\s+/g, "");
  return normalized === "coach" || normalized === "headcoach";
}

async function ensureCoachProfileForAdmin(input: {
  adminId: number | string;
  role: unknown;
}) {
  if (!isCoachLikeRole(input.role)) return;
  const adminIdStr = String(input.adminId);
  const { data: existing, error: existingErr } = await supabaseAdmin
    .from("coaches")
    .select("id")
    .eq("user_id", adminIdStr)
    .maybeSingle();
  if (existingErr) throw new HttpError(500, "Failed to verify coach profile", existingErr);

  if (existing) return;
  const { error: createErr } = await supabaseAdmin.from("coaches").insert({
    user_id: adminIdStr,
    weekly_hour_limit_mins: 2400,
    travel_buffer_minutes: 30,
  });
  if (createErr) throw new HttpError(500, "Failed to auto-create coach profile", createErr);
}

type DirectoryStatsRow = {
  sess: number | null;
  util: number | null;
  noshow: number | null;
  notes: number;
};

/** DB-side GROUP BY (sql/009_team_directory_stats_rpc.sql); falls back to row scan if RPC missing. */
async function fetchStaffNoteCountsMap(): Promise<Map<number, number>> {
  const { data, error } = await supabaseAdmin.rpc("clm_staff_note_counts");
  if (!error && Array.isArray(data)) {
    const m = new Map<number, number>();
    for (const row of data as { staff_id?: unknown; note_count?: unknown }[]) {
      const sid = Number(row.staff_id);
      const cnt = Number(row.note_count);
      if (Number.isFinite(sid) && Number.isFinite(cnt)) m.set(sid, cnt);
    }
    return m;
  }
  const { data: rows, error: e2 } = await supabaseAdmin.from("staff_notes").select("staff_id");
  if (e2) throw new HttpError(500, "Failed to fetch staff notes counts", e2);
  const m = new Map<number, number>();
  for (const row of rows ?? []) {
    const sid = Number((row as { staff_id?: unknown }).staff_id);
    if (!Number.isFinite(sid)) continue;
    m.set(sid, (m.get(sid) ?? 0) + 1);
  }
  return m;
}

async function fetchWeekSessionCountByCoach(
  monday: Date,
  nextMonday: Date,
  coachIds: string[],
): Promise<Map<string, number>> {
  const weekCountByCoach = new Map<string, number>();
  if (coachIds.length === 0) return weekCountByCoach;

  const { data, error } = await supabaseAdmin.rpc("clm_coach_week_session_counts", {
    p_week_start: monday.toISOString(),
    p_week_end: nextMonday.toISOString(),
    p_coach_ids: coachIds,
  });
  if (!error && Array.isArray(data)) {
    for (const row of data as { coach_id?: unknown; cnt?: unknown }[]) {
      const cid = String(row.coach_id);
      const cnt = Number(row.cnt);
      if (cid && Number.isFinite(cnt)) weekCountByCoach.set(cid, cnt);
    }
    return weekCountByCoach;
  }

  const { data: weekRows, error: wErr } = await supabaseAdmin
    .from("sessions")
    .select("coach_id")
    .eq("is_cancelled", false)
    .gte("start_at", monday.toISOString())
    .lt("start_at", nextMonday.toISOString())
    .in("coach_id", coachIds);
  if (wErr) throw new HttpError(500, "Failed to fetch week sessions for directory stats", wErr);
  for (const r of weekRows ?? []) {
    const cid = String((r as { coach_id?: unknown }).coach_id);
    weekCountByCoach.set(cid, (weekCountByCoach.get(cid) ?? 0) + 1);
  }
  return weekCountByCoach;
}

async function fetchPastStatsByCoach(
  windowStartIso: string,
  windowEndIso: string,
  coachIds: string[],
): Promise<Map<string, { util: number | null; noshow: number | null }>> {
  const out = new Map<string, { util: number | null; noshow: number | null }>();
  if (coachIds.length === 0) return out;

  const { data, error } = await supabaseAdmin.rpc("clm_coach_past_stats", {
    p_window_start: windowStartIso,
    p_window_end: windowEndIso,
    p_coach_ids: coachIds,
  });

  if (!error && Array.isArray(data)) {
    for (const row of data as { coach_id?: unknown; util_pct?: unknown; noshow_pct?: unknown }[]) {
      const coachId = String(row.coach_id ?? "");
      if (!coachId) continue;
      const util = Number(row.util_pct);
      const noshow = Number(row.noshow_pct);
      out.set(coachId, {
        util: Number.isFinite(util) ? util : null,
        noshow: Number.isFinite(noshow) ? noshow : null,
      });
    }
    return out;
  }

  const { data: pastSessions, error: pErr } = await supabaseAdmin
    .from("sessions")
    .select("id, coach_id, capacity, bookings(status)")
    .eq("is_cancelled", false)
    .gte("start_at", windowStartIso)
    .lt("start_at", windowEndIso)
    .in("coach_id", coachIds);
  if (pErr) throw new HttpError(500, "Failed to fetch past sessions for directory stats", pErr);

  const byCoach = new Map<string, { sessionCount: number; utilSum: number; nonCancelled: number; noShow: number }>();
  for (const row of (pastSessions ?? []) as Array<{ coach_id: string; capacity?: number; bookings?: Array<{ status?: string }> }>) {
    const coachId = String(row.coach_id ?? "");
    if (!coachId) continue;
    const bucket = byCoach.get(coachId) ?? { sessionCount: 0, utilSum: 0, nonCancelled: 0, noShow: 0 };
    bucket.sessionCount += 1;
    const bookings = Array.isArray(row.bookings) ? row.bookings : [];
    const nonCancelledCount = bookings.filter((b) => String(b?.status) !== "cancelled").length;
    const noShowCount = bookings.filter((b) => String(b?.status) === "no_show").length;
    const capacity = Number(row.capacity) || 0;
    bucket.utilSum += capacity > 0 ? Math.min(nonCancelledCount / capacity, 1) : 0;
    bucket.nonCancelled += nonCancelledCount;
    bucket.noShow += noShowCount;
    byCoach.set(coachId, bucket);
  }

  for (const [coachId, bucket] of byCoach) {
    out.set(coachId, {
      util: bucket.sessionCount > 0 ? Math.round((bucket.utilSum / bucket.sessionCount) * 100) : null,
      noshow: bucket.nonCancelled > 0 ? Math.round((bucket.noShow / bucket.nonCancelled) * 100) : 0,
    });
  }
  return out;
}

/** Shared Team-tab stats map (used by GET /staff?includeStats=1 and GET /staff/directory-stats). */
async function computeDirectoryStatsByAdminId(
  admins: Array<{ id?: unknown; role?: unknown }>,
): Promise<Record<string, DirectoryStatsRow>> {
  const coachLikeIds = admins
    .filter((a) => isCoachLikeRole(a.role))
    .map((a) => String(a.id))
    .filter(Boolean);

  const [notesByStaffId, coachLookup] = await Promise.all([
    fetchStaffNoteCountsMap(),
    coachLikeIds.length > 0
      ? supabaseAdmin.from("coaches").select("id, user_id").in("user_id", coachLikeIds)
      : Promise.resolve({ data: [] as { id: string; user_id: string }[], error: null as null }),
  ]);

  const out: Record<string, DirectoryStatsRow> = {};

  for (const a of admins) {
    const idStr = String(a.id);
    const idNum = Number(idStr);
    out[idStr] = {
      sess: null,
      util: null,
      noshow: null,
      notes: Number.isFinite(idNum) ? (notesByStaffId.get(idNum) ?? 0) : 0,
    };
  }

  if (coachLookup.error) {
    throw new HttpError(500, "Failed to fetch coaches for directory stats", coachLookup.error);
  }

  const adminToCoachId = new Map<string, string>();
  for (const c of coachLookup.data ?? []) {
    const uid = (c as { user_id?: unknown }).user_id;
    const cid = (c as { id?: unknown }).id;
    if (uid != null && cid != null) adminToCoachId.set(String(uid), String(cid));
  }

  const coachIds = [...new Set(adminToCoachId.values())];
  if (coachIds.length === 0) {
    return out;
  }

  const now = new Date();
  const dow = now.getDay();
  const monday = new Date(now);
  monday.setDate(now.getDate() - (dow === 0 ? 6 : dow - 1));
  monday.setHours(0, 0, 0, 0);
  const nextMonday = new Date(monday);
  nextMonday.setDate(monday.getDate() + 7);
  const fourWeeksAgo = new Date(now);
  fourWeeksAgo.setDate(now.getDate() - 28);

  const [weekCountByCoach, pastStatsByCoach] = await Promise.all([
    fetchWeekSessionCountByCoach(monday, nextMonday, coachIds),
    fetchPastStatsByCoach(fourWeeksAgo.toISOString(), now.toISOString(), coachIds),
  ]);

  for (const [adminId, coachId] of adminToCoachId) {
    const sess = weekCountByCoach.get(coachId) ?? 0;
    const pastStats = pastStatsByCoach.get(coachId);
    const util = pastStats?.util ?? null;
    const noshow = pastStats?.noshow ?? null;
    const row = out[adminId];
    if (row) {
      row.sess = sess;
      row.util = util;
      row.noshow = noshow;
    }
  }

  return out;
}

router.get('/staff', async (req, res, next) => {
  try {
    const wantStats =
      req.query.includeStats === "1" ||
      req.query.includeStats === "true" ||
      req.query.includeStats === "yes";
    const locationQuery =
      typeof req.query.location === "string" ? req.query.location.trim() : "";
    const locationFilterNorm = locationQuery.toLowerCase();

    const [staffRes, locRes, allLocsRes] = await Promise.all([
      supabaseAdmin
        .from("admins")
        .select(STAFF_ADMIN_SELECT)
        .order("created_at", { ascending: false }),
      supabaseAdmin.from("admin_location_access").select("admin_id, location_id"),
      supabaseAdmin.from("locations").select("id, name, slug"),
    ]);
    if (staffRes.error) throw new HttpError(500, "Failed to fetch staff", staffRes.error);
    if (locRes.error) throw new HttpError(500, "Failed to fetch staff locations", locRes.error);
    if (allLocsRes.error) throw new HttpError(500, "Failed to fetch locations", allLocsRes.error);

    const locNameById = new Map<string, string>();
    const locSlugById = new Map<string, string>();
    for (const loc of allLocsRes.data ?? []) {
      const id = String((loc as { id?: unknown }).id ?? "");
      if (!id) continue;
      const name = typeof (loc as { name?: unknown }).name === "string" ? (loc as { name: string }).name.trim() : "";
      const slug = typeof (loc as { slug?: unknown }).slug === "string" ? (loc as { slug: string }).slug.trim() : "";
      if (name) locNameById.set(id, name);
      if (slug) locSlugById.set(id, slug);
    }

    const locsByAdmin: Record<string, string[]> = {};
    for (const row of locRes.data ?? []) {
      const key = String(row.admin_id);
      if (!locsByAdmin[key]) locsByAdmin[key] = [];
      locsByAdmin[key].push(row.location_id);
    }
    let mapped = (staffRes.data ?? []).map((s) => {
      const location_ids = locsByAdmin[String(s.id)] ?? (s.location_id ? [s.location_id] : []);
      const locationNames = location_ids
        .map((id) => locNameById.get(String(id)))
        .filter((name): name is string => Boolean(name));
      const locations = location_ids
        .map((id) => ({
          id,
          name: locNameById.get(String(id)) ?? null,
          slug: locSlugById.get(String(id)) ?? null,
        }))
        .filter((row) => row.name);
      const primaryName =
        locationNames[0] ?? (s.location_id ? locNameById.get(String(s.location_id)) : null) ?? null;
      return {
        ...s,
        location_ids,
        location_name: primaryName,
        location: locationNames.length ? locationNames.join(", ") : primaryName,
        locations,
      };
    });

    if (locationFilterNorm && locationFilterNorm !== "all") {
      mapped = mapped.filter((row) => {
        const names = (row.locations ?? [])
          .map((loc: { name?: string | null }) =>
            typeof loc.name === "string" ? loc.name.trim().toLowerCase() : "",
          )
          .filter(Boolean);
        const slugs = (row.locations ?? [])
          .map((loc: { slug?: string | null }) =>
            typeof loc.slug === "string" ? loc.slug.trim().toLowerCase() : "",
          )
          .filter(Boolean);
        return (
          names.some((name: string) => name === locationFilterNorm || name.includes(locationFilterNorm)) ||
          slugs.some((slug: string) => slug === locationFilterNorm || slug.includes(locationFilterNorm))
        );
      });
    }

    if (wantStats && mapped.length > 0) {
      const statsByAdmin = await computeDirectoryStatsByAdminId(staffRes.data ?? []);
      mapped = mapped.map((row) => ({
        ...row,
        directory_stats: statsByAdmin[String(row.id)] ?? {
          sess: null,
          util: null,
          noshow: null,
          notes: 0,
        },
      }));
    }

    res.json({ ok: true, data: mapped });
  } catch (e) {
    next(e);
  }
});

/** Bulk stats map (legacy / fallback); prefer GET /staff?includeStats=1 for one HTTP round-trip. */
router.get("/staff/directory-stats", async (_req, res, next) => {
  try {
    const { data: admins, error: adminsErr } = await supabaseAdmin.from("admins").select("id, role");
    if (adminsErr) throw new HttpError(500, "Failed to fetch admins", adminsErr);

    const out = await computeDirectoryStatsByAdminId(admins ?? []);
    res.json({ ok: true, data: out });
  } catch (e) {
    next(e);
  }
});

router.get('/staff/:staffId', async (req, res, next) => {
  try {
    const { data: staffRow, error: staffError } = await supabaseAdmin
      .from("admins")
      .select(STAFF_ADMIN_SELECT)
      .eq("id", req.params.staffId)
      .maybeSingle();
    if (staffError) throw new HttpError(500, "Failed to fetch staff member", staffError);
    if (!staffRow) throw new HttpError(404, "Staff member not found");

    const { data: locRows, error: locError } = await supabaseAdmin
      .from("admin_location_access")
      .select("location_id, locations(id, name, slug)")
      .eq("admin_id", req.params.staffId);
    if (locError) throw new HttpError(500, "Failed to fetch staff locations", locError);

    const locationIds = (locRows ?? [])
      .map((row) => row.location_id)
      .filter((value): value is string => Boolean(value));

    const locations = (locRows ?? [])
      .map((row) => ({
        id: row.location_id,
        name: (row as { locations?: { name?: string | null } | null }).locations?.name ?? null,
        slug: (row as { locations?: { slug?: string | null } | null }).locations?.slug ?? null,
      }))
      .filter((row) => row.id);

    res.json({
      ok: true,
      data: {
        ...staffRow,
        location_ids: locationIds.length
          ? locationIds
          : (staffRow.location_id ? [staffRow.location_id] : []),
        locations,
      },
    });
  } catch (e) { next(e); }
});

/** Upsert entries in admin_location_access for a given admin. */
async function syncAdminLocations(adminId: number | string, locationIds: string[]): Promise<void> {
  await supabaseAdmin.from("admin_location_access").delete().eq("admin_id", adminId);
  if (locationIds.length === 0) return;
  const rows = locationIds.map(lid => ({ admin_id: adminId, location_id: lid }));
  const { error } = await supabaseAdmin.from("admin_location_access").insert(rows);
  if (error) throw new HttpError(500, "Failed to sync staff locations", error);
}

async function getAdminLocationIds(adminId: number | string): Promise<string[]> {
  const { data, error } = await supabaseAdmin
    .from("admin_location_access")
    .select("location_id")
    .eq("admin_id", adminId);
  if (error) throw new HttpError(500, "Failed to fetch staff locations", error);
  return (data ?? []).map((row) => row.location_id);
}

router.post(
  "/staff/photo-upload",
  express.json({ limit: "5mb" }),
  async (req, res, next) => {
    try {
      const { fileName, contentType, base64 } = req.body as {
        fileName?: string;
        contentType?: string;
        base64?: string;
      };
      if (!fileName || !base64) throw new HttpError(400, "fileName and base64 are required");
      if (!contentType || !contentType.startsWith("image/")) throw new HttpError(400, "Only image uploads are allowed");

      const safeName = fileName.replace(/[^a-zA-Z0-9._-]/g, "_");
      const storagePath = `staff/${Date.now()}-${Math.random().toString(36).slice(2, 10)}-${safeName}`;
      const fileBytes = Buffer.from(base64, "base64");
      const bucket = "image";

      const { error: uploadErr } = await supabaseAdmin.storage
        .from(bucket)
        .upload(storagePath, fileBytes, { contentType, upsert: false });
      if (uploadErr) throw new HttpError(500, "Failed to upload staff profile photo", uploadErr);

      const { data } = supabaseAdmin.storage.from(bucket).getPublicUrl(storagePath);
      const photoUrl = data?.publicUrl;
      if (!photoUrl) throw new HttpError(500, "Failed to resolve photo URL");

      res.status(201).json({ ok: true, data: { photo_url: photoUrl, path: storagePath } });
    } catch (e) {
      next(e);
    }
  },
);

router.post('/staff', async (req, res, next) => {
  try {
    const { name, email, role, location_id, location_ids, phone, photo_url } = req.body as {
      name?: string; email?: string; role?: string;
      location_id?: string | null; location_ids?: string[];
      phone?: string | null;
      photo_url?: string | null;
    };
    if (!name || !name.trim()) throw new HttpError(400, "name is required");
    if (!email || !email.trim()) throw new HttpError(400, "email is required");
    const normalizedEmail = email.trim().toLowerCase();
    // primary location: first of location_ids, or legacy location_id
    const allLocIds = location_ids ?? (location_id ? [location_id] : []);
    if (isCoachLikeRole(role) && allLocIds.length === 0) {
      throw new HttpError(400, "Coach users must have a location before creating coach profile");
    }
    const primaryLocId = allLocIds[0] ?? null;

    const { plainPassword, passwordHash, authUserId } = await provisionStaffAuthAccount({
      email: normalizedEmail,
      name: name.trim(),
      role: role ?? null,
    });

    const insertPayload: Record<string, unknown> = {
      name: name.trim(),
      email: normalizedEmail,
      role: role ?? null,
      location_id: primaryLocId,
      phone: phone ?? null,
      photo_url: photo_url ?? null,
      password: passwordHash,
    };

    let { data, error } = await supabaseAdmin
      .from("admins")
      .insert(insertPayload)
      .select("id, name, email, role, location_id, phone, photo_url")
      .single();

    if (error && String(error.message ?? "").toLowerCase().includes("password")) {
      delete insertPayload.password;
      ({ data, error } = await supabaseAdmin
        .from("admins")
        .insert(insertPayload)
        .select("id, name, email, role, location_id, phone, photo_url")
        .single());
    }

    if (error || !data) {
      await rollbackStaffAuthAccount(authUserId);
      throw new HttpError(500, "Failed to create staff member", error ?? undefined);
    }
    await syncAdminLocations(data.id, allLocIds);
    await ensureCoachProfileForAdmin({ adminId: data.id, role: data.role });

    const emailSent = await sendStaffWelcomeEmail(
      normalizedEmail,
      name.trim(),
      plainPassword,
      role ?? "Coach",
    );
    if (!emailSent) {
      console.warn(
        "[POST /admin/staff] Staff created but welcome email was not sent for",
        normalizedEmail,
      );
    }

    res.status(201).json({
      ok: true,
      data: { ...data, location_ids: allLocIds },
      welcome_email_sent: emailSent,
    });
  } catch (e) { next(e); }
});
router.patch('/staff/:staffId', async (req, res, next) => {
  try {
    const body = req.body as {
      name?: string; email?: string; role?: string;
      location_id?: string | null; location_ids?: string[];
      phone?: string | null;
      photo_url?: string | null;
      is_active?: boolean;
      isActive?: boolean;
      deactivation_reason?: string | null;
      deactivationReason?: string | null;
    };
    const { name, email, role, location_id, location_ids, phone, photo_url } = body;
    const isActiveRaw = body.is_active !== undefined ? body.is_active : body.isActive;
    const deactivationReasonRaw =
      body.deactivation_reason !== undefined ? body.deactivation_reason : body.deactivationReason;

    const updates: Record<string, unknown> = {};
    if (name !== undefined) updates.name = name;
    if (email !== undefined) updates.email = email;
    if (role !== undefined) updates.role = role;
    if (phone !== undefined) updates.phone = phone;
    if (photo_url !== undefined) updates.photo_url = photo_url;

    if (isActiveRaw !== undefined) {
      if (typeof isActiveRaw !== "boolean") {
        throw new HttpError(400, "is_active must be a boolean");
      }
      updates.is_active = isActiveRaw;
      if (isActiveRaw === false) {
        const reason =
          deactivationReasonRaw === undefined || deactivationReasonRaw === null
            ? null
            : String(deactivationReasonRaw).trim() || null;
        updates.deactivation_reason = reason;
        updates.deactivated_at = new Date().toISOString();
        const actorId = Number.parseInt(String(req.user?.id ?? ""), 10);
        updates.deactivated_by_admin_id = Number.isFinite(actorId) ? actorId : null;
      } else {
        updates.deactivation_reason = null;
        updates.deactivated_at = null;
        updates.deactivated_by_admin_id = null;
      }
    } else if (deactivationReasonRaw !== undefined) {
      const reason =
        deactivationReasonRaw === null ? null : String(deactivationReasonRaw).trim() || null;
      updates.deactivation_reason = reason;
    }
    // Resolve primary location from location_ids or legacy location_id
    const allLocIds = location_ids ?? (location_id !== undefined ? (location_id ? [location_id] : []) : undefined);
    if (allLocIds !== undefined && allLocIds.length === 0) {
      if (role === undefined) {
        const { data: existingRoleRow, error: existingRoleErr } = await supabaseAdmin
          .from("admins")
          .select("role")
          .eq("id", req.params.staffId)
          .maybeSingle();
        if (existingRoleErr) throw new HttpError(500, "Failed to verify staff role", existingRoleErr);
        if (isCoachLikeRole(existingRoleRow?.role)) {
          throw new HttpError(400, "Coach users must have a location before creating coach profile");
        }
      } else if (isCoachLikeRole(role)) {
        throw new HttpError(400, "Coach users must have a location before creating coach profile");
      }
    }
    if (allLocIds !== undefined) updates.location_id = allLocIds[0] ?? null;
    else if (location_id !== undefined) updates.location_id = location_id;
    if (Object.keys(updates).length === 0) throw new HttpError(400, "At least one field required");

    const staffId = req.params.staffId;
    const { data: existingStaff, error: existingStaffErr } = await supabaseAdmin
      .from("admins")
      .select("id, role")
      .eq("id", staffId)
      .maybeSingle();
    if (existingStaffErr) throw new HttpError(500, "Failed to verify staff member", existingStaffErr);
    if (!existingStaff) throw new HttpError(404, "Staff member not found");

    const { data, error } = await supabaseAdmin
      .from("admins")
      .update(updates)
      .eq("id", staffId)
      .select(STAFF_ADMIN_SELECT)
      .single();
    if (error) throw new HttpError(500, "Failed to update staff member", error);

    if (isActiveRaw !== undefined && isCoachLikeRole(existingStaff.role ?? data.role)) {
      const { error: coachActiveErr } = await supabaseAdmin
        .from("coaches")
        .update({ is_active: isActiveRaw })
        .eq("user_id", String(staffId));
      if (coachActiveErr) throw new HttpError(500, "Failed to sync coach active status", coachActiveErr);
    }

    if (allLocIds !== undefined) await syncAdminLocations(data.id, allLocIds);
    await ensureCoachProfileForAdmin({ adminId: data.id, role: data.role });
    const finalLocIds = allLocIds ?? await getAdminLocationIds(data.id);
    res.json({ ok: true, data: { ...data, location_ids: finalLocIds } });
  } catch (e) { next(e); }
});
router.delete('/staff/:staffId', async (req, res, next) => {
  try {
    const { error } = await supabaseAdmin.from("admins").delete().eq("id", req.params.staffId);
    if (error) throw new HttpError(500, "Failed to deactivate staff member", error);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// ── Staff Leave (coach_holidays via admins.id → coaches.user_id) ─────────────
/** Resolve coaches.id (UUID) from admins.id (int). Returns null if not a coach. */
/** Resolves coaches.id (UUID) from admins.id (int).
 *  Returns null if the admin does not exist, is not role=coach, or has no coaches record. */
async function resolveCoachId(staffId: string): Promise<string | null> {
  // 1. Confirm the admin record exists and has role = 'coach' (case-insensitive)
  const { data: admin } = await supabaseAdmin
    .from("admins")
    .select("id, role")
    .eq("id", staffId)
    .maybeSingle();
  if (!admin) return null;
  if (!isCoachLikeRole(admin.role)) return null;

  // 2. Look up the coaches record linked to this admin
  const { data: coach } = await supabaseAdmin
    .from("coaches")
    .select("id")
    .eq("user_id", staffId)
    .maybeSingle();
  return coach?.id ?? null;
}

router.get('/staff/:staffId/leaves', async (req, res, next) => {
  try {
    const coachId = await resolveCoachId(req.params.staffId);
    if (!coachId) return res.json({ ok: true, data: [], isCoach: false });
    const { data, error } = await supabaseAdmin
      .from("coach_holidays")
      .select("*")
      .eq("coach_id", coachId)
      .order("start_at", { ascending: false });
    if (error) throw new HttpError(500, "Failed to fetch leaves", error);
    res.json({ ok: true, data: data ?? [], isCoach: true });
  } catch (e) { next(e); }
});

router.post('/staff/:staffId/leaves', async (req, res, next) => {
  try {
    const { start_at, end_at, type = "holiday", notes } = req.body as {
      start_at?: string; end_at?: string; type?: string; notes?: string;
    };
    if (!start_at || !end_at) throw new HttpError(400, "start_at and end_at are required");
    if (new Date(end_at) <= new Date(start_at)) throw new HttpError(400, "end_at must be after start_at");
    const validTypes = ["holiday", "sick", "personal", "medical", "training"];
    if (!validTypes.includes(type)) throw new HttpError(400, `type must be one of: ${validTypes.join(", ")}`);
    const coachId = await resolveCoachId(req.params.staffId);
    if (!coachId) throw new HttpError(404, "No coach profile found for this staff member. Only coach-role staff can have leave logged.");
    const { data, error } = await supabaseAdmin
      .from("coach_holidays")
      .insert({ coach_id: coachId, start_at, end_at, type, notes: notes ?? null })
      .select("*")
      .single();
    if (error) throw new HttpError(500, "Failed to create leave", error);
    res.status(201).json({ ok: true, data });
  } catch (e) { next(e); }
});

router.delete('/staff/:staffId/leaves/:leaveId', async (req, res, next) => {
  try {
    const { error } = await supabaseAdmin
      .from("coach_holidays")
      .delete()
      .eq("id", req.params.leaveId);
    if (error) throw new HttpError(500, "Failed to delete leave", error);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// ── Staff Schedule (current week sessions) ────────────────────────────────────
router.get('/staff/:staffId/schedule', async (req, res, next) => {
  try {
    const coachId = await resolveCoachId(req.params.staffId);
    if (!coachId) return res.json({ ok: true, isCoach: false, data: [] });

    // Current week: Monday 00:00 UTC → next Monday 00:00 UTC
    const now = new Date();
    const dow = now.getDay(); // 0 = Sun
    const monday = new Date(now);
    monday.setDate(now.getDate() - (dow === 0 ? 6 : dow - 1));
    monday.setHours(0, 0, 0, 0);
    const nextMonday = new Date(monday);
    nextMonday.setDate(monday.getDate() + 7);

    const { data, error } = await supabaseAdmin
      .from("sessions")
      .select("id, start_at, end_at, capacity, is_cancelled, session_types(name, color), locations(name)")
      .eq("coach_id", coachId)
      .eq("is_cancelled", false)
      .gte("start_at", monday.toISOString())
      .lt("start_at", nextMonday.toISOString())
      .order("start_at", { ascending: true });

    if (error) throw new HttpError(500, "Failed to fetch schedule", error);
    res.json({ ok: true, isCoach: true, data: data ?? [] });
  } catch (e) { next(e); }
});

// ── Staff Stats ────────────────────────────────────────────────────────────────
router.get('/staff/:staffId/stats', async (req, res, next) => {
  try {
    const staffIdInt = parseInt(req.params.staffId, 10);

    // NOTES count — works for all staff regardless of coach status
    const { count: notesCount } = await supabaseAdmin
      .from("staff_notes")
      .select("*", { count: "exact", head: true })
      .eq("staff_id", staffIdInt);
    const notes = notesCount ?? 0;

    const coachId = await resolveCoachId(req.params.staffId);
    if (!coachId) {
      return res.json({ ok: true, isCoach: false, data: { sess: null, util: null, noshow: null, notes } });
    }

    const now = new Date();

    // ── Week start: Monday 00:00 local ──
    const dow = now.getDay(); // 0=Sun
    const monday = new Date(now);
    monday.setDate(now.getDate() - (dow === 0 ? 6 : dow - 1));
    monday.setHours(0, 0, 0, 0);
    const nextMonday = new Date(monday);
    nextMonday.setDate(monday.getDate() + 7);

    // ── Past 4 weeks for historical stats ──
    const fourWeeksAgo = new Date(now);
    fourWeeksAgo.setDate(now.getDate() - 28);

    // SESS — non-cancelled sessions starting this week
    const { count: weekSessionsCount, error: e1 } = await supabaseAdmin
      .from("sessions")
      .select("*", { count: "exact", head: true })
      .eq("coach_id", coachId)
      .eq("is_cancelled", false)
      .gte("start_at", monday.toISOString())
      .lt("start_at", nextMonday.toISOString());
    if (e1) throw new HttpError(500, "Failed to fetch week sessions", e1);
    const sess = weekSessionsCount ?? 0;

    // Past sessions (completed, not cancelled) for UTIL + NO-SHOW
    const { data: pastSessions, error: e2 } = await supabaseAdmin
      .from("sessions")
      .select("id, capacity")
      .eq("coach_id", coachId)
      .eq("is_cancelled", false)
      .gte("start_at", fourWeeksAgo.toISOString())
      .lt("start_at", now.toISOString());
    if (e2) throw new HttpError(500, "Failed to fetch past sessions", e2);

    if (!pastSessions || pastSessions.length === 0) {
      return res.json({ ok: true, isCoach: true, data: { sess, util: null, noshow: null, notes } });
    }

    // Bookings for those past sessions, bounded via sessions join (avoids large session_id IN lists).
    const { data: bookings, error: e3 } = await supabaseAdmin
      .from("bookings")
      .select("session_id, status, sessions!inner(id)")
      .eq("sessions.coach_id", coachId)
      .eq("sessions.is_cancelled", false)
      .gte("sessions.start_at", fourWeeksAgo.toISOString())
      .lt("sessions.start_at", now.toISOString());
    if (e3) throw new HttpError(500, "Failed to fetch bookings", e3);

    const bk = (bookings ?? []) as { session_id: string; status: string }[];
    const nonCancelled = bk.filter(b => b.status !== "cancelled");
    const noShows = bk.filter(b => b.status === "no_show");

    // UTIL — avg (booked / capacity) across past sessions, as %
    let utilSum = 0;
    for (const s of pastSessions as { id: string; capacity: number }[]) {
      const booked = bk.filter(b => b.session_id === s.id && b.status !== "cancelled").length;
      utilSum += s.capacity > 0 ? booked / s.capacity : 0;
    }
    const util = Math.round((utilSum / pastSessions.length) * 100);

    // NO-SHOW — (no_show / non-cancelled) as %
    const noshow = nonCancelled.length > 0
      ? Math.round((noShows.length / nonCancelled.length) * 100)
      : 0;

    res.json({ ok: true, isCoach: true, data: { sess, util, noshow, notes } });
  } catch (e) { next(e); }
});

// ── Staff Notes ────────────────────────────────────────────────────────────────
router.get('/staff/:staffId/notes', async (req, res, next) => {
  try {
    const { data, error } = await supabaseAdmin
      .from("staff_notes")
      .select("*")
      .eq("staff_id", parseInt(req.params.staffId, 10))
      .order("created_at", { ascending: false });
    if (error) throw new HttpError(500, "Failed to fetch notes", error);
    res.json({ ok: true, data: data ?? [] });
  } catch (e) { next(e); }
});

router.post('/staff/:staffId/notes', async (req, res, next) => {
  try {
    const { content, category = "General" } = req.body as { content?: string; category?: string };
    if (!content?.trim()) throw new HttpError(400, "content is required");
    const validCategories = ["General", "Performance", "Feedback", "Meeting"];
    if (!validCategories.includes(category)) throw new HttpError(400, `category must be one of: ${validCategories.join(", ")}`);
    const { data, error } = await supabaseAdmin
      .from("staff_notes")
      .insert({ staff_id: parseInt(req.params.staffId, 10), content: content.trim(), category })
      .select("*")
      .single();
    if (error) throw new HttpError(500, "Failed to create note", error);
    res.status(201).json({ ok: true, data });
  } catch (e) { next(e); }
});

router.delete('/staff/:staffId/notes/:noteId', async (req, res, next) => {
  try {
    const { error } = await supabaseAdmin
      .from("staff_notes")
      .delete()
      .eq("id", req.params.noteId)
      .eq("staff_id", parseInt(req.params.staffId, 10));
    if (error) throw new HttpError(500, "Failed to delete note", error);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// ── Staff Tasks ────────────────────────────────────────────────────────────────
// Schema: staff_tasks(id uuid, created_by_admin_id bigint, assigned_to_admin_id bigint,
//   title text, description text, status 'open'|'done', priority 'low'|'medium'|'high',
//   due_at timestamptz, completed_at timestamptz, source 'manual'|'legacy_note', created_at, updated_at)

/** All tasks across all staff, with assignee name resolved */
router.get('/tasks', async (req, res, next) => {
  try {
    const [tasksRes, staffRes] = await Promise.all([
      supabaseAdmin
        .from("staff_tasks")
        .select("*")
        .eq("source", "manual")
        .order("created_at", { ascending: false }),
      supabaseAdmin.from("admins").select("id, name"),
    ]);
    if (tasksRes.error) throw new HttpError(500, "Failed to fetch tasks", tasksRes.error);
    const nameMap: Record<number, string> = {};
    (staffRes.data ?? []).forEach((s: { id: number; name: string | null }) => {
      nameMap[s.id] = s.name ?? "Unknown";
    });
    const data = (tasksRes.data ?? []).map((t: Record<string, unknown>) => ({
      ...t,
      staff_name: nameMap[t.assigned_to_admin_id as number] ?? "Unknown",
    }));
    res.json({ ok: true, data });
  } catch (e) { next(e); }
});

/** Tasks assigned to a specific staff member */
router.get('/staff/:staffId/tasks', async (req, res, next) => {
  try {
    const { data, error } = await supabaseAdmin
      .from("staff_tasks")
      .select("*")
      .eq("assigned_to_admin_id", parseInt(req.params.staffId, 10))
      .order("created_at", { ascending: false });
    if (error) throw new HttpError(500, "Failed to fetch tasks", error);
    res.json({ ok: true, data: data ?? [] });
  } catch (e) { next(e); }
});

/** Create a task assigned to a staff member */
router.post('/staff/:staffId/tasks', async (req, res, next) => {
  try {
    const { title, description, due_at, priority = "medium" } = req.body as {
      title?: string; description?: string; due_at?: string | null; priority?: string;
    };
    if (!title?.trim()) throw new HttpError(400, "title is required");
    const validPriorities = ["low", "medium", "high"];
    if (!validPriorities.includes(priority)) throw new HttpError(400, `priority must be one of: ${validPriorities.join(", ")}`);
    const creatorId = parseInt(req.user!.id, 10);
    if (isNaN(creatorId)) throw new HttpError(401, "Invalid admin identity");
    const { data, error } = await supabaseAdmin
      .from("staff_tasks")
      .insert({
        assigned_to_admin_id: parseInt(req.params.staffId, 10),
        created_by_admin_id: creatorId,
        title: title.trim(),
        description: description?.trim() ?? null,
        due_at: due_at ?? null,
        priority,
        status: "open",
        source: "manual",
      })
      .select("*")
      .single();
    if (error) throw new HttpError(500, "Failed to create task", error);
    res.status(201).json({ ok: true, data });
  } catch (e) { next(e); }
});

/** Update a task (status, priority, title, description, due_at) */
router.patch('/staff/:staffId/tasks/:taskId', async (req, res, next) => {
  try {
    const { status, title, description, due_at, priority } = req.body as {
      status?: string; title?: string; description?: string; due_at?: string | null; priority?: string;
    };
    const validStatuses = ["open", "done"];
    const validPriorities = ["low", "medium", "high"];
    if (status && !validStatuses.includes(status)) throw new HttpError(400, `status must be one of: ${validStatuses.join(", ")}`);
    if (priority && !validPriorities.includes(priority)) throw new HttpError(400, `priority must be one of: ${validPriorities.join(", ")}`);
    const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (status !== undefined) { updates.status = status; if (status === "done") updates.completed_at = new Date().toISOString(); }
    if (title !== undefined) updates.title = title?.trim();
    if (description !== undefined) updates.description = description?.trim() ?? null;
    if (due_at !== undefined) updates.due_at = due_at ?? null;
    if (priority !== undefined) updates.priority = priority;
    const { data, error } = await supabaseAdmin
      .from("staff_tasks")
      .update(updates)
      .eq("id", req.params.taskId)
      .eq("assigned_to_admin_id", parseInt(req.params.staffId, 10))
      .select("*")
      .single();
    if (error) throw new HttpError(500, "Failed to update task", error);
    res.json({ ok: true, data });
  } catch (e) { next(e); }
});

/** Delete a task */
router.delete('/staff/:staffId/tasks/:taskId', async (req, res, next) => {
  try {
    const { error } = await supabaseAdmin
      .from("staff_tasks")
      .delete()
      .eq("id", req.params.taskId)
      .eq("assigned_to_admin_id", parseInt(req.params.staffId, 10));
    if (error) throw new HttpError(500, "Failed to delete task", error);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

router.get('/locations', async (req, res, next) => { try { res.json({ ok: true, data: await sessionService.listLocations() }); } catch (e) { next(e); } });
router.post('/locations', async (req, res, next) => { try { const body = validate(createLocationSchema, req.body); res.json({ ok: true, data: await sessionService.createLocation(body) }); } catch (e) { next(e); } });
router.patch('/locations/:locationId', async (req, res, next) => { try { const body = validate(updateLocationSchema, req.body); res.json({ ok: true, data: await sessionService.updateLocation(req.params.locationId, body) }); } catch (e) { next(e); } });
router.delete('/locations/:locationId', async (req, res, next) => { try { await sessionService.deleteLocation(req.params.locationId); res.json({ ok: true }); } catch (e) { next(e); } });
// Admin meeting routes
router.get('/meeting-types', async (req, res, next) => { try { res.json({ ok: true, data: await meetingService.listMeetingTypesAdmin() }); } catch (e) { next(e); } });
router.post('/meeting-types', async (req, res, next) => { try { const body = validate(createMeetingTypeSchema, req.body); res.json({ ok: true, data: await meetingService.createMeetingType(body) }); } catch (e) { next(e); } });
router.patch('/meeting-types/:meetingTypeId', async (req, res, next) => { try { const body = validate(updateMeetingTypeSchema, req.body); res.json({ ok: true, data: await meetingService.updateMeetingType(req.params.meetingTypeId, body) }); } catch (e) { next(e); } });
router.delete('/meeting-types/:meetingTypeId', async (req, res, next) => { try { res.json({ ok: true, data: await meetingService.deleteMeetingType(req.params.meetingTypeId) }); } catch (e) { next(e); } });
router.get('/meeting-slots', async (req, res, next) => { try { const q = validate(adminMeetingSlotsQuerySchema, req.query); res.json({ ok: true, data: await meetingService.listMeetingSlotsAdmin({ meetingTypeId: q.meetingTypeId, locationId: q.locationId, from: q.from, to: q.to }) }); } catch (e) { next(e); } });
router.post('/meeting-slots', async (req, res, next) => { try { const body = validate(createMeetingSlotSchema, req.body); res.json({ ok: true, data: await meetingService.createMeetingSlot(body) }); } catch (e) { next(e); } });
router.patch('/meeting-slots/:meetingSlotId', async (req, res, next) => { try { const body = validate(updateMeetingSlotSchema, req.body); res.json({ ok: true, data: await meetingService.updateMeetingSlot(req.params.meetingSlotId, body) }); } catch (e) { next(e); } });
router.get('/meeting-slots/bookings', async (req, res, next) => {
  try {
    const q = validate(z.object({
      meetingTypeId: z.string().uuid(),
      locationId: z.string().uuid(),
      meetingStart: z.string().datetime()
    }), req.query);
    res.json({ ok: true, data: await meetingService.listMeetingsForSlot(q) });
  } catch (e) { next(e); }
});
router.delete('/meeting-slots/:meetingSlotId', async (req, res, next) => { try { res.json(await meetingService.deleteMeetingSlot(req.params.meetingSlotId)); } catch (e) { next(e); } });

export default router;