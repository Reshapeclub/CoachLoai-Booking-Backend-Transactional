import Stripe from "stripe";
import { env } from "../config/env.js";
import { HttpError } from "../lib/http-error.js";
import { supabaseAdmin } from "../db/supabase.js";

export class StripeService {
  private stripe = env.STRIPE_SECRET_KEY ? new Stripe(env.STRIPE_SECRET_KEY) : null;

  async createCheckoutSession(input: { memberId: string; membershipId: string; tokenTypeId: string; quantity: number; }) {
    if (!this.stripe) throw new HttpError(500, 'Stripe is not configured');
    const { data: sessionType, error: sessionTypeError } = await supabaseAdmin
      .from("session_types")
      .select("name")
      .eq("token_type_id", input.tokenTypeId)
      .single();

    if (sessionTypeError || !sessionType?.name) {
      throw new HttpError(404, "Session type not found for tokenTypeId", sessionTypeError);
    }

    const unitAmountMinorCentsByName: Record<string, number> = {
      Elite: 3500,
      Group: 1500,
      Octave: 2500,
      "1:1": 9000,
    };

    const unitAmountMinorCents = unitAmountMinorCentsByName[sessionType.name];
    if (!unitAmountMinorCents) {
      throw new HttpError(400, `Unsupported session type price: ${sessionType.name}`);
    }

    const session = await this.stripe.checkout.sessions.create({
      mode: 'payment',
      success_url: "coachloai://payment/success?session_id={CHECKOUT_SESSION_ID}",
      cancel_url: "coachloai://payment/cancel",
      line_items: [{
        quantity: input.quantity,
        price_data: {
          currency: 'gbp',
          unit_amount: unitAmountMinorCents,
          product_data: {
            name: `${sessionType.name}- CLM Extra Tokens x${input.quantity}`,
          },
        },
      }],
      metadata: { memberId: input.memberId, membershipId: input.membershipId, tokenTypeId: input.tokenTypeId, quantity: String(input.quantity) }
    });
    console.log(session, "<<<<<<<<<<<<<<<<SESSION_CREATED");
    return session;
  }
}
