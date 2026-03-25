import { Router } from "express";
import Stripe from "stripe";
import { HttpError } from "../lib/http-error.js";
import { env } from "../config/env.js";
import { TokenService } from "../services/token-service.js";

const router = Router();
const tokenService = new TokenService();

async function fulfillCheckoutSessionTokens(session: Stripe.Checkout.Session) {
  const metadata = session.metadata ?? {};
  const memberId = metadata.memberId;
  const membershipId = metadata.membershipId;
  const tokenTypeId = metadata.tokenTypeId;
  const quantity = Number(metadata.quantity);
  const stripeSessionId = session.id;
  if (!memberId || !membershipId || !tokenTypeId || !stripeSessionId || !Number.isFinite(quantity)) {
    throw new HttpError(400, "Missing required metadata on Stripe checkout session");
  }
  await tokenService.issuePurchasedTokensFromStripeSession({
    stripeSessionId,
    memberId,
    membershipId,
    tokenTypeId,
    quantity,
    purchaseDate: session.created ? new Date(session.created * 1000) : undefined,
  });
}

function getStripeSignature(req: any): string {
  const sig = req.headers?.["stripe-signature"];
  if (!sig || typeof sig !== "string") throw new HttpError(400, "Missing stripe-signature header");
  return sig;
}

router.post("/stripe", async (req, res, next) => {
  try {
    if (!env.STRIPE_SECRET_KEY) throw new HttpError(500, "Stripe not configured");
    if (!env.STRIPE_WEBHOOK_SECRET) throw new HttpError(500, "Stripe webhook secret not configured");

    const rawBody = req.body;
    const bodyBuffer = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody);

    const stripe = new Stripe(env.STRIPE_SECRET_KEY);
    const event = stripe.webhooks.constructEvent(
      bodyBuffer,
      getStripeSignature(req),
      env.STRIPE_WEBHOOK_SECRET
    );
    console.log(event.type, "<<<<<<<<<<<<<<<<EVENT");
    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object as Stripe.Checkout.Session;
        console.log(session, "<<<<<<<<<<<<<<<<SESSION");
        console.log(session.metadata, "<<<<<<<<<<<<<<<<METADATA");
        // Instant methods: paid here. Delayed methods: often unpaid until async_payment_succeeded.
        if (session.payment_status !== "paid") {
          break;
        }
        await fulfillCheckoutSessionTokens(session);
        break;
      }
      case "checkout.session.async_payment_succeeded": {
        const session = event.data.object as Stripe.Checkout.Session;
        console.log(session, "<<<<<<<<<<<<<<<<SESSION_ASYNC_OK");
        await fulfillCheckoutSessionTokens(session);
        break;
      }
      default:
        break;
    }

    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

export default router;
