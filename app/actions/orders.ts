"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { randomBytes } from "crypto";
import { prisma } from "@/lib/prisma";
import { requireRole, requireUser } from "@/lib/auth";
import { buyerPrice, listingBaseCents, commissionRate, MARKUP_REQUESTED } from "@/lib/money";
import { hasRequesterRate } from "@/lib/requester";
import { isContentType } from "@/lib/data";
import { audit, formSummary } from "@/lib/audit";
import { safeHttpUrl, IMAGE_TYPES, DOCUMENT_TYPES } from "@/lib/safe-url";
import { createCheckout, stripeEnabled } from "@/lib/stripe";
import { emailEnabled, sendOrderNotice, sendLiveUrlAdmin, sendOrderConfirmedEmails, sendOrderCancelledEmails } from "@/lib/email";
import { confirmReceiptStep, submitLiveStep, notifyNewOrder } from "@/lib/order-steps";
import {
  cancelFundedOrder,
  dueAtFrom,
  CANCELLED_BY_ADMIN,
  CANCELLED_BY_BUYER,
  CANCELLED_BY_PUBLISHER,
} from "@/lib/orders";

const q = (s: string) => encodeURIComponent(s);

/** Read an uploaded file into a data URL, capped at maxBytes. Returns "too_big" if over. */
async function readUpload(
  entry: FormDataEntryValue | null,
  maxBytes: number,
  allowedTypes: string[]
): Promise<{ url: string; name: string } | "too_big" | "bad_type" | null> {
  if (!entry || typeof entry === "string") return null;
  const file = entry as File;
  if (!file || file.size === 0) return null;
  if (file.size > maxBytes) return "too_big";
  // The type is what the browser says, so it is only a first filter; the real
  // protection is that uploads are only ever offered as downloads of these
  // types (see lib/safe-url.ts), never opened as a page on our site.
  const mime = (file.type || "").toLowerCase();
  if (!allowedTypes.includes(mime)) return "bad_type";
  const buf = Buffer.from(await file.arrayBuffer());
  const name = String(file.name || "file").replace(/[^\w.\- ]+/g, "_").slice(0, 120);
  return { url: `data:${mime};base64,${buf.toString("base64")}`, name };
}

export async function placeOrderAction(formData: FormData) {
  const user = await requireRole("buyer");
  const listingId = parseInt(String(formData.get("listingId") || "0"));
  const listing = await prisma.listing.findUnique({ where: { id: listingId } });
  if (!listing || listing.status !== "approved") {
    redirect(`/marketplace?error=${q("That listing is not available.")}`);
  }
  // A demo buyer can only order demo inventory, and a real buyer can never
  // order a demo site. Checked here because this is where money moves, not just
  // on the page that showed the button.
  if (listing!.isDemo !== !!user.isDemo) {
    redirect(`/marketplace?error=${q("That listing is not available.")}`);
  }

  // Turnaround: only 5, 7 or 10 days are offered.
  let tat = parseInt(String(formData.get("turnaroundDays") || "7"));
  if (![5, 7, 10].includes(tat)) tat = 7;

  // Guest post or PR article. Anything unexpected falls back to a guest post,
  // which is what every order was before the choice existed.
  const rawType = String(formData.get("contentType") || "guest_post");
  const contentType = isContentType(rawType) ? rawType : "guest_post";

  // Optional uploads (image up to 4MB, document up to 6MB), stored as data URLs.
  const doc = await readUpload(formData.get("articleDoc"), 6 * 1024 * 1024, DOCUMENT_TYPES);
  if (doc === "too_big") redirect(`/listing/${listingId}?error=${q("Your document is larger than 6MB. Please upload a smaller file.")}`);
  if (doc === "bad_type") redirect(`/listing/${listingId}?error=${q("The article must be a Word document, PDF, RTF or plain text file.")}`);
  const img = await readUpload(formData.get("featuredImageFile"), 4 * 1024 * 1024, IMAGE_TYPES);
  if (img === "too_big") redirect(`/listing/${listingId}?error=${q("Your image is larger than 4MB. Please upload a smaller image.")}`);
  if (img === "bad_type") redirect(`/listing/${listingId}?error=${q("The featured image must be a PNG, JPEG, WebP or GIF.")}`);

  // Requested sites are priced per buyer: the buyer who negotiated the deal pays
  // half the normal margin for their first few orders, everyone else pays the
  // standard margin. VAT (if any) is added on top and passed to the publisher.
  // This is the call that actually takes money, so the allowance is checked here
  // rather than trusted from whatever page the buyer came from.
  const amount = buyerPrice(listing!.priceCents, listing!.markupModel, {
    vatPercent: listing!.vatPercent,
    requesterRate: await hasRequesterRate(user.id, listing!),
  });
  const payout = listingBaseCents(listing!.priceCents, listing!.vatPercent);
  const order = await prisma.order.create({
    data: {
      buyerId: user.id,
      listingId: listing!.id,
      targetUrl: String(formData.get("targetUrl") || "").trim(),
      anchorText: String(formData.get("anchorText") || "").trim(),
      notes: String(formData.get("notes") || "").trim(),
      articleContent: String(formData.get("articleContent") || "").trim(),
      // An uploaded image, or else an https link to one. Nothing else is stored:
      // this value becomes a link on the publisher's and the admin's screen.
      featuredImage: img ? img.url : safeHttpUrl(formData.get("featuredImage")) || "",
      articleDocName: doc ? doc.name : null,
      articleDocUrl: doc ? doc.url : null,
      turnaroundDays: tat,
      contentType,
      amountCents: amount,
      payoutCents: payout,
      commissionRate: String(commissionRate()),
      status: "pending_payment",
    },
  });
  redirect(`/orders/${order.id}?success=${q("Order created. Complete payment to fund it.")}`);
}

/** Pay for an order from wallet balance (instant). */
export async function payFromWalletAction(formData: FormData) {
  const user = await requireRole("buyer");
  const orderId = parseInt(String(formData.get("orderId") || "0"));
  const order = await prisma.order.findUnique({ where: { id: orderId } });
  if (!order || order.buyerId !== user.id || order.status !== "pending_payment") {
    redirect(`/orders?error=${q("Order not payable.")}`);
  }
  const fresh = await prisma.user.findUnique({ where: { id: user.id } });
  if ((fresh?.balanceCents ?? 0) < order!.amountCents) {
    redirect(`/orders/${orderId}?error=${q("Not enough wallet balance. Top up or pay by card.")}`);
  }
  // That check is only a fast, friendly answer. The one that counts is the
  // conditional decrement inside the transaction below - two different orders
  // paid from the same wallet at the same instant would both pass this one and
  // drive the balance negative.
  // The turnaround clock starts the moment the money is held, not when the
  // order was created - an unpaid order can sit for days and that time is not
  // the publisher's to lose.
  //
  // Buyer-requested sites get NO deadline. Their publisher has no account here
  // and cannot submit a live URL, so only the buyer can ever close the order
  // out; a countdown would cancel and refund a placement that actually ran.
  const listing = await prisma.listing.findUnique({ where: { id: order!.listingId } });
  const dueAt = listing?.markupModel === MARKUP_REQUESTED ? null : dueAtFrom(order!.turnaroundDays);

  // The status change is an updateMany guarded on the order still being unpaid,
  // inside the transaction. Two submits landing together would otherwise both
  // read "pending_payment" and both decrement the balance.
  const funded = await prisma.$transaction(async (tx) => {
    const changed = await tx.order.updateMany({
      where: { id: orderId, status: "pending_payment" },
      data: { status: "funded", dueAt },
    });
    if (changed.count === 0) return "gone";
    // Conditional decrement: the balance is only taken if it is still there.
    // A plain decrement would let two simultaneous payments from one wallet
    // both succeed and leave the buyer on a negative balance.
    const paid = await tx.user.updateMany({
      where: { id: user.id, balanceCents: { gte: order!.amountCents } },
      data: { balanceCents: { decrement: order!.amountCents } },
    });
    if (paid.count === 0) throw new Error("INSUFFICIENT_BALANCE");
    await tx.walletTx.create({ data: { userId: user.id, kind: "spend", amountCents: order!.amountCents, note: `Order #${orderId}` } });
    return "ok";
  }).catch((e: any) => {
    // The throw rolls the status change back with it, so the order is still
    // payable and nothing was taken.
    if (String(e?.message).includes("INSUFFICIENT_BALANCE")) return "broke";
    throw e;
  });
  if (funded === "gone") redirect(`/orders/${orderId}?error=${q("That order has already been paid for or cancelled.")}`);
  if (funded === "broke") redirect(`/orders/${orderId}?error=${q("Not enough wallet balance - another payment may have just gone through. Top up or pay by card.")}`);
  // The money has moved. A mail failure must not show the buyer an error page
  // for a payment that went through.
  try {
    await notifyNewOrder(orderId);
  } catch (e: any) {
    console.error(`[orders] new-order emails for #${orderId} failed: ${e?.message || e}`);
  }
  revalidatePath("/orders");
  redirect(`/orders/${orderId}?success=${q("Order funded from your balance.")}`);
}

/** Start a Stripe Checkout for an order. */
export async function payWithStripeAction(formData: FormData) {
  const user = await requireRole("buyer");
  const orderId = parseInt(String(formData.get("orderId") || "0"));
  const order = await prisma.order.findUnique({ where: { id: orderId }, include: { listing: true } });
  if (!order || order.buyerId !== user.id || order.status !== "pending_payment") {
    redirect(`/orders?error=${q("Order not payable.")}`);
  }
  if (!stripeEnabled()) {
    redirect(`/orders/${orderId}?error=${q("Card payments are unavailable right now. Please pay from your wallet balance.")}`);
  }
  const ref = "ord_" + randomBytes(10).toString("hex");
  await prisma.stripeTx.create({
    data: { ref, userId: user.id, purpose: "order", orderId, amountCents: order!.amountCents, status: "pending" },
  });
  const url = await createCheckout({
    amountCents: order!.amountCents,
    label: `Link placement on ${order!.listing.domain} (Order #${orderId})`,
    purpose: "order",
    ref,
    orderId,
    customerEmail: user.email,
  });
  redirect(url);
}

/**
 * Publisher submits the live URL.
 *
 * A publisher on invoice terms holds no payment details on file, so the invoice
 * has to arrive with the link. It is required here rather than chased later:
 * once the buyer confirms, payment is due within 72 hours and there is no time
 * to go looking for it.
 */
export async function submitLiveAction(formData: FormData) {
  const user = await requireRole("publisher");
  const orderId = parseInt(String(formData.get("orderId") || "0"));
  // The checks, the guarded write and the emails are shared with the emailed
  // link (app/actions/order-links.ts) so both doors behave the same.
  const res = await submitLiveStep(orderId, user.id, formData.get("liveUrl"), formData.get("invoiceUrl"));
  if (!res.ok) {
    if (res.error === "Not your order.") redirect(`/orders?error=${q(res.error)}`);
    redirect(`/orders/${orderId}?error=${q(res.error)}`);
  }
  revalidatePath("/orders");
  redirect(`/orders/${orderId}?success=${q(res.message)}`);
}

/**
 * Buyer-requested sites have no publisher account to submit a live URL, so the
 * BUYER supplies it and confirms publication themselves. That confirmation is
 * what tells the admin the placement really happened - without it there is no
 * live URL on the order and the publisher does not get paid.
 */
export async function buyerSubmitLiveAction(formData: FormData) {
  const user = await requireRole("buyer");
  const orderId = parseInt(String(formData.get("orderId") || "0"));
  const liveUrl = safeHttpUrl(formData.get("liveUrl")) || "";
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: { listing: true },
  });
  if (!order || order.buyerId !== user.id) redirect(`/orders?error=${q("Not your order.")}`);
  if (order!.listing.markupModel !== MARKUP_REQUESTED)
    redirect(`/orders/${orderId}?error=${q("Only sites you requested are confirmed this way.")}`);
  if (!["funded", "in_progress", "live"].includes(order!.status))
    redirect(`/orders/${orderId}?error=${q("Fund the order before confirming the placement.")}`);
  if (!/^https?:\/\//.test(liveUrl))
    redirect(`/orders/${orderId}?error=${q("Enter the full live URL, starting with https://")}`);

  const closed = await prisma.order.updateMany({
    where: { id: orderId, status: { in: ["funded", "in_progress", "live"] } },
    data: { status: "completed", liveUrl, dueAt: null },
  });
  if (closed.count === 0) {
    redirect(`/orders/${orderId}?error=${q("This order is no longer open - it was cancelled or already completed.")}`);
  }
  if (emailEnabled()) {
    await sendLiveUrlAdmin(orderId, order!.listing.domain, liveUrl, true);
  }
  await notifyOrderConfirmed(orderId);
  revalidatePath("/orders");
  redirect(`/orders/${orderId}?success=${q("Thanks - the placement is confirmed and we will pay the publisher within 72 hours.")}`);
}

/** Buyer confirms the link is live -> completed. */
export async function confirmLiveAction(formData: FormData) {
  const user = await requireRole("buyer");
  const orderId = parseInt(String(formData.get("orderId") || "0"));
  const order = await prisma.order.findUnique({ where: { id: orderId } });
  if (!order || order.buyerId !== user.id || order.status !== "live") redirect(`/orders?error=${q("Cannot confirm this order.")}`);
  const done = await prisma.order.updateMany({ where: { id: orderId, status: "live" }, data: { status: "completed" } });
  if (done.count === 0) redirect(`/orders/${orderId}?error=${q("This order is no longer awaiting your confirmation.")}`);
  await notifyOrderConfirmed(orderId);
  revalidatePath("/orders");
  redirect(`/orders/${orderId}?success=${q("Order completed. Thank you!")}`);
}

/** Admin confirms the link is live on the buyer's behalf -> completed. */
export async function adminConfirmLiveAction(formData: FormData) {
  const user = await requireUser();
  if (user.role !== "admin") redirect(`/orders?error=${q("Admins only.")}`);
  await audit(user, "adminConfirmLiveAction", null, formSummary(formData));
  const orderId = parseInt(String(formData.get("orderId") || "0"));
  const order = await prisma.order.findUnique({ where: { id: orderId }, include: { buyer: true } });
  if (!order || order.status !== "live") redirect(`/admin/orders?error=${q("Order is not awaiting confirmation.")}`);
  const done = await prisma.order.updateMany({ where: { id: orderId, status: "live" }, data: { status: "completed" } });
  if (done.count === 0) redirect(`/admin/orders?error=${q("Order is not awaiting confirmation.")}`);
  if (emailEnabled() && order!.buyer) {
    await sendOrderNotice(order!.buyer.email, "Your order is complete", `Order #${orderId} has been confirmed live and marked complete.`);
  }
  await notifyOrderConfirmed(orderId);
  revalidatePath("/admin/orders");
  redirect(`/admin/orders?success=${q("Order confirmed live.")}`);
}

/**
 * Cancel an order that has NOT been paid for yet.
 *
 * This is the only cancellation a buyer may make. The moment they fund an
 * order the money is held and the publisher starts work, so from then on it is
 * the publisher's to reject and the admin's to cancel - see the two actions
 * below. Nothing is refunded here because nothing was ever taken.
 */
export async function cancelOrderAction(formData: FormData) {
  const user = await requireUser();
  const orderId = parseInt(String(formData.get("orderId") || "0"));
  const order = await prisma.order.findUnique({ where: { id: orderId } });
  if (!order) redirect(`/orders?error=${q("Order not found.")}`);
  if (user.role === "admin") await audit(user, "cancelOrderAction", null, formSummary(formData));
  if (order.buyerId !== user.id && user.role !== "admin") {
    redirect(`/orders/${orderId}?error=${q("This is not your order.")}`);
  }
  if (order.status !== "pending_payment") {
    redirect(
      `/orders/${orderId}?error=${q(
        "This order has already been paid for, so it can no longer be cancelled here. The publisher can reject it, or contact us and we will cancel it for you."
      )}`
    );
  }
  // Guarded on the order still being unpaid. A card payment can land between
  // the page loading and this click; without the guard the cancel would write
  // straight over a funded order and the buyer would be charged for nothing.
  const cancelled = await prisma.order.updateMany({
    where: { id: orderId, status: "pending_payment" },
    data: {
      status: "cancelled",
      cancelledBy: user.role === "admin" ? CANCELLED_BY_ADMIN : CANCELLED_BY_BUYER,
      cancelledAt: new Date(),
      cancelReason: "Cancelled before payment.",
    },
  });
  if (cancelled.count === 0) {
    redirect(`/orders/${orderId}?error=${q("Your payment came through just now, so this order is already funded and can no longer be cancelled here.")}`);
  }
  revalidatePath("/orders");
  redirect(`/orders/${orderId}?success=${q("Order cancelled. Nothing was charged.")}`);
}

/**
 * The publisher rejects the guest post. This is their way out of an order they
 * cannot or will not fulfil, and it is the reason the buyer no longer has a
 * cancel button: somebody has to be able to end a funded order, and it should
 * be the side that knows whether the post can run.
 *
 * The held amount goes straight back onto the buyer's balance.
 */
export async function publisherRejectOrderAction(formData: FormData) {
  const user = await requireRole("publisher");
  const orderId = parseInt(String(formData.get("orderId") || "0"));
  const reason = String(formData.get("reason") || "").trim();
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: { listing: { include: { publisher: true } }, buyer: true },
  });
  if (!order || order.listing.publisherId !== user.id) redirect(`/orders?error=${q("Not your order.")}`);
  if (!["funded", "in_progress"].includes(order!.status)) {
    redirect(`/orders/${orderId}?error=${q("This order can no longer be rejected.")}`);
  }
  // A reason is not optional. The buyer is losing a placement they paid for and
  // is owed an explanation, and without one the admin desk cannot tell a bad
  // fit from a publisher quietly walking away from every order.
  if (reason.length < 10) {
    redirect(`/orders/${orderId}?error=${q("Please write a short reason (at least 10 characters) so we can tell the buyer why.")}`);
  }

  const res = await cancelFundedOrder(orderId, { by: CANCELLED_BY_PUBLISHER, reason });
  if (!res) redirect(`/orders/${orderId}?error=${q("This order has already been cancelled or completed.")}`);

  // The refund is already committed. A mail failure must never throw here, or
  // the publisher sees an error page for an action that actually succeeded and
  // retrying just tells them it was already cancelled.
  if (emailEnabled()) {
    try {
      await sendOrderCancelledEmails({
        buyerEmail: order!.buyer?.email,
        publisherEmail: order!.listing.publisher?.email,
        domain: order!.listing.domain,
        orderId,
        refundedCents: res!.refundedCents,
        by: CANCELLED_BY_PUBLISHER,
        reason,
      });
    } catch (e: any) {
      console.error(`[orders] rejection email for #${orderId} failed: ${e?.message || e}`);
    }
  }
  revalidatePath("/orders");
  redirect(`/orders/${orderId}?success=${q("Guest post rejected. The buyer has been refunded and told why.")}`);
}

/** Admin cancels a funded order, with a reason. Refunds the buyer's balance. */
export async function adminCancelOrderAction(formData: FormData) {
  const user = await requireUser();
  if (user.role !== "admin") redirect(`/orders?error=${q("Admins only.")}`);
  await audit(user, "adminCancelOrderAction", null, formSummary(formData));
  const orderId = parseInt(String(formData.get("orderId") || "0"));
  const reason = String(formData.get("reason") || "").trim();
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: { listing: { include: { publisher: true } }, buyer: true },
  });
  if (!order) redirect(`/admin/orders?error=${q("Order not found.")}`);
  if (!["funded", "in_progress"].includes(order!.status)) {
    redirect(`/orders/${orderId}?error=${q("Only a funded or in-progress order can be cancelled this way.")}`);
  }
  if (reason.length < 10) {
    redirect(`/orders/${orderId}?error=${q("Please write a short reason (at least 10 characters). It is sent to the buyer and the publisher.")}`);
  }

  const res = await cancelFundedOrder(orderId, { by: CANCELLED_BY_ADMIN, reason });
  if (!res) redirect(`/orders/${orderId}?error=${q("This order has already been cancelled or completed.")}`);

  if (emailEnabled()) {
    try {
      await sendOrderCancelledEmails({
        buyerEmail: order!.buyer?.email,
        publisherEmail: order!.listing.publisher?.email,
        domain: order!.listing.domain,
        orderId,
        refundedCents: res!.refundedCents,
        by: CANCELLED_BY_ADMIN,
        reason,
      });
    } catch (e: any) {
      console.error(`[orders] admin cancellation email for #${orderId} failed: ${e?.message || e}`);
    }
  }
  revalidatePath("/admin/orders");
  revalidatePath("/orders");
  redirect(`/orders/${orderId}?success=${q(`Order cancelled and ${res!.refundedCents / 100} USD refunded to the buyer's balance.`)}`);
}

/** Order completed -> tell the publisher and the admin desk (starts the 72h clock). */
async function notifyOrderConfirmed(orderId: number) {
  if (!emailEnabled()) return;
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: { listing: { include: { publisher: true } } },
  });
  const pub = order?.listing.publisher;
  if (pub) {
    await sendOrderConfirmedEmails({
      publisherEmail: pub.email,
      domain: order!.listing.domain,
      orderId,
      payoutCents: order!.payoutCents,
    });
  }
}

/** Publisher confirms they received the order -> status moves to in progress. */
export async function confirmReceiptAction(formData: FormData) {
  const user = await requireRole("publisher");
  const orderId = parseInt(String(formData.get("orderId") || "0"));
  // Shared with the emailed link, see submitLiveAction.
  const res = await confirmReceiptStep(orderId, user.id);
  if (!res.ok) {
    if (res.error === "Not your order.") redirect(`/orders?error=${q(res.error)}`);
    redirect(`/orders/${orderId}?error=${q(res.error)}`);
  }
  revalidatePath("/orders");
  redirect(`/orders/${orderId}?success=${q(res.message)}`);
}
