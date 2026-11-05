import Link from "next/link";
import { safeDataUrl, featuredImageHref, DOCUMENT_TYPES } from "@/lib/safe-url";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/auth";
import { money } from "@/lib/money";
import { StatusBadge, Flash } from "@/components/ui";
import { payFromWalletAction, payWithStripeAction, submitLiveAction, confirmLiveAction, cancelOrderAction, confirmReceiptAction, buyerSubmitLiveAction, publisherRejectOrderAction, adminCancelOrderAction } from "@/app/actions/orders";
import Countdown from "@/components/Countdown";
import ExtendOrderForm from "@/components/ExtendOrderForm";
import { MARKUP_REQUESTED } from "@/lib/money";
import { stripeEnabled } from "@/lib/stripe";
import { contentTypeLabel } from "@/lib/data";

export default async function OrderPage(
  props: {
    params: Promise<{ id: string }>;
    searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
  }
) {
  const searchParams = await props.searchParams;
  const params = await props.params;
  const user = await requireUser();
  const id = parseInt(params.id);
  const order = await prisma.order.findUnique({
    where: { id },
    include: { listing: { include: { publisher: true } }, buyer: true },
  });
  if (!order) redirect("/orders");

  const isBuyer = order!.buyerId === user.id;
  const isPublisher = order!.listing.publisherId === user.id;
  const isAdmin = user.role === "admin";
  if (!isBuyer && !isPublisher && !isAdmin) redirect("/orders");

  // Buyer-requested sites: the publisher has no account here, so the details we
  // need in order to pay them live on the original request.
  const inFlight = ["funded", "in_progress"].includes(order!.status);
  const isRequested = order!.listing.markupModel === MARKUP_REQUESTED;
  // Only fetched for an admin. It holds the publisher's contact and payout
  // details, so a buyer's page should not even load it.
  const siteRequest = isAdmin && isRequested && order!.listing.siteRequestId
    ? await prisma.siteRequest.findUnique({ where: { id: order!.listing.siteRequestId } })
    : null;
  // Uploaded files and links are only ever linked if they are what they claim
  // to be. A stored value that is anything else (for example a javascript:
  // link planted before this check existed) renders no link at all.
  const docHref = safeDataUrl(order!.articleDocUrl, DOCUMENT_TYPES);
  const imageHref = featuredImageHref(order!.featuredImage);
  // "guest post" / "PR article", for the publisher's reject wording.
  const kindLower = order!.contentType === "pr_article" ? "PR article" : "guest post";
  const PAY_LABEL: Record<string, string> = {
    paypal: "PayPal", bank: "Bank transfer", mpesa: "M-Pesa", other: "Other",
  };

  return (
    <div className="mx-auto max-w-3xl">
      <Link href="/orders" className="muted text-sm">← All orders</Link>
      <div className="mb-6 mt-2 flex items-center justify-between">
        <h1 className="h2">Order #{order!.id}</h1>
        <StatusBadge status={order!.status} />
      </div>
      <Flash searchParams={searchParams} />

      {/* Turnaround countdown. Only while the publisher still owes work: once the
          live URL is in, dueAt is cleared and this disappears. */}
      {inFlight && order!.dueAt && (
        <div className="card mb-5 border-wt-yellow/40">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="muted text-xs">Turnaround remaining</p>
              <Countdown dueAt={order!.dueAt.toISOString()} className="text-2xl" />
            </div>
            <p className="muted max-w-sm text-xs">
              {isPublisher
                ? `Publish the link and submit the live URL before this runs out. When it reaches zero the order is cancelled automatically and the buyer is refunded.`
                : `The publisher has ${order!.turnaroundDays} days to publish. If the link is not live by then, the order cancels itself and ${money(order!.amountCents)} goes back to your balance automatically.`}
            </p>
          </div>
        </div>
      )}

      {/* Admin only. This panel carries the publisher's email, phone and payout
          details, and how we came by the site. None of that is the buyer's to
          see, and the buyer has their own confirmation box further down. */}
      {isRequested && isAdmin && (
        <div className="card mb-5 border-wt-yellow/40">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <h2 className="h3">Requested site</h2>
            <span className="badge badge-yellow">Buyer-negotiated</span>
          </div>
          {siteRequest ? (
            <>
              <p className="muted mb-3 text-sm">
                This publisher was introduced by the buyer and has no account here. Pay them
                directly using the details below.
              </p>
              <dl className="grid grid-cols-1 gap-2 text-sm sm:grid-cols-2">
                <Info label="Site name" value={siteRequest.siteName} />
                <Info label="Turnaround agreed" value={`${siteRequest.tatDays} days`} />
                <Info label="Publisher contact" value={siteRequest.publisherName || "-"} />
                <Info label="Publisher email" value={siteRequest.publisherEmail || "-"} />
                <Info label="Publisher phone" value={siteRequest.publisherPhone || "-"} />
                <Info label="Pay by" value={PAY_LABEL[siteRequest.payMethod] || siteRequest.payMethod} />
                <Info label="Pay to" value={siteRequest.payDetails || "-"} />
                <Info label="VAT" value={siteRequest.vatApplies ? `${siteRequest.vatPercent}% (included in payout)` : "None"} />
                {isAdmin && <Info label="Negotiated price" value={money(siteRequest.negotiatedCents)} />}
                <Info label="Publisher accepted 72h payment" value={siteRequest.agreed72h ? "Yes" : "No"} />
              </dl>
            </>
          ) : (
            <p className="muted text-sm">The original request could not be found.</p>
          )}
        </div>
      )}

      <div className="card mb-5">
        <h2 className="h3 mb-3">Details</h2>
        <dl className="grid grid-cols-1 gap-2 text-sm sm:grid-cols-2">
          <Info label="Site" value={order!.listing.domain} />
          <Info label="Article type" value={contentTypeLabel(order!.contentType)} />
          <Info label={isPublisher ? "Your payout" : "Amount"} value={money(isPublisher ? order!.payoutCents : order!.amountCents)} />
          <Info label="Target URL" value={order!.targetUrl || "-"} />
          <Info label="Anchor text" value={order!.anchorText || "-"} />
          <Info label="Turnaround" value={`${order!.turnaroundDays} days`} />
          {order!.liveUrl && <Info label="Live URL" value={order!.liveUrl} />}
          {isAdmin && order!.invoiceUrl && <Info label="Invoice" value={order!.invoiceUrl} />}
          {isAdmin && <Info label="Buyer" value={order!.buyer.name} />}
          {isAdmin && <Info label="Publisher" value={order!.listing.publisher.name} />}
        </dl>

        {(docHref || imageHref) && (
          <div className="mt-4 flex flex-wrap gap-3">
            {docHref && (
              <a
                href={docHref}
                download={order!.articleDocName || "article-document"}
                className="btn-ghost btn-sm"
              >
                ⬇ Download document{order!.articleDocName ? ` (${order!.articleDocName})` : ""}
              </a>
            )}
            {imageHref && (
              <a href={imageHref} download="featured-image" target="_blank" rel="noopener noreferrer" className="btn-ghost btn-sm">
                ⬇ Download featured image
              </a>
            )}
          </div>
        )}

        {order!.articleContent && (
          <div className="mt-4">
            <p className="muted text-xs">Article / instructions</p>
            <p className="whitespace-pre-wrap text-sm text-white/80">{order!.articleContent}</p>
          </div>
        )}
      </div>

      {/* Actions */}
      {isBuyer && order!.status === "pending_payment" && (
        <div className="card">
          <h2 className="h3 mb-3">Pay to fund this order</h2>
          <p className="muted mb-4 text-sm">Funds are held until the link is live. You pay {money(order!.amountCents)}.</p>
          <div className="flex flex-wrap gap-3">
            <form action={payWithStripeAction}>
              <input type="hidden" name="orderId" value={order!.id} />
              <button className="btn-primary" type="submit" disabled={!stripeEnabled()}>Pay by card</button>
            </form>
            <form action={payFromWalletAction}>
              <input type="hidden" name="orderId" value={order!.id} />
              <button className="btn-ghost" type="submit">Pay from wallet ({money(user.balanceCents)})</button>
            </form>
            <form action={cancelOrderAction}>
              <input type="hidden" name="orderId" value={order!.id} />
              <button className="btn-danger" type="submit">Cancel</button>
            </form>
          </div>
          {!stripeEnabled() && <p className="muted mt-3 text-xs">Please pay from your wallet balance.</p>}
        </div>
      )}

      {isBuyer && inFlight && (
        <div className="card mb-5">
          <h2 className="h3 mb-2">This order is paid for</h2>
          <p className="muted text-sm">
            {money(order!.amountCents)} is being held until the link is live, so this order can no
            longer be cancelled from your side. If the publisher cannot run the post they will
            reject it, and if the turnaround runs out it cancels itself. Either way the money
            returns to your balance automatically. Need it stopped sooner? Email{" "}
            <a className="text-wt-green" href="mailto:hello@welcometomorrow.io">hello@welcometomorrow.io</a>.
          </p>
        </div>
      )}

      {isPublisher && !isRequested && order!.status === "funded" && (
        <div className="card">
          <h2 className="h3 mb-3">Confirm you received this order</h2>
          <p className="muted mb-4 text-sm">Confirm receipt to move this order into progress, then publish the link and submit the live URL.</p>
          <form action={confirmReceiptAction}>
            <input type="hidden" name="orderId" value={order!.id} />
            <button className="btn-primary" type="submit">Confirm receipt</button>
          </form>
        </div>
      )}

      {isPublisher && !isRequested && order!.status === "in_progress" && (
        <div className="card">
          <h2 className="h3 mb-3">Submit the live link</h2>
          <form action={submitLiveAction}>
            <input type="hidden" name="orderId" value={order!.id} />
            <label className="field">
              <span>Live URL where the link is published</span>
              <input className="input" name="liveUrl" placeholder="https://yoursite.com/the-post" required />
            </label>
            {order!.listing.publisher.payInvoiceMode && (
              <label className="field">
                <span>Link to your invoice</span>
                <input className="input" name="invoiceUrl" placeholder="https://drive.google.com/..." required />
                <small className="muted">
                  You chose to invoice for each placement, so we need one with every live link.
                </small>
              </label>
            )}
            <button className="btn-primary" type="submit">Submit live URL</button>
          </form>
        </div>
      )}

      {isPublisher && !isRequested && inFlight && (
        <div className="card mt-5 border-white/10">
          <details>
            <summary className="cursor-pointer list-none text-sm font-semibold text-white/80">
              Can&rsquo;t run this {kindLower}? Reject it &rarr;
            </summary>
            <p className="muted mb-4 mt-3 text-sm">
              Rejecting ends the order and refunds the buyer in full. Please say why. The buyer
              is told your reason, and our team sees it too.
            </p>
            <form action={publisherRejectOrderAction} className="space-y-3">
              <input type="hidden" name="orderId" value={order!.id} />
              <label className="field mb-0">
                <span>Reason for rejecting</span>
                <textarea
                  className="textarea"
                  name="reason"
                  minLength={10}
                  required
                  placeholder="For example: the anchor text is for a niche we do not accept, or the article does not meet our editorial rules."
                />
              </label>
              <button className="btn-danger" type="submit">Reject {kindLower} &amp; refund buyer</button>
            </form>
          </details>
        </div>
      )}

      {isAdmin && inFlight && order!.dueAt && (
        <div className="card mt-5 border-white/10">
          <details>
            <summary className="cursor-pointer list-none text-sm font-semibold text-white/80">
              Admin: give the publisher more time &rarr;
            </summary>
            <p className="muted mb-4 mt-3 text-sm">
              Adds days to the deadline so the order is not cancelled automatically. The publisher
              and the buyer are emailed the new date.
            </p>
            <ExtendOrderForm orderId={order!.id} back="order" />
          </details>
        </div>
      )}

      {isAdmin && inFlight && (
        <div className="card mt-5 border-white/10">
          <details>
            <summary className="cursor-pointer list-none text-sm font-semibold text-white/80">
              Admin: cancel this order &rarr;
            </summary>
            <p className="muted mb-4 mt-3 text-sm">
              Cancels the order and returns {money(order!.amountCents)} to the buyer&rsquo;s balance.
              The reason is emailed to both the buyer and the publisher.
            </p>
            <form action={adminCancelOrderAction} className="space-y-3">
              <input type="hidden" name="orderId" value={order!.id} />
              <label className="field mb-0">
                <span>Reason for cancelling</span>
                <textarea className="textarea" name="reason" minLength={10} required />
              </label>
              <button className="btn-danger" type="submit">Cancel order &amp; refund buyer</button>
            </form>
          </details>
        </div>
      )}

      {isBuyer && isRequested && ["funded", "in_progress", "live"].includes(order!.status) && (
        <div className="card mb-5">
          <h2 className="h3 mb-2">Confirm the placement</h2>
          <p className="muted mb-4 text-sm">
            You arranged this placement directly with the publisher, so please paste the live URL
            once it is published. <strong>We only pay the publisher after you confirm</strong>,
            and payment goes out within 72 hours of your confirmation.
          </p>
          <form action={buyerSubmitLiveAction} className="flex flex-wrap items-end gap-3">
            <input type="hidden" name="orderId" value={order!.id} />
            <label className="field mb-0 flex-1">
              <span>Live URL</span>
              <input className="input" name="liveUrl" placeholder="https://theirsite.com/the-post" required />
            </label>
            <button className="btn-primary" type="submit">Confirm published</button>
          </form>
        </div>
      )}

      {isBuyer && !isRequested && order!.status === "live" && (
        <div className="card">
          <h2 className="h3 mb-3">Confirm the link is live</h2>
          <p className="muted mb-4 text-sm">Check {order!.liveUrl} and confirm to complete the order.</p>
          <form action={confirmLiveAction}>
            <input type="hidden" name="orderId" value={order!.id} />
            <button className="btn-primary" type="submit">Confirm &amp; complete</button>
          </form>
        </div>
      )}

      {order!.status === "completed" && (
        <div className="card flash-success">This order is complete{order!.publisherPaid ? " and the publisher has been paid." : "."}</div>
      )}

      {order!.status === "cancelled" && (
        <div className="card border-wt-red/40">
          <h2 className="h3 mb-2">This order was cancelled</h2>
          <p className="muted text-sm">
            {CANCELLED_LABEL[order!.cancelledBy || ""] || "Cancelled."}
            {order!.cancelledAt ? ` on ${order!.cancelledAt.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" })}` : ""}.
          </p>
          {order!.cancelReason && (
            <p className="mt-3 text-sm text-white/80">
              <span className="muted">Reason: </span>
              {order!.cancelReason}
            </p>
          )}
          {order!.refundedCents > 0 ? (
            <p className="muted mt-3 text-sm">
              {money(order!.refundedCents)} was returned to {isBuyer ? "your" : "the buyer's"} balance.
            </p>
          ) : (
            <p className="muted mt-3 text-sm">Nothing was charged for this order.</p>
          )}
        </div>
      )}
    </div>
  );
}

const CANCELLED_LABEL: Record<string, string> = {
  buyer: "Cancelled by the buyer before payment",
  publisher: "The publisher rejected this guest post",
  admin: "Cancelled by our team",
  system: "Cancelled automatically because the turnaround time ran out",
};

function Info({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="muted text-xs">{label}</dt>
      <dd className="break-words">{value}</dd>
    </div>
  );
}
