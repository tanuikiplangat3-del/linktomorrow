// Turnaround enforcement, running inside the app itself.
//
// Same reasoning as lib/metrics-scheduler.ts: no EventBridge rule to create, no
// public endpoint to secure. The container wakes up every few minutes, looks
// for funded orders whose turnaround has run out, cancels them and refunds the
// buyer. Missing a pass is harmless - the next one picks the order up, and the
// refund is the same whenever it happens.
//
// The actual cancel + refund lives in lib/orders.ts and is guarded so two
// passes (or a pass and an admin clicking Cancel at the same moment) can never
// refund one order twice.

import { prisma } from "@/lib/prisma";
import { cancelFundedOrder, CANCELLED_BY_SYSTEM, ORDER_IN_FLIGHT } from "@/lib/orders";
import { MARKUP_REQUESTED } from "@/lib/money";
import { emailEnabled, sendOrderCancelledEmails } from "@/lib/email";

const CHECK_EVERY_MS = 5 * 60 * 1000; // look for expired orders every 5 minutes
const FIRST_RUN_DELAY_MS = 60 * 1000; // let the container finish booting first
const MAX_PER_PASS = 100; // a sane ceiling; the rest wait 5 minutes

let started = false;
let running = false;

export async function cancelExpiredOrders(): Promise<number> {
  const now = new Date();
  const expired = await prisma.order.findMany({
    where: {
      status: { in: ORDER_IN_FLIGHT as unknown as string[] },
      // Orders funded before this feature shipped have no deadline at all.
      // `lt` skips nulls, which is exactly what we want: nothing that predates
      // the countdown is ever auto-cancelled.
      dueAt: { lt: now },
      // Buyer-requested sites are excluded twice over: funding leaves their
      // dueAt null, and this makes sure a stray deadline on one can still never
      // cancel it. Their publisher has no account and cannot submit a live URL,
      // so only the buyer can close the order - a countdown would refund a
      // placement that actually ran.
      listing: { markupModel: { not: MARKUP_REQUESTED } },
    },
    include: { listing: { include: { publisher: true } }, buyer: true },
    orderBy: { dueAt: "asc" },
    take: MAX_PER_PASS,
  });

  let cancelled = 0;
  for (const order of expired) {
    const days = order.turnaroundDays;
    const reason = `Turnaround time of ${days} day${days === 1 ? "" : "s"} expired before the link went live.`;
    const res = await cancelFundedOrder(order.id, { by: CANCELLED_BY_SYSTEM, reason, dueBefore: now });
    if (!res) continue; // someone else cancelled it first, or an admin extended it
    cancelled++;
    console.log(
      `[orders] auto-cancelled #${order.id} (${order.listing.domain}) - turnaround expired, refunded ${res.refundedCents}c`
    );
    if (emailEnabled()) {
      try {
        await sendOrderCancelledEmails({
          buyerEmail: order.buyer?.email,
          publisherEmail: order.listing.publisher?.email,
          domain: order.listing.domain,
          orderId: order.id,
          refundedCents: res.refundedCents,
          by: CANCELLED_BY_SYSTEM,
          reason,
        });
      } catch (e: any) {
        // The money is already back. A failed email must never undo that or
        // stop the rest of the batch.
        console.error(`[orders] cancellation email for #${order.id} failed: ${e?.message || e}`);
      }
    }
  }
  return cancelled;
}

async function runOnce() {
  if (running) return; // never let two passes overlap
  running = true;
  try {
    const n = await cancelExpiredOrders();
    if (n > 0) console.log(`[orders] turnaround sweep: ${n} order(s) auto-cancelled and refunded`);
  } catch (e: any) {
    console.error("[orders] turnaround sweep failed:", e?.message || e);
  } finally {
    running = false;
  }
}

/** Called once from instrumentation.ts when the server process starts. */
export function startOrderScheduler() {
  if (started) return;
  started = true;
  setTimeout(runOnce, FIRST_RUN_DELAY_MS).unref?.();
  setInterval(runOnce, CHECK_EVERY_MS).unref?.();
  console.log("[orders] turnaround auto-cancel scheduler started");
}
