import Stripe from "stripe";

const key = process.env.STRIPE_SECRET_KEY || "";

export const stripeEnabled = (): boolean => key.length > 0;

// Cloudflare Workers (6 Nov 2026): Stripe must use its fetch-based HTTP client.
// The default Node client opens sockets the Workers runtime never completes,
// so "Top up" and "Pay by card" hung and Cloudflare showed error 1101.
export const stripe: Stripe | null = key
  ? new Stripe(key, {
      apiVersion: "2024-11-20.acacia" as Stripe.LatestApiVersion,
      httpClient: Stripe.createFetchHttpClient(),
    })
  : null;

export const appUrl = (): string =>
  (process.env.APP_URL || "http://localhost:3000/linktomorrow").replace(/\/$/, "");

/**
 * Create a Stripe Checkout Session for a one-off USD payment.
 * amountCents is the integer amount to charge.
 */
export async function createCheckout(opts: {
  amountCents: number;
  label: string;
  purpose: "order" | "topup";
  ref: string;
  orderId?: number;
  customerEmail?: string;
}): Promise<string> {
  if (!stripe) throw new Error("Stripe is not configured (missing STRIPE_SECRET_KEY).");
  const session = await stripe.checkout.sessions.create({
    mode: "payment",
    payment_method_types: ["card"],
    customer_email: opts.customerEmail,
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: "usd",
          unit_amount: opts.amountCents,
          product_data: { name: opts.label },
        },
      },
    ],
    metadata: {
      purpose: opts.purpose,
      ref: opts.ref,
      orderId: String(opts.orderId ?? 0),
    },
    success_url: `${appUrl()}/orders?paid=1`,
    cancel_url: `${appUrl()}/orders?cancelled=1`,
  });
  return session.url!;
}
