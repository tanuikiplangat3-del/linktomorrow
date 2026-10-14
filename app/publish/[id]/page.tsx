// The publisher's order page, opened from the "new order" email without
// signing in (added 8 Oct 2026). Access is the signed link in ?k=, checked by
// lib/order-links.ts. It shows the brief and the files, and offers the next
// step for the order's status: confirm receipt, then submit the live URL.
//
// It deliberately shows less than the signed-in order page: no buyer details,
// no reject or cancel. Those stay behind a sign-in.

import type { Metadata } from "next";
import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { money, MARKUP_REQUESTED } from "@/lib/money";
import { contentTypeLabel } from "@/lib/data";
import { verifyOrderLink, orderFileUrlWithToken } from "@/lib/order-links";
import { orderFiles } from "@/lib/order-steps";
import { hrefOrNone } from "@/lib/safe-url";
import { StatusBadge, Flash } from "@/components/ui";
import Countdown from "@/components/Countdown";
import { emailConfirmReceiptAction, emailSubmitLiveAction } from "@/app/actions/order-links";

export const metadata: Metadata = {
  title: "Your order",
  robots: { index: false, follow: false },
};
export const dynamic = "force-dynamic";

export default async function PublisherOrderLinkPage(props: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const params = await props.params;
  const searchParams = await props.searchParams;
  const orderId = parseInt(params.id, 10);
  const token = typeof searchParams.k === "string" ? searchParams.k : "";
  const publisherId = verifyOrderLink("publisher", orderId, token);

  const order = publisherId
    ? await prisma.order.findUnique({
        where: { id: orderId },
        include: { listing: { include: { publisher: { select: { id: true, role: true, payInvoiceMode: true } } } } },
      })
    : null;

  const valid =
    !!order &&
    order.listing.publisherId === publisherId &&
    order.listing.publisher.role === "publisher" &&
    order.listing.markupModel !== MARKUP_REQUESTED;

  if (!valid) {
    return (
      <div className="mx-auto max-w-xl">
        <div className="card">
          <h1 className="h3 mb-3">This link has expired</h1>
          <p className="muted mb-5 text-sm">
            Order links from our emails work for 30 days and only for the publisher they were sent
            to. Sign in to see this order and everything else on your account.
          </p>
          <Link href={Number.isFinite(orderId) ? `/orders/${orderId}` : "/orders"} className="btn-primary">
            Sign in
          </Link>
        </div>
      </div>
    );
  }

  const o = order!;
  const files = orderFiles(o);
  const inFlight = ["funded", "in_progress"].includes(o.status);
  const target = hrefOrNone(o.targetUrl);
  const live = hrefOrNone(o.liveUrl);

  return (
    <div className="mx-auto max-w-3xl">
      <div className="mb-6 flex items-center justify-between gap-3">
        <div>
          <p className="muted text-sm">{o.listing.domain}</p>
          <h1 className="h2">Order #{o.id}</h1>
        </div>
        <StatusBadge status={o.status} />
      </div>
      <Flash searchParams={searchParams} />

      {inFlight && o.dueAt && (
        <div className="card mb-5 border-wt-yellow/40">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="muted text-xs">Turnaround remaining</p>
              <Countdown dueAt={o.dueAt.toISOString()} className="text-2xl" />
            </div>
            <p className="muted max-w-sm text-xs">
              Publish the link and submit the live URL before this runs out. When it reaches zero the
              order is cancelled automatically and the buyer is refunded.
            </p>
          </div>
        </div>
      )}

      {/* The next step comes first: it is why the publisher clicked. */}
      {o.status === "funded" && (
        <div className="card mb-5 border-wt-green/50">
          <h2 className="h3 mb-2">Confirm you received this order</h2>
          <p className="muted mb-4 text-sm">
            One press moves the order into progress and tells the buyer you have started. Then publish
            the article and come back to this page to submit the live URL.
          </p>
          <form action={emailConfirmReceiptAction}>
            <input type="hidden" name="orderId" value={o.id} />
            <input type="hidden" name="k" value={token} />
            <button className="btn-primary" type="submit" autoFocus>Confirm receipt</button>
          </form>
        </div>
      )}

      {o.status === "in_progress" && (
        <div className="card mb-5 border-wt-green/50">
          <h2 className="h3 mb-3">Submit the live link</h2>
          <form action={emailSubmitLiveAction}>
            <input type="hidden" name="orderId" value={o.id} />
            <input type="hidden" name="k" value={token} />
            <label className="field">
              <span>Live URL where the article is published</span>
              <input className="input" name="liveUrl" type="url" placeholder="https://yoursite.com/the-post" required />
            </label>
            {o.listing.publisher.payInvoiceMode && (
              <label className="field">
                <span>Link to your invoice</span>
                <input className="input" name="invoiceUrl" type="url" placeholder="https://drive.google.com/..." required />
                <small className="muted">You chose to invoice for each placement, so we need one with every live link.</small>
              </label>
            )}
            <button className="btn-primary" type="submit">Submit live URL</button>
          </form>
          <p className="muted mt-3 text-xs">The buyer and our team are emailed the link as soon as you submit it.</p>
        </div>
      )}

      {o.status === "live" && (
        <div className="card mb-5">
          <h2 className="h3 mb-2">Live link submitted</h2>
          <p className="muted text-sm">
            {live ? (
              <a href={live} target="_blank" rel="noopener noreferrer" className="break-all text-white underline">{o.liveUrl}</a>
            ) : (
              o.liveUrl
            )}
          </p>
          <p className="muted mt-3 text-sm">
            Waiting for the buyer to confirm. We will email you when they do, and your payout is then
            ready to withdraw.
          </p>
        </div>
      )}

      {o.status === "completed" && (
        <div className="card flash-success mb-5">
          This order is complete. Sign in and press Withdraw on your dashboard to be paid.
        </div>
      )}

      {o.status === "cancelled" && (
        <div className="card mb-5 border-wt-red/40">
          <h2 className="h3 mb-2">This order was cancelled</h2>
          <p className="muted text-sm">There is nothing more to do on it. Please do not publish anything further.</p>
        </div>
      )}

      <div className="card mb-5">
        <h2 className="h3 mb-3">The brief</h2>
        <dl className="grid grid-cols-1 gap-2 text-sm sm:grid-cols-2">
          <Info label="Site" value={o.listing.domain} />
          <Info label="Article type" value={contentTypeLabel(o.contentType)} />
          <Info label="Your payout" value={money(o.payoutCents)} />
          <Info label="Turnaround" value={`${o.turnaroundDays} days`} />
          <div className="sm:col-span-2">
            <dt className="muted text-xs">Target URL</dt>
            <dd className="break-all">
              {target ? (
                <a href={target} target="_blank" rel="noopener noreferrer" className="text-wt-green">{o.targetUrl}</a>
              ) : (
                o.targetUrl || "-"
              )}
            </dd>
          </div>
          <Info label="Anchor text" value={o.anchorText || "-"} />
        </dl>

        {o.notes && (
          <div className="mt-4">
            <p className="muted text-xs">Notes from the buyer</p>
            <p className="whitespace-pre-wrap text-sm text-white/80">{o.notes}</p>
          </div>
        )}

        {(files.docName || files.image || files.text) ? (
          <div className="mt-4 flex flex-wrap gap-3">
            {files.docName && (
              <a href={orderFileUrlWithToken("publisher", o.id, token, "doc")} className="btn-ghost btn-sm">
                ⬇ Download the article ({files.docName})
              </a>
            )}
            {files.image && (
              <a href={orderFileUrlWithToken("publisher", o.id, token, "image")} className="btn-ghost btn-sm">
                ⬇ Download featured image
              </a>
            )}
            {files.text && (
              <a href={orderFileUrlWithToken("publisher", o.id, token, "text")} className="btn-ghost btn-sm">
                ⬇ Download article text (.txt)
              </a>
            )}
          </div>
        ) : (
          <p className="muted mt-4 text-sm">The buyer did not attach a file. Everything they sent is above.</p>
        )}

        {o.articleContent && (
          <div className="mt-4">
            <p className="muted text-xs">Article / instructions</p>
            <p className="whitespace-pre-wrap text-sm text-white/80">{o.articleContent}</p>
          </div>
        )}
      </div>

      <p className="muted text-xs">
        This page is reached from the link in your order email and needs no sign-in. Please do not
        forward that email. To reject this order, sign in and open it from{" "}
        <Link href={`/orders/${o.id}`} className="text-wt-green">Orders</Link>.
      </p>
    </div>
  );
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="muted text-xs">{label}</dt>
      <dd className="break-all">{value}</dd>
    </div>
  );
}
