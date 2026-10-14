// The publisher's two steps on an order, confirm receipt and submit the live
// URL, plus the "new order" notification.
//
// They live here, not in app/actions, because two doors lead to them: the
// signed-in order page (app/actions/orders.ts) and the emailed link
// (app/actions/order-links.ts). Both must apply exactly the same checks and
// send exactly the same emails. NOT a "use server" file on purpose: anything
// exported from one of those becomes a public endpoint, and these functions
// trust the publisherId they are given. Callers prove who the publisher is
// first (a session, or a signed link).

import { prisma } from "@/lib/prisma";
import { safeHttpUrl, safeDataUrl, featuredImageHref, DOCUMENT_TYPES } from "@/lib/safe-url";
import { MARKUP_REQUESTED } from "@/lib/money";
import { emailEnabled, sendOrderNotice, sendNewOrderEmails, sendLiveUrlAdmin, sendLiveUrlBuyer, type OrderFileLinks } from "@/lib/email";
import { publisherDeskUrl, orderFileUrl, type OrderLinkScope } from "@/lib/order-links";

export type StepResult = { ok: true; message: string } | { ok: false; error: string };

/** Publisher confirms they received the order: funded -> in_progress. */
export async function confirmReceiptStep(orderId: number, publisherId: number): Promise<StepResult> {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: { listing: true, buyer: true },
  });
  if (!order || order.listing.publisherId !== publisherId) return { ok: false, error: "Not your order." };
  if (order.status !== "funded") return { ok: false, error: "This order can't be confirmed." };

  // Guarded: an unguarded write here could drag an order the sweeper had just
  // cancelled and refunded back into an in-flight status, where the next sweep
  // would refund the buyer a second time.
  const started = await prisma.order.updateMany({
    where: { id: orderId, status: "funded" },
    data: { status: "in_progress" },
  });
  if (started.count === 0) {
    return { ok: false, error: "This order is no longer open - it was cancelled or already moved on." };
  }
  if (emailEnabled() && order.buyer) {
    await sendOrderNotice(
      order.buyer.email,
      "Your order is in progress",
      `The publisher has confirmed your order #${orderId} on ${order.listing.domain} and started work. You'll be notified when the link is live.`
    );
  }
  return { ok: true, message: "Order confirmed. It is now in progress." };
}

/**
 * Publisher submits the live URL: in_progress (or funded) -> live, and the
 * buyer and the admin desk are emailed the link.
 *
 * A publisher on invoice terms holds no payment details on file, so the invoice
 * has to arrive with the link. It is required here rather than chased later:
 * once the buyer confirms, payment is due within 72 hours.
 */
export async function submitLiveStep(
  orderId: number,
  publisherId: number,
  rawLiveUrl: unknown,
  rawInvoiceUrl: unknown
): Promise<StepResult> {
  // Only real http(s) links are ever stored: they are shown as links to the
  // buyer and the admin, and put into emails.
  const liveUrl = safeHttpUrl(rawLiveUrl) || "";
  const invoiceUrl = safeHttpUrl(rawInvoiceUrl) || "";
  const order = await prisma.order.findUnique({ where: { id: orderId }, include: { listing: true, buyer: true } });
  if (!order || order.listing.publisherId !== publisherId) return { ok: false, error: "Not your order." };
  if (!["funded", "in_progress"].includes(order.status)) return { ok: false, error: "Confirm you received the order first." };
  if (!/^https?:\/\//.test(liveUrl)) return { ok: false, error: "Enter a valid live URL." };

  const me = await prisma.user.findUnique({ where: { id: publisherId }, select: { payInvoiceMode: true } });
  if (me?.payInvoiceMode && !/^https?:\/\//.test(invoiceUrl)) {
    return { ok: false, error: "Add the link to your invoice. You chose to invoice for each placement rather than save payment details." };
  }

  // Delivered. Clear the deadline so the sweeper can never cancel an order
  // whose link is already up and waiting on the buyer to look at it. Guarded
  // on the order still being in flight: the sweeper may have cancelled and
  // refunded it since the page was loaded.
  const moved = await prisma.order.updateMany({
    where: { id: orderId, status: { in: ["funded", "in_progress"] } },
    data: { status: "live", liveUrl, dueAt: null, invoiceUrl: invoiceUrl || null },
  });
  if (moved.count === 0) {
    return {
      ok: false,
      error: "This order is no longer open - it was cancelled or already completed. Please contact us before publishing anything further.",
    };
  }
  if (emailEnabled()) {
    if (order.buyer) {
      await sendLiveUrlBuyer({ to: order.buyer.email, orderId, domain: order.listing.domain, liveUrl });
    }
    await sendLiveUrlAdmin(orderId, order.listing.domain, liveUrl);
  }
  return { ok: true, message: "Live URL submitted. Waiting for buyer confirmation." };
}

/**
 * An order was just funded (wallet or card): email the publisher and the admin
 * desk the brief, download links for whatever the buyer sent, and the
 * publisher's no-sign-in link to confirm receipt and later submit the live URL.
 */
export async function notifyNewOrder(orderId: number): Promise<void> {
  if (!emailEnabled()) return;
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: { listing: { include: { publisher: true } }, buyer: true },
  });
  const pub = order?.listing.publisher;
  if (!order || !pub) {
    console.error(`[orders] order ${orderId} has no publisher - no order emails sent.`);
    return;
  }
  const canAct = order.listing.markupModel !== MARKUP_REQUESTED;
  const files = orderFiles(order);
  await sendNewOrderEmails({
    orderId,
    domain: order.listing.domain,
    contentType: order.contentType,
    buyerName: order.buyer?.name,
    publisherEmail: pub.email,
    payoutCents: order.payoutCents,
    turnaroundDays: order.turnaroundDays,
    dueAt: order.dueAt,
    targetUrl: order.targetUrl,
    anchorText: order.anchorText,
    notes: order.notes,
    // Buyer-requested sites have no publisher account behind them: only the
    // buyer can close those out, so the publisher-side buttons are left off.
    deskUrl: canAct ? publisherDeskUrl(orderId, pub.id) : null,
    docName: files.docName,
    publisherFiles: canAct ? fileLinks("publisher", orderId, pub.id, files) : {},
    // The admin desk is not a user: its links are issued to id 0 and can only download.
    adminFiles: fileLinks("file", orderId, 0, files),
  });
}

function fileLinks(
  scope: OrderLinkScope,
  orderId: number,
  userId: number,
  files: { docName: string | null; image: boolean; text: boolean }
): OrderFileLinks {
  return {
    doc: files.docName ? orderFileUrl(scope, orderId, userId, "doc") : undefined,
    image: files.image ? orderFileUrl(scope, orderId, userId, "image") : undefined,
    text: files.text ? orderFileUrl(scope, orderId, userId, "text") : undefined,
  };
}

/** Which downloadable files an order has. Only what passes the same checks as the order page. */
export function orderFiles(order: {
  articleDocUrl: string | null;
  articleDocName: string | null;
  featuredImage: string | null;
  articleContent: string | null;
}): { docName: string | null; image: boolean; text: boolean } {
  return {
    docName: safeDataUrl(order.articleDocUrl, DOCUMENT_TYPES) ? order.articleDocName || "article-document" : null,
    image: !!featuredImageHref(order.featuredImage),
    text: !!(order.articleContent && order.articleContent.trim()),
  };
}
