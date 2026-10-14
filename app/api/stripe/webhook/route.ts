import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { stripe } from "@/lib/stripe";
import { emailEnabled, sendDepositReceipt, sendDepositAdmin } from "@/lib/email";
import { notifyNewOrder } from "@/lib/order-steps";
import { netDeposit } from "@/lib/money";
import { dueAtFrom } from "@/lib/orders";
import { MARKUP_REQUESTED } from "@/lib/money";

// Stripe needs the raw body to verify the signature.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  if (!stripe) {
    console.error("[stripe-webhook] STRIPE_SECRET_KEY is not set - event ignored.");
    return NextResponse.json({ error: "stripe not configured" }, { status: 400 });
  }

  const sig = req.headers.get("stripe-signature") || "";
  const secret = process.env.STRIPE_WEBHOOK_SECRET || "";
  const body = await req.text();

  if (!secret) console.error("[stripe-webhook] STRIPE_WEBHOOK_SECRET is not set - signature cannot be verified.");

  let event;
  try {
    event = stripe.webhooks.constructEvent(body, sig, secret);
  } catch (err: any) {
    console.error(`[stripe-webhook] signature check failed: ${err.message}`);
    return NextResponse.json({ error: `Webhook signature failed: ${err.message}` }, { status: 400 });
  }

  console.log(`[stripe-webhook] received ${event.type}`);

  if (event.type === "checkout.session.completed") {
    const session = event.data.object as any;
    const ref = session?.metadata?.ref as string | undefined;
    const amount = Number(session?.amount_total ?? 0);
    const currency = String(session?.currency ?? "");

    if (!ref) console.error("[stripe-webhook] session has no metadata.ref - cannot match it to a transaction.");

    if (ref) {
      const tx = await prisma.stripeTx.findUnique({ where: { ref } });
      // Say out loud why a payment was skipped, instead of failing silently.
      if (!tx) console.error(`[stripe-webhook] no transaction found for ref ${ref}.`);
      else if (tx.status !== "pending") console.log(`[stripe-webhook] ref ${ref} already handled (status ${tx.status}) - skipping.`);
      else if (currency !== "usd") console.error(`[stripe-webhook] ref ${ref} currency was ${currency}, expected usd - skipping.`);
      else if (amount !== tx.amountCents) console.error(`[stripe-webhook] ref ${ref} amount was ${amount}, expected ${tx.amountCents} - skipping.`);

      // Idempotent + server-side re-check of amount & currency.
      // Claim the transaction with a guarded write. Stripe can deliver the same
      // event twice at the same moment; both would pass the read above, and
      // without this guard both would credit the wallet. Only the delivery
      // whose write actually flips pending -> success carries on.
      const payable = !!tx && tx.status === "pending" && currency === "usd" && amount === tx.amountCents;
      const claimed =
        payable
          ? (
              await prisma.stripeTx.updateMany({
                where: { ref, status: "pending" },
                data: { status: "success", providerId: String(session.id) },
              })
            ).count === 1
          : false;
      if (payable && !claimed) {
        console.log(`[stripe-webhook] ref ${ref} was claimed by a parallel delivery - skipping.`);
      }

      if (tx && claimed) {

        if (tx.purpose === "order" && tx.orderId) {
          const order = await prisma.order.findUnique({ where: { id: tx.orderId } });
          // Card-funded orders get the same turnaround deadline as wallet-funded
          // ones. The clock starts here, when the money is actually held.
          // Buyer-requested sites get none - see payFromWalletAction.
          const listing = order
            ? await prisma.listing.findUnique({ where: { id: order.listingId } })
            : null;

          // Guarded: the decision is made by the write, not by the read above.
          // A wallet payment or a cancel can land between the two, and deciding
          // from the stale read would charge the buyer twice for one order.
          const fundedNow = order
            ? (
                await prisma.order.updateMany({
                  where: { id: tx.orderId, status: "pending_payment" },
                  data: {
                    status: "funded",
                    dueAt: listing?.markupModel === MARKUP_REQUESTED ? null : dueAtFrom(order.turnaroundDays),
                  },
                })
              ).count > 0
            : false;

          // The order was cancelled, already funded, or gone (a deleted listing
          // cascades its orders away) between opening Stripe Checkout and
          // paying. The charge is real, so it becomes wallet balance rather than
          // vanishing - the buyer can spend it on another placement.
          if (!fundedNow) {
            console.error(
              `[stripe-webhook] order ${tx.orderId} was ${order ? order.status : "missing"} and could not be funded - crediting ${tx.amountCents}c to buyer ${tx.userId} as balance instead.`
            );
            await prisma.$transaction([
              prisma.user.update({ where: { id: tx.userId }, data: { balanceCents: { increment: tx.amountCents } } }),
              prisma.walletTx.create({
                data: {
                  userId: tx.userId,
                  kind: "topup",
                  amountCents: tx.amountCents,
                  method: "card",
                  note: `Card payment for order #${tx.orderId}, which was no longer open - added to balance`,
                },
              }),
            ]);
          }

          if (fundedNow && order) {
            // Same reasoning as the deposit branch: the order is funded, so a
            // notification failure must never bubble up and cost us the emails.
            try {
              // The same helper the wallet path uses, so a card-funded order
              // notifies BOTH the publisher and the admin desk, with the same
              // download and confirm links.
              await notifyNewOrder(tx.orderId);
            } catch (e: any) {
              console.error(`[stripe-webhook] order emails failed for order ${tx.orderId}: ${e?.message || e}`);
            }
          }
        } else if (tx.purpose === "topup") {
          // Apply the 5% service fee: only the net amount lands in the wallet.
          const net = netDeposit(tx.amountCents);
          const fee = tx.amountCents - net;
          await prisma.$transaction([
            prisma.user.update({ where: { id: tx.userId }, data: { balanceCents: { increment: net } } }),
            prisma.walletTx.create({
              data: {
                userId: tx.userId,
                kind: "topup",
                amountCents: net,
                method: "stripe",
                note: `Deposit gross ${tx.amountCents} cents, 5% fee ${fee} cents`,
              },
            }),
          ]);
          console.log(`[stripe-webhook] credited ${net} cents to user ${tx.userId}`);
          // The money is already banked at this point. Never let a notification
          // problem - a dropped database connection, a rejected email - throw out
          // of the handler: Stripe would see a 500, retry, find the transaction
          // already marked success, and skip. The emails would be lost for good.
          try {
            if (!emailEnabled()) {
              console.error("[stripe-webhook] email is off - deposit receipt and admin alert were not sent.");
            } else {
              const u = await prisma.user.findUnique({ where: { id: tx.userId } });
              if (!u) {
                console.error(`[stripe-webhook] user ${tx.userId} not found - no deposit emails sent.`);
              } else {
                await sendDepositReceipt(u.email, tx.amountCents, net);
                await sendDepositAdmin(u.email, tx.amountCents, net);
              }
            }
          } catch (e: any) {
            console.error(`[stripe-webhook] deposit emails failed for user ${tx.userId}: ${e?.message || e}`);
          }
        }
      }
    }
  }

  return NextResponse.json({ received: true });
}
