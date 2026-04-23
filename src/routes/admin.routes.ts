import { Router } from "express";
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
  createMembershipSchema,
  updateMembershipSchema,
  pauseMembershipSchema,
  cancelPauseMembershipSchema,
  terminateMembershipSchema,
  issueTokensSchema,
  addMemberSessionTagSchema,
  addSessionAllowanceSchema,
  addAllowedSessionTypeSchema,
  patchMemberDashboardMembershipSchema,
  createCoachSchema,
  updateCoachSchema,
  addCoachAvailabilitySchema,
  replaceCoachAvailabilitySchema,
  coachAvailabilityQuerySchema,
  addCoachHolidaySchema,
  addCoachSessionTypeSchema,
  adminBookingsListQuerySchema,
  adminWaitlistEntriesQuerySchema,
  createMeetingTypeSchema,
  updateMeetingTypeSchema,
  adminMeetingSlotsQuerySchema,
  createMeetingSlotSchema,
  updateMeetingSlotSchema,
  updateSessionTypesByCategorySchema,
  createLocationSchema,
  updateLocationSchema,
} from "../validators/admin.schemas.js";
import { SessionService } from "../services/session-service.js";
import { CoachService } from "../services/coach-service.js";
import { MembershipService } from "../services/membership-service.js";
import { TokenService } from "../services/token-service.js";
import { BookingService } from "../services/booking-service.js";
import { MeetingService } from "../services/meeting-service.js";
import { supabaseAdmin } from "../db/supabase.js";
import { HttpError } from "../lib/http-error.js";
import { runWeeklyTokenGeneration } from "../jobs/weekly-token-generation.js";

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
router.get('/sessions', async (req, res, next) => { try { const from = typeof req.query.from === 'string' ? req.query.from : undefined; const to = typeof req.query.to === 'string' ? req.query.to : undefined; res.json({ ok: true, data: await sessionService.listSessions(from, to) }); } catch (e) { next(e); } });
router.get('/sessions/:sessionId/members', async (req, res, next) => { try { res.json({ ok: true, data: await sessionService.getSessionMembers(req.params.sessionId) }); } catch (e) { next(e); } });
router.get('/sessions/:sessionId/waitlist', async (req, res, next) => { try { res.json({ ok: true, data: await bookingService.getSessionWaitlist(req.params.sessionId) }); } catch (e) { next(e); } });
router.post('/sessions', async (req, res, next) => { try { const body = validate(createSessionSchema, req.body); const { data: st, error } = await supabaseAdmin.from('session_types').select('*').eq('id', body.sessionTypeId).single(); if (error || !st) throw new HttpError(404, 'Session type not found'); const start = new Date(body.start); const end = new Date(start.getTime() + (body.durationMins ?? st.default_duration_mins) * 60 * 1000); res.json({ ok: true, data: await sessionService.createSession({ sessionTypeId: body.sessionTypeId, tokenTypeId: body.tokenTypeId ?? st.token_type_id, coachId: body.coachId, locationId: body.locationId ?? null, isOnline: body.isOnline ?? false, startAt: start.toISOString(), endAt: end.toISOString(), capacity: body.capacity ?? st.default_capacity, allowOvertime: body.allowOvertime }) }); } catch (e) { next(e); } });
router.patch('/sessions/:sessionId', async (req, res, next) => { try { const body = validate(updateSessionSchema, req.body); res.json({ ok: true, data: await sessionService.updateSession(req.params.sessionId, body) }); } catch (e) { next(e); } });
router.patch('/sessions/:sessionId/capacity', async (req, res, next) => { try { const body = validate(setCapacitySchema, req.body); res.json({ ok: true, data: await sessionService.setCapacity(req.params.sessionId, body.capacity) }); } catch (e) { next(e); } });
router.patch('/sessions/:sessionId/coach', async (req, res, next) => { try { const body = validate(setCoachSchema, req.body); res.json({ ok: true, data: await sessionService.setCoach(req.params.sessionId, body.newCoachId, { allowOvertime: body.allowOvertime }) }); } catch (e) { next(e); } });
router.patch('/sessions/:sessionId/type', async (req, res, next) => { try { const body = validate(setSessionTypeSchema, req.body); const { data: st, error } = await supabaseAdmin.from('session_types').select('*').eq('id', body.newSessionTypeId).single(); if (error || !st) throw new HttpError(404, 'Session type not found'); res.json({ ok: true, data: await sessionService.setSessionType(req.params.sessionId, body.newSessionTypeId, st.token_type_id) }); } catch (e) { next(e); } });
router.post('/sessions/:sessionId/cancel', async (req, res, next) => {
  try {
    const body = validate(refundModeSchema, req.body);
    const { data: session, error: sessionErr } = await supabaseAdmin
      .from("sessions")
      .select("coach_id")
      .eq("id", req.params.sessionId)
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
// Admin fetch bookings routes
router.get('/bookings', async (req, res, next) => { try { const q = validate(adminBookingsListQuerySchema, req.query); res.json({ ok: true, data: await bookingService.listAdminBookings({ from: q.from, to: q.to, memberId: q.memberId, sessionId: q.sessionId, status: q.status, limit: q.limit }) }); } catch (e) { next(e); } });
router.get('/bookings/:bookingId', async (req, res, next) => { try { res.json({ ok: true, data: await bookingService.getAdminBookingById(req.params.bookingId) }); } catch (e) { next(e); } });
router.post('/bookings/:bookingId/remove-member', async (req, res, next) => { try { const body = validate(refundModeSchema, req.body); res.json(await bookingService.adminRemoveMember({ bookingId: req.params.bookingId, refund: body.refund, adminId: req.user!.id })); } catch (e) { next(e); } });
router.post('/bookings/:bookingId/no-show', async (req, res, next) => { try { res.json(await bookingService.adminMarkNoShow({ bookingId: req.params.bookingId, adminId: req.user!.id })); } catch (e) { next(e); } });
// Admin membership routes
router.post('/memberships', async (req, res, next) => { try { const body = validate(createMembershipSchema, req.body); res.json({ ok: true, data: await membershipService.createMembership({ memberId: body.memberId, mode: body.mode, currentPackage: body.currentPackage, startDate: body.startDate, endDate: body.endDate }) }); } catch (e) { next(e); } });
router.get('/memberships/:membershipId', async (req, res, next) => { try { res.json({ ok: true, data: await membershipService.getMembershipById(req.params.membershipId) }); } catch (e) { next(e); } });
router.patch('/memberships/:membershipId', async (req, res, next) => { try { const body = validate(updateMembershipSchema, req.body); res.json({ ok: true, data: await membershipService.updateMembership(req.params.membershipId, { mode: body.mode, currentPackage: body.currentPackage, isPaused: body.isPaused, status: body.status, startDate: body.startDate, endDate: body.endDate, terminationDate: body.terminationDate }) }); } catch (e) { next(e); } });
router.post('/memberships/:membershipId/pause', async (req, res, next) => { try { const body = validate(pauseMembershipSchema, req.body); res.json({ ok: true, data: await membershipService.pauseMembership({ membershipId: req.params.membershipId, startWeek: body.startWeek, endWeekInclusive: body.endWeekInclusive }) }); } catch (e) { next(e); } });
router.post('/memberships/:membershipId/pause/cancel', async (req, res, next) => { try { const body = validate(cancelPauseMembershipSchema, req.body); res.json({ ok: true, data: await membershipService.cancelMembershipPause({ membershipId: req.params.membershipId, pauseId: body.pause_id ?? body.pauseId, reverseExtensions: body.reverse_extensions ?? body.reverseExtensions }) }); } catch (e) { next(e); } });
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
router.get('/members/:memberId/membership', async (req, res, next) => {
  try {
    const { memberId } = validate(z.object({ memberId: z.string().uuid() }), req.params);
    const mode = typeof req.query.mode === "string" ? req.query.mode : undefined;
    const bookings = await bookingService.listAdminBookings({ memberId, limit: 200 });
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
router.get('/coaches/:coachUserId', async (req, res, next) => { try { res.json({ ok: true, data: await coachService.getCoach(req.params.coachUserId) }); } catch (e) { next(e); } });
router.post('/coaches', async (req, res, next) => { try { const body = validate(createCoachSchema, req.body); res.json({ ok: true, data: await coachService.createCoach({ userId: body.userId, weeklyHourLimitMins: body.weeklyHourLimitMins, travelBufferMinutes: body.travelBufferMinutes }) }); } catch (e) { next(e); } });
router.patch('/coaches/:coachUserId', async (req, res, next) => { try { const body = validate(updateCoachSchema, req.body); res.json({ ok: true, data: await coachService.updateCoach(req.params.coachUserId, body) }); } catch (e) { next(e); } });
router.delete('/coaches/:coachUserId', async (req, res, next) => { try { res.json(await coachService.deleteCoach(req.params.coachUserId)); } catch (e) { next(e); } });
router.get('/coaches/:coachUserId/availability', async (req, res, next) => { try { const q = validate(coachAvailabilityQuerySchema, req.query); res.json({ ok: true, data: await coachService.getCoachAvailability(req.params.coachUserId, q.weekStartDate) }); } catch (e) { next(e); } });
// Replace full weekly pattern; must be registered before POST /availability (add single window).
router.put('/coaches/:coachUserId/availability', async (req, res, next) => { try { const body = validate(replaceCoachAvailabilitySchema, req.body); res.json({ ok: true, data: await coachService.replaceCoachAvailability(req.params.coachUserId, body.windows, body.weekStartDate) }); } catch (e) { next(e); } });
router.post('/coaches/:coachUserId/availability/replace', async (req, res, next) => { try { const body = validate(replaceCoachAvailabilitySchema, req.body); res.json({ ok: true, data: await coachService.replaceCoachAvailability(req.params.coachUserId, body.windows, body.weekStartDate) }); } catch (e) { next(e); } });
router.post('/coaches/:coachUserId/availability', async (req, res, next) => { try { const body = validate(addCoachAvailabilitySchema, req.body); res.json({ ok: true, data: await coachService.addCoachAvailability({ coachUserId: req.params.coachUserId, dayOfWeek: body.dayOfWeek, startMins: body.startMins, endMins: body.endMins, weekStartDate: body.weekStartDate }) }); } catch (e) { next(e); } });
router.delete('/coaches/:coachUserId/availability/:availabilityId', async (req, res, next) => { try { res.json(await coachService.removeCoachAvailability(req.params.availabilityId)); } catch (e) { next(e); } });
router.get('/coaches/:coachUserId/holidays', async (req, res, next) => { try { res.json({ ok: true, data: await coachService.getCoachHolidays(req.params.coachUserId) }); } catch (e) { next(e); } });
router.post('/coaches/:coachUserId/holidays', async (req, res, next) => { try { const body = validate(addCoachHolidaySchema, req.body); res.json({ ok: true, data: await coachService.addCoachHoliday({ coachUserId: req.params.coachUserId, startAt: body.startAt, endAt: body.endAt }) }); } catch (e) { next(e); } });
router.delete('/coaches/:coachUserId/holidays/:holidayId', async (req, res, next) => { try { res.json(await coachService.removeCoachHoliday(req.params.holidayId)); } catch (e) { next(e); } });
router.get('/coaches/:coachUserId/session-types', async (req, res, next) => { try { res.json({ ok: true, data: await coachService.getCoachAllowedSessionTypes(req.params.coachUserId) }); } catch (e) { next(e); } });
router.post('/coaches/:coachUserId/session-types/:sessionTypeId', async (req, res, next) => { try { const { coachUserId, sessionTypeId } = validate(addCoachSessionTypeSchema, { coachUserId: req.params.coachUserId, sessionTypeId: req.params.sessionTypeId }); res.json({ ok: true, data: await coachService.addCoachAllowedSessionType({ coachUserId, sessionTypeId }) }); } catch (e) { next(e); } });
router.delete('/coaches/:coachUserId/session-types/:sessionTypeId', async (req, res, next) => { try { await coachService.removeCoachAllowedSessionType(req.params.coachUserId, req.params.sessionTypeId); res.json({ ok: true }); } catch (e) { next(e); } });
// Staff (admins table)
function isCoachLikeRole(role: unknown): boolean {
  if (typeof role !== "string") return false;
  const normalized = role.trim().toLowerCase().replace(/\s+/g, "");
  return normalized === "coach" || normalized === "headcoach";
}

async function ensureCoachProfileForAdmin(input: {
  adminId: number | string;
  role: unknown;
  locationId?: string | null;
}) {
  if (!isCoachLikeRole(input.role)) return;
  const adminIdStr = String(input.adminId);
  const { data: existing, error: existingErr } = await supabaseAdmin
    .from("coaches")
    .select("id, location_id")
    .eq("user_id", adminIdStr)
    .maybeSingle();
  if (existingErr) throw new HttpError(500, "Failed to verify coach profile", existingErr);

  if (existing) {
    if (input.locationId && existing.location_id !== input.locationId) {
      const { error: updErr } = await supabaseAdmin
        .from("coaches")
        .update({ location_id: input.locationId })
        .eq("id", existing.id);
      if (updErr) throw new HttpError(500, "Failed to sync coach location", updErr);
    }
    return;
  }

  if (!input.locationId) {
    throw new HttpError(400, "Coach users must have a location before creating coach profile");
  }
  const { error: createErr } = await supabaseAdmin.from("coaches").insert({
    user_id: adminIdStr,
    location_id: input.locationId,
    weekly_hour_limit_mins: 2400,
    travel_buffer_minutes: 30,
  });
  if (createErr) throw new HttpError(500, "Failed to auto-create coach profile", createErr);
}

router.get('/staff', async (req, res, next) => {
  try {
    const { data, error } = await supabaseAdmin
      .from("admins")
      .select("id, name, email, role, location_id")
      .order("name", { ascending: true });
    if (error) throw new HttpError(500, "Failed to fetch staff", error);
    res.json({ ok: true, data: data ?? [] });
  } catch (e) { next(e); }
});
router.post('/staff', async (req, res, next) => {
  try {
    const { name, email, role, location_id } = req.body as { name?: string; email?: string; role?: string; location_id?: string | null };
    if (!name || !name.trim()) throw new HttpError(400, "name is required");
    if (!email || !email.trim()) throw new HttpError(400, "email is required");
    const { data, error } = await supabaseAdmin
      .from("admins")
      .insert({ name: name.trim(), email: email.trim(), role: role ?? null, location_id: location_id ?? null })
      .select("id, name, email, role, location_id")
      .single();
    if (error) throw new HttpError(500, "Failed to create staff member", error);
    await ensureCoachProfileForAdmin({
      adminId: data.id,
      role: data.role,
      locationId: data.location_id ?? null,
    });
    res.status(201).json({ ok: true, data });
  } catch (e) { next(e); }
});
router.patch('/staff/:staffId', async (req, res, next) => {
  try {
    const { name, email, role, location_id } = req.body as { name?: string; email?: string; role?: string; location_id?: string | null };
    const updates: Record<string, unknown> = {};
    if (name !== undefined) updates.name = name;
    if (email !== undefined) updates.email = email;
    if (role !== undefined) updates.role = role;
    if (location_id !== undefined) updates.location_id = location_id;
    if (Object.keys(updates).length === 0) throw new HttpError(400, "At least one field required");
    const { data, error } = await supabaseAdmin
      .from("admins")
      .update(updates)
      .eq("id", req.params.staffId)
      .select("id, name, email, role, location_id")
      .single();
    if (error) throw new HttpError(500, "Failed to update staff member", error);
    await ensureCoachProfileForAdmin({
      adminId: data.id,
      role: data.role,
      locationId: data.location_id ?? null,
    });
    res.json({ ok: true, data });
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

    // ── Past 4 weeks for historical stats ──
    const fourWeeksAgo = new Date(now);
    fourWeeksAgo.setDate(now.getDate() - 28);

    // SESS — non-cancelled sessions starting this week
    const { data: weekSessions, error: e1 } = await supabaseAdmin
      .from("sessions")
      .select("id")
      .eq("coach_id", coachId)
      .eq("is_cancelled", false)
      .gte("start_at", monday.toISOString())
      .lte("start_at", now.toISOString());
    if (e1) throw new HttpError(500, "Failed to fetch week sessions", e1);
    const sess = (weekSessions ?? []).length;

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

    const sessionIds = pastSessions.map((s: { id: string }) => s.id);

    // Bookings for past sessions
    const { data: bookings, error: e3 } = await supabaseAdmin
      .from("bookings")
      .select("session_id, status")
      .in("session_id", sessionIds);
    if (e3) throw new HttpError(500, "Failed to fetch bookings", e3);

    const bk = (bookings ?? []) as { session_id: string; status: string }[];
    const nonCancelled = bk.filter(b => b.status !== "cancelled");
    const noShows      = bk.filter(b => b.status === "no_show");

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
        created_by_admin_id:  creatorId,
        title:                title.trim(),
        description:          description?.trim() ?? null,
        due_at:               due_at ?? null,
        priority,
        status:               "open",
        source:               "manual",
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
    const validStatuses   = ["open", "done"];
    const validPriorities = ["low", "medium", "high"];
    if (status   && !validStatuses.includes(status))     throw new HttpError(400, `status must be one of: ${validStatuses.join(", ")}`);
    if (priority && !validPriorities.includes(priority)) throw new HttpError(400, `priority must be one of: ${validPriorities.join(", ")}`);
    const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (status      !== undefined) { updates.status = status; if (status === "done") updates.completed_at = new Date().toISOString(); }
    if (title       !== undefined) updates.title       = title?.trim();
    if (description !== undefined) updates.description = description?.trim() ?? null;
    if (due_at      !== undefined) updates.due_at      = due_at ?? null;
    if (priority    !== undefined) updates.priority    = priority;
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
router.get('/meeting-slots', async (req, res, next) => { try { const q = validate(adminMeetingSlotsQuerySchema, req.query); res.json({ ok: true, data: await meetingService.listMeetingSlotsAdmin({ meetingTypeId: q.meetingTypeId, locationId: q.locationId, from: q.from, to: q.to }) }); } catch (e) { next(e); } });
router.post('/meeting-slots', async (req, res, next) => { try { const body = validate(createMeetingSlotSchema, req.body); res.json({ ok: true, data: await meetingService.createMeetingSlot(body) }); } catch (e) { next(e); } });
router.patch('/meeting-slots/:meetingSlotId', async (req, res, next) => { try { const body = validate(updateMeetingSlotSchema, req.body); res.json({ ok: true, data: await meetingService.updateMeetingSlot(req.params.meetingSlotId, body) }); } catch (e) { next(e); } });
router.delete('/meeting-slots/:meetingSlotId', async (req, res, next) => { try { res.json(await meetingService.deleteMeetingSlot(req.params.meetingSlotId)); } catch (e) { next(e); } });

export default router;
