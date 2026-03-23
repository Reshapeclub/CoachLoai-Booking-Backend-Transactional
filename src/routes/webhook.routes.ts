import { Router } from "express";
import Stripe from "stripe";
import { HttpError } from "../lib/http-error.js";
import { env } from "../config/env.js";
import { TokenService } from "../services/token-service.js";

const router = Router();
const tokenService = new TokenService();

function getStripeSignature(req: any): string {
  const sig = req.headers?.["stripe-signature"];
  if (!sig || typeof sig !== "string") throw new HttpError(400, "Missing stripe-signature header");
  return sig;
}

router.post("/stripe", async (req, res, next) => {
  try {
    if (!env.STRIPE_SECRET_KEY) throw new HttpError(500, "Stripe not configured");
    if (!env.STRIPE_WEBHOOK_SECRET) throw new HttpError(500, "Stripe webhook secret not configured");

    // With `express.raw`, req.body should be a Buffer.
    const rawBody = req.body;
    const bodyBuffer = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody);

    const stripe = new Stripe(env.STRIPE_SECRET_KEY);
    const event = stripe.webhooks.constructEvent(
      bodyBuffer,
      getStripeSignature(req),
      env.STRIPE_WEBHOOK_SECRET
    );

    // Only handle checkout completion events (minimal set for now).
    switch (event.type) {
      case "checkout.session.completed":
      case "checkout.session.async_payment_succeeded": {
        const session = event.data.object as any;
        const metadata = session?.metadata ?? {};

        const memberId = metadata.memberId;
        const membershipId = metadata.membershipId;
        const tokenTypeId = metadata.tokenTypeId;
        const quantity = Number(metadata.quantity);
        const stripeSessionId = session?.id;

        if (!memberId || !membershipId || !tokenTypeId || !stripeSessionId || !Number.isFinite(quantity)) {
          throw new HttpError(400, "Missing required metadata on Stripe checkout session");
        }

        await tokenService.issuePurchasedTokensFromStripeSession({
          stripeSessionId,
          memberId,
          membershipId,
          tokenTypeId,
          quantity,
          purchaseDate: session?.created ? new Date(session.created * 1000) : undefined,
        });
        break;
      }
      default:
        // Ignore events we don't care about for now.
        break;
    }

    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

export default router;
