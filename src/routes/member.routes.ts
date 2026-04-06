import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import { requireProfileRole } from "../middleware/roles.js";
import { validate } from "../utils/validate.js";
import { createBookingSchema, joinWaitlistSchema, purchaseTokensCheckoutSchema, createMeetingSchema } from "../validators/member.schemas.js";
import { BookingService } from "../services/booking-service.js";
import { TokenService } from "../services/token-service.js";
import { StripeService } from "../services/stripe-service.js";
import { MeetingService } from "../services/meeting-service.js";
import { SessionService } from "../services/session-service.js";

const router = Router();
const bookingService = new BookingService();
const tokenService = new TokenService();
const stripeService = new StripeService();
const meetingService = new MeetingService();
const sessionService = new SessionService();

router.use(requireAuth, requireProfileRole('member'));

// Member booking routes
router.get('/booking-context', async (req, res, next) => { try { res.json({ ok: true, data: await bookingService.getBookingContext(req.user!.id) }); } catch (e) { next(e); } });
router.get('/sessions/available', async (req, res, next) => { try { const from = typeof req.query.from === 'string' ? req.query.from : undefined; const to = typeof req.query.to === 'string' ? req.query.to : undefined; const sessionTypeId = typeof req.query.sessionTypeId === 'string' ? req.query.sessionTypeId : undefined; const locationId = typeof req.query.locationId === 'string' ? req.query.locationId : undefined; const isOnline = req.query.isOnline === 'true'; res.json({ ok: true, data: await bookingService.getAvailableSessions(req.user!.id, from, to, sessionTypeId, locationId, isOnline) }); } catch (e) { next(e); } });
router.get('/sessions/:sessionId', async (req, res, next) => { try { res.json({ ok: true, data: await bookingService.getSessionDetail(req.params.sessionId) }); } catch (e) { next(e); } });
router.get('/bookings', async (req, res, next) => { try { const status = typeof req.query.status === 'string' ? req.query.status : undefined; res.json({ ok: true, data: await bookingService.getBookings(req.user!.id, status) }); } catch (e) { next(e); } });
router.get('/session-usage', async (req, res, next) => { try { const view = req.query.view === 'past' ? 'past' : 'upcoming'; res.json({ ok: true, data: await bookingService.getSessionUsage(req.user!.id, view) }); } catch (e) { next(e); } });
router.post('/bookings', async (req, res, next) => { try { const body = validate(createBookingSchema, req.body); res.json(await bookingService.createBooking({ memberId: req.user!.id, membershipId: body.membershipId, sessionId: body.sessionId })); } catch (e) { next(e); } });
router.post('/bookings/:bookingId/cancel', async (req, res, next) => { try { res.json(await bookingService.cancelBooking({ bookingId: req.params.bookingId, memberId: req.user!.id })); } catch (e) { next(e); } });
router.get('/waitlist', async (req, res, next) => { try { res.json({ ok: true, data: await bookingService.getMemberWaitlistEntries(req.user!.id) }); } catch (e) { next(e); } });
router.post('/waitlist', async (req, res, next) => { try { const body = validate(joinWaitlistSchema, req.body); res.json(await bookingService.joinWaitlist({ memberId: req.user!.id, membershipId: body.membershipId, sessionId: body.sessionId })); } catch (e) { next(e); } });
router.get('/tokens', async (req, res, next) => { try { res.json({ ok: true, data: await tokenService.getWallet(req.user!.id) }); } catch (e) { next(e); } });
router.get('/tokens/additional-summary', async (req, res, next) => { try { res.json({ ok: true, data: await tokenService.getAdditionalSessionsSummary(req.user!.id) }); } catch (e) { next(e); } });
router.get('/tokens/purchase/options', async (req, res, next) => { try { res.json({ ok: true, data: await tokenService.listPurchaseOptions() }); } catch (e) { next(e); } });
router.post('/tokens/purchase/checkout', async (req, res, next) => { try { const body = validate(purchaseTokensCheckoutSchema, req.body); const session = await stripeService.createCheckoutSession({ memberId: req.user!.id, membershipId: body.membershipId, tokenTypeId: body.tokenTypeId, quantity: body.quantity }); res.json({ ok: true, checkoutUrl: session.url }); } catch (e) { next(e); } });
router.get('/locations', async (req, res, next) => { try { res.json({ ok: true, data: await sessionService.listLocations() }); } catch (e) { next(e); } });
router.get('/meetings/types', async (req, res, next) => { try { res.json({ ok: true, data: await meetingService.listMeetingTypes() }); } catch (e) { next(e); } });
router.get('/meetings/availability', async (req, res, next) => {
  try {
    const meetingTypeId = typeof req.query.meetingTypeId === 'string' ? req.query.meetingTypeId : '';
    const date = typeof req.query.date === 'string' ? req.query.date : '';
    const locationId = typeof req.query.locationId === 'string' ? req.query.locationId : undefined;
    if (!meetingTypeId || !date) {
      res.status(400).json({ ok: false, error: 'meetingTypeId and date are required' });
      return;
    }
    res.json({ ok: true, data: await meetingService.getAvailability(req.user!.id, { meetingTypeId, date, locationId }) });
  } catch (e) { next(e); }
});
router.get('/meetings/eligibility', async (req, res, next) => { try { res.json({ ok: true, data: await meetingService.getEligibility(req.user!.id) }); } catch (e) { next(e); } });
router.post('/meetings', async (req, res, next) => { try { const body = validate(createMeetingSchema, req.body); res.json({ ok: true, data: await meetingService.createMeeting({ memberId: req.user!.id, meetingTypeId: body.meetingTypeId, locationId: body.locationId, meetingStart: body.meetingStart }) }); } catch (e) { next(e); } });

export default router;
