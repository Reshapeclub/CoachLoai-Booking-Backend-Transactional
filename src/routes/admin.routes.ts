import { Router } from "express";
import { requireAdminAuth } from "../middleware/auth.js";
import { requireAdminTableAccess } from "../middleware/roles.js";
import { validate } from "../utils/validate.js";
import {
  createSessionTypeSchema,
  updateSessionTypeSchema,
  createSessionSchema,
  setCapacitySchema,
  setCoachSchema,
  setSessionTypeSchema,
  refundModeSchema,
  createMembershipSchema,
  updateMembershipSchema,
  pauseMembershipSchema,
  terminateMembershipSchema,
  issueTokensSchema,
  addMemberSessionTagSchema,
  addSessionAllowanceSchema,
  addAllowedSessionTypeSchema,
  createCoachSchema,
  updateCoachSchema,
  addCoachAvailabilitySchema,
  addCoachHolidaySchema,
  addCoachSessionTypeSchema,
  adminBookingsListQuerySchema,
} from "../validators/admin.schemas.js";
import { SessionService } from "../services/session-service.js";
import { CoachService } from "../services/coach-service.js";
import { MembershipService } from "../services/membership-service.js";
import { TokenService } from "../services/token-service.js";
import { BookingService } from "../services/booking-service.js";
import { supabaseAdmin } from "../db/supabase.js";
import { HttpError } from "../lib/http-error.js";
import { runWeeklyTokenGeneration } from "../jobs/weekly-token-generation.js";

const router = Router();
const sessionService = new SessionService();
const coachService = new CoachService();
const membershipService = new MembershipService();
const tokenService = new TokenService();
const bookingService = new BookingService();

router.use(requireAdminAuth, requireAdminTableAccess());
// Admin session types routes
router.get('/session-types', async (req,res,next)=>{ try { res.json({ ok:true, data: await sessionService.listSessionTypes() }); } catch(e){ next(e);} });
router.post('/session-types', async (req,res,next)=>{ try { const body=validate(createSessionTypeSchema, req.body); res.json({ ok:true, data: await sessionService.createSessionType(body) }); } catch(e){ next(e);} });
router.patch('/session-types/:sessionTypeId', async (req,res,next)=>{ try { const body=validate(updateSessionTypeSchema, req.body); res.json({ ok:true, data: await sessionService.updateSessionType(req.params.sessionTypeId, body) }); } catch(e){ next(e);} });
// Admin session routes
router.get('/sessions', async (req,res,next)=>{ try { const from=typeof req.query.from==='string'?req.query.from:undefined; const to=typeof req.query.to==='string'?req.query.to:undefined; res.json({ ok:true, data: await sessionService.listSessions(from, to) }); } catch(e){ next(e);} });
router.get('/sessions/:sessionId/members', async (req,res,next)=>{ try { res.json({ ok:true, data: await sessionService.getSessionMembers(req.params.sessionId) }); } catch(e){ next(e);} });
router.get('/sessions/:sessionId/waitlist', async (req,res,next)=>{ try { res.json({ ok:true, data: await bookingService.getSessionWaitlist(req.params.sessionId) }); } catch(e){ next(e);} });
router.post('/sessions', async (req,res,next)=>{ try { const body=validate(createSessionSchema, req.body); const { data: st, error } = await supabaseAdmin.from('session_types').select('*').eq('id', body.sessionTypeId).single(); if (error || !st) throw new HttpError(404,'Session type not found'); const start=new Date(body.start); const end=new Date(start.getTime() + (body.durationMins ?? st.default_duration_mins)*60*1000); res.json({ ok:true, data: await sessionService.createSession({ sessionTypeId: body.sessionTypeId, tokenTypeId: st.token_type_id, coachUserId: body.coachId, locationId: body.locationId ?? null, startAt: start.toISOString(), endAt: end.toISOString(), capacity: body.capacity ?? st.default_capacity, allowOvertime: body.allowOvertime }) }); } catch(e){ next(e);} });
router.patch('/sessions/:sessionId/capacity', async (req,res,next)=>{ try { const body=validate(setCapacitySchema, req.body); res.json({ ok:true, data: await sessionService.setCapacity(req.params.sessionId, body.capacity) }); } catch(e){ next(e);} });
router.patch('/sessions/:sessionId/coach', async (req,res,next)=>{ try { const body=validate(setCoachSchema, req.body); res.json({ ok:true, data: await sessionService.setCoach(req.params.sessionId, body.newCoachId, { allowOvertime: body.allowOvertime }) }); } catch(e){ next(e);} });
router.patch('/sessions/:sessionId/type', async (req,res,next)=>{ try { const body=validate(setSessionTypeSchema, req.body); const { data: st, error } = await supabaseAdmin.from('session_types').select('*').eq('id', body.newSessionTypeId).single(); if (error || !st) throw new HttpError(404, 'Session type not found'); res.json({ ok:true, data: await sessionService.setSessionType(req.params.sessionId, body.newSessionTypeId, st.token_type_id) }); } catch(e){ next(e);} });
router.post('/sessions/:sessionId/cancel', async (req,res,next)=>{ try { const body=validate(refundModeSchema, req.body); res.json(await bookingService.adminCancelSession({ sessionId:req.params.sessionId, refund:body.refund, adminId:req.user!.id })); } catch(e){ next(e);} });
// Admin fetch bookings routes
router.get('/bookings', async (req,res,next)=>{ try { const q=validate(adminBookingsListQuerySchema, req.query); res.json({ ok:true, data: await bookingService.listAdminBookings({ from:q.from, to:q.to, memberId:q.memberId, sessionId:q.sessionId, status:q.status, limit:q.limit }) }); } catch(e){ next(e);} });
router.get('/bookings/:bookingId', async (req,res,next)=>{ try { res.json({ ok:true, data: await bookingService.getAdminBookingById(req.params.bookingId) }); } catch(e){ next(e);} });
router.post('/bookings/:bookingId/remove-member', async (req,res,next)=>{ try { const body=validate(refundModeSchema, req.body); res.json(await bookingService.adminRemoveMember({ bookingId:req.params.bookingId, refund:body.refund, adminId:req.user!.id })); } catch(e){ next(e);} });
// Admin membership routes
router.post('/memberships', async (req,res,next)=>{ try { const body=validate(createMembershipSchema, req.body); res.json({ ok:true, data: await membershipService.createMembership({ memberId: body.memberId, mode: body.mode, currentPackage: body.currentPackage, startDate: body.startDate, endDate: body.endDate }) }); } catch(e){ next(e);} });
router.get('/memberships/:membershipId', async (req,res,next)=>{ try { res.json({ ok:true, data: await membershipService.getMembershipById(req.params.membershipId) }); } catch(e){ next(e);} });
router.patch('/memberships/:membershipId', async (req,res,next)=>{ try { const body=validate(updateMembershipSchema, req.body); res.json({ ok:true, data: await membershipService.updateMembership(req.params.membershipId, { mode: body.mode, currentPackage: body.currentPackage, isPaused: body.isPaused, status: body.status, startDate: body.startDate, endDate: body.endDate, terminationDate: body.terminationDate }) }); } catch(e){ next(e);} });
router.post('/memberships/:membershipId/pause', async (req,res,next)=>{ try { const body=validate(pauseMembershipSchema, req.body); res.json({ ok:true, data: await membershipService.pauseMembership({ membershipId:req.params.membershipId, startWeek:body.startWeek, endWeekInclusive:body.endWeekInclusive }) }); } catch(e){ next(e);} });
router.post('/memberships/:membershipId/terminate', async (req,res,next)=>{ try { const body=validate(terminateMembershipSchema, req.body); res.json({ ok:true, data: await membershipService.terminateMembership({ membershipId:req.params.membershipId, terminationDate:body.terminationDate }) }); } catch(e){ next(e);} });
router.post('/memberships/:membershipId/session-allowances', async (req,res,next)=>{ try { const body=validate(addSessionAllowanceSchema, req.body); res.json({ ok:true, data: await membershipService.addSessionAllowance({ membershipId: req.params.membershipId, tokenTypeId: body.tokenTypeId, weeklyAllowance: body.weeklyAllowance }) }); } catch(e){ next(e);} });
router.post('/memberships/:membershipId/session-types/:sessionTypeId', async (req,res,next)=>{ try { const { membershipId, sessionTypeId } = validate(addAllowedSessionTypeSchema, { membershipId: req.params.membershipId, sessionTypeId: req.params.sessionTypeId }); res.json({ ok:true, data: await membershipService.addAllowedSessionType({ membershipId, sessionTypeId }) }); } catch(e){ next(e);} });
router.post('/tokens/issue', async (req,res,next)=>{ try { const body=validate(issueTokensSchema, req.body); res.json({ ok:true, data: await tokenService.issueAdminTokens({ memberId:body.memberId, tokenTypeId:body.tokenTypeId, quantity:body.quantity, expiryAt:body.expiry }) }); } catch(e){ next(e);} });
// Admin token generation routes for testing will be removed later
router.get('/tokens/generate-weekly', async (req,res,next)=>{ try { const result = await runWeeklyTokenGeneration(); res.json({ ok:true, data: result }); } catch(e){ next(e);} });
// Admin member routes
router.get('/members/:memberId/tokens', async (req,res,next)=>{ try { res.json({ ok:true, data: await tokenService.getWallet(req.params.memberId) }); } catch(e){ next(e);} });
router.post('/members/:memberId/session-types/:sessionTypeId', async (req,res,next)=>{ try { const { memberId, sessionTypeId } = validate(addMemberSessionTagSchema, req.params); const { data, error } = await supabaseAdmin.from('member_session_tags').upsert({ member_id: memberId, session_type_id: sessionTypeId }, { onConflict: 'member_id,session_type_id' }).select().single(); if (error) throw new HttpError(500, 'Failed to add session type for member', error); res.json({ ok: true, data }); } catch(e){ next(e);} });
router.delete('/members/:memberId/session-types/:sessionTypeId', async (req,res,next)=>{ try { const { memberId, sessionTypeId } = req.params; const { error } = await supabaseAdmin.from('member_session_tags').delete().eq('member_id', memberId).eq('session_type_id', sessionTypeId); if (error) throw new HttpError(500, 'Failed to remove session type for member', error); res.json({ ok: true }); } catch(e){ next(e);} });
router.get('/members/:memberId/session-types', async (req,res,next)=>{ try { const { data, error } = await supabaseAdmin.from('member_session_tags').select('*, session_types(*)').eq('member_id', req.params.memberId); if (error) throw new HttpError(500, 'Failed to fetch member session types', error); res.json({ ok: true, data: data ?? [] }); } catch(e){ next(e);} });
// Admin coach routes
router.get('/coaches', async (req,res,next)=>{ try { res.json({ ok:true, data: await coachService.listCoaches() }); } catch(e){ next(e);} });
router.get('/coaches/:coachUserId', async (req,res,next)=>{ try { res.json({ ok:true, data: await coachService.getCoach(req.params.coachUserId) }); } catch(e){ next(e);} });
router.post('/coaches', async (req,res,next)=>{ try { const body=validate(createCoachSchema, req.body); res.json({ ok:true, data: await coachService.createCoach({ userId: body.userId, weeklyHourLimitMins: body.weeklyHourLimitMins, travelBufferMinutes: body.travelBufferMinutes }) }); } catch(e){ next(e);} });
router.patch('/coaches/:coachUserId', async (req,res,next)=>{ try { const body=validate(updateCoachSchema, req.body); res.json({ ok:true, data: await coachService.updateCoach(req.params.coachUserId, body) }); } catch(e){ next(e);} });
router.delete('/coaches/:coachUserId', async (req,res,next)=>{ try { res.json(await coachService.deleteCoach(req.params.coachUserId)); } catch(e){ next(e);} });
router.get('/coaches/:coachUserId/availability', async (req,res,next)=>{ try { res.json({ ok:true, data: await coachService.getCoachAvailability(req.params.coachUserId) }); } catch(e){ next(e);} });
router.post('/coaches/:coachUserId/availability', async (req,res,next)=>{ try { const body=validate(addCoachAvailabilitySchema, req.body); res.json({ ok:true, data: await coachService.addCoachAvailability({ coachUserId: req.params.coachUserId, dayOfWeek: body.dayOfWeek, startMins: body.startMins, endMins: body.endMins }) }); } catch(e){ next(e);} });
router.delete('/coaches/:coachUserId/availability/:availabilityId', async (req,res,next)=>{ try { res.json(await coachService.removeCoachAvailability(req.params.availabilityId)); } catch(e){ next(e);} });
router.get('/coaches/:coachUserId/holidays', async (req,res,next)=>{ try { res.json({ ok:true, data: await coachService.getCoachHolidays(req.params.coachUserId) }); } catch(e){ next(e);} });
router.post('/coaches/:coachUserId/holidays', async (req,res,next)=>{ try { const body=validate(addCoachHolidaySchema, req.body); res.json({ ok:true, data: await coachService.addCoachHoliday({ coachUserId: req.params.coachUserId, startAt: body.startAt, endAt: body.endAt }) }); } catch(e){ next(e);} });
router.delete('/coaches/:coachUserId/holidays/:holidayId', async (req,res,next)=>{ try { res.json(await coachService.removeCoachHoliday(req.params.holidayId)); } catch(e){ next(e);} });
router.get('/coaches/:coachUserId/session-types', async (req,res,next)=>{ try { res.json({ ok:true, data: await coachService.getCoachAllowedSessionTypes(req.params.coachUserId) }); } catch(e){ next(e);} });
router.post('/coaches/:coachUserId/session-types/:sessionTypeId', async (req,res,next)=>{ try { const { coachUserId, sessionTypeId } = validate(addCoachSessionTypeSchema, { coachUserId: req.params.coachUserId, sessionTypeId: req.params.sessionTypeId }); res.json({ ok:true, data: await coachService.addCoachAllowedSessionType({ coachUserId, sessionTypeId }) }); } catch(e){ next(e);} });
router.delete('/coaches/:coachUserId/session-types/:sessionTypeId', async (req,res,next)=>{ try { await coachService.removeCoachAllowedSessionType(req.params.coachUserId, req.params.sessionTypeId); res.json({ ok: true }); } catch(e){ next(e);} });
router.get('/locations', async (req,res,next)=>{ try { res.json({ ok:true, data: await sessionService.listLocations() }); } catch(e){ next(e);} });

export default router;
