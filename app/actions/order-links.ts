"use server";

// The two publisher steps, reached from the emailed link instead of a session
// (added 8 Oct 2026). The signed link in the form IS the proof of who the
// publisher is; after that the exact same step runs as for the signed-in
// buttons (lib/order-steps.ts), with the same status and ownership checks.
//
// The links open a page and the press happens there, never on the click in
// the email itself. Mail security scanners (Outlook Safe Links, Mimecast,
// Barracuda and others) open every link in an email to check it. If opening
// the link confirmed the order, those scanners would confirm orders nobody had
// read.

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { verifyOrderLink } from "@/lib/order-links";
import { confirmReceiptStep, submitLiveStep } from "@/lib/order-steps";
import { MARKUP_REQUESTED } from "@/lib/money";
import { allow, clientIp, LIMITS, TOO_MANY } from "@/lib/rate-limit";

const q = (s: string) => encodeURIComponent(s);

/** Prove the link, and that it belongs to the order's current publisher. */
async function publisherFromLink(formData: FormData): Promise<{ orderId: number; token: string; publisherId: number }> {
  const orderId = parseInt(String(formData.get("orderId") || "0"));
  const token = String(formData.get("k") || "");
  const back = `/publish/${orderId}?k=${q(token)}`;

  if (!(await allow([[`orderlink:ip:${await clientIp()}`, LIMITS.orderLinkPerIp]]))) {
    redirect(`${back}&error=${q(TOO_MANY)}`);
  }
  const publisherId = verifyOrderLink("publisher", orderId, token);
  if (!publisherId) redirect(`/publish/${orderId}?k=${q(token)}`); // the page explains the expired link

  // The link was issued to whoever owned the listing then. If the listing has
  // since changed hands, or the account is no longer a publisher, it is dead.
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: { listing: { select: { publisherId: true, markupModel: true, publisher: { select: { role: true } } } } },
  });
  if (
    !order ||
    order.listing.publisherId !== publisherId ||
    order.listing.publisher.role !== "publisher" ||
    order.listing.markupModel === MARKUP_REQUESTED
  ) {
    redirect(`${back}&error=${q("This link can no longer be used for this order. Please sign in and open it from Orders.")}`);
  }
  return { orderId, token, publisherId: publisherId! };
}

export async function emailConfirmReceiptAction(formData: FormData) {
  const { orderId, token, publisherId } = await publisherFromLink(formData);
  const res = await confirmReceiptStep(orderId, publisherId);
  console.log(`[order-link] confirm receipt #${orderId} by publisher ${publisherId}: ${res.ok ? "ok" : res.error}`);
  revalidatePath("/orders");
  const back = `/publish/${orderId}?k=${q(token)}`;
  redirect(res.ok ? `${back}&success=${q(res.message)}` : `${back}&error=${q(res.error)}`);
}

export async function emailSubmitLiveAction(formData: FormData) {
  const { orderId, token, publisherId } = await publisherFromLink(formData);
  const res = await submitLiveStep(orderId, publisherId, formData.get("liveUrl"), formData.get("invoiceUrl"));
  console.log(`[order-link] live URL #${orderId} by publisher ${publisherId}: ${res.ok ? "ok" : res.error}`);
  revalidatePath("/orders");
  const back = `/publish/${orderId}?k=${q(token)}`;
  redirect(
    res.ok
      ? `${back}&success=${q("Thank you. The live link has been sent to the buyer and our team. We will email you when the buyer confirms.")}`
      : `${back}&error=${q(res.error)}`
  );
}
