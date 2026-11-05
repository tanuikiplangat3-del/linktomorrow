import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { requireRole } from "@/lib/auth";
import { money } from "@/lib/money";
import { StatusBadge, Flash } from "@/components/ui";
import { markPublisherPaidAction } from "@/app/actions/admin";
import { adminConfirmLiveAction } from "@/app/actions/orders";
import Countdown from "@/components/Countdown";
import ExtendOrderForm from "@/components/ExtendOrderForm";
import { ENDING_SOON_MS } from "@/lib/orders";

export const metadata = { title: "Orders" };

export default async function AdminOrders(
  props: { searchParams: Promise<{ [key: string]: string | string[] | undefined }> }
) {
  const searchParams = await props.searchParams;
  await requireRole("admin");

  const [toPay, inProgress] = await Promise.all([
    prisma.order.findMany({
      where: { publisherPaid: false, status: { in: ["live", "completed"] } },
      include: { listing: { include: { publisher: true } }, buyer: true },
      orderBy: { createdAt: "asc" },
    }),
    prisma.order.findMany({
      where: { status: { in: ["funded", "in_progress"] } },
      include: { listing: { include: { publisher: true } }, buyer: true },
      orderBy: { createdAt: "asc" },
    }),
  ]);

  const owed = toPay.reduce((s, o) => s + o.payoutCents, 0);

  // Orders the turnaround sweeper will cancel within two days (or is about to:
  // it runs every five minutes, so one can sit briefly overdue). Shown first so
  // an admin can give the publisher more time before the money goes back.
  const soonCutoff = Date.now() + ENDING_SOON_MS;
  const endingSoon = inProgress
    .filter((o) => o.dueAt && o.dueAt.getTime() < soonCutoff)
    .sort((a, b) => a.dueAt!.getTime() - b.dueAt!.getTime());

  return (
    <div>
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <h1 className="h2">Orders</h1>
        <Link href="/admin/payments" className="btn-ghost btn-sm">Payment history →</Link>
      </div>
      <Flash searchParams={searchParams} />

      {/* About to auto-cancel */}
      {endingSoon.length > 0 && (
        <div className="mb-10">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
            <h2 className="h3">About to be cancelled</h2>
            <span className="badge badge-yellow">{endingSoon.length} with under 48 hours left</span>
          </div>
          <p className="muted -mt-2 mb-4 max-w-2xl text-sm">
            When the countdown reaches zero the order is cancelled and the buyer refunded
            automatically. To give the publisher more time, add days here. The publisher and the
            buyer are emailed the new date.
          </p>
          <div className="card overflow-x-auto border-wt-yellow/40">
            <table className="table-wt">
              <thead>
                <tr><th>#</th><th>Site</th><th>Buyer</th><th>Publisher</th><th>Amount</th><th>Time left</th><th>Give more time</th></tr>
              </thead>
              <tbody>
                {endingSoon.map((o) => (
                  <tr key={o.id}>
                    <td><Link href={`/orders/${o.id}`} className="text-wt-green">{o.id}</Link></td>
                    <td className="font-semibold">{o.listing.domain}</td>
                    <td className="muted">{o.buyer.name}</td>
                    <td className="muted">{o.listing.publisher.name}</td>
                    <td>{money(o.amountCents)}</td>
                    <td className="whitespace-nowrap"><Countdown dueAt={o.dueAt!.toISOString()} /></td>
                    <td><ExtendOrderForm orderId={o.id} compact /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Orders to be paid */}
      <div className="mb-4 flex items-center justify-between">
        <h2 className="h3">Orders to be paid</h2>
        <span className="muted text-sm">Total owed to publishers: <span className="font-bold text-wt-green">{money(owed)}</span></span>
      </div>
      {toPay.length === 0 ? (
        <div className="card muted mb-10">Nothing to pay right now.</div>
      ) : (
        <div className="card mb-10 overflow-x-auto">
          <table className="table-wt">
            <thead>
              <tr><th>#</th><th>Site</th><th>Buyer</th><th>Publisher</th><th>Payout</th><th>Status</th><th></th></tr>
            </thead>
            <tbody>
              {toPay.map((o) => (
                <tr key={o.id}>
                  <td><Link href={`/orders/${o.id}`} className="text-wt-green">{o.id}</Link></td>
                  <td className="font-semibold">
                    {o.listing.domain}
                    {o.contentType === "pr_article" && <span className="badge badge-yellow ml-2 align-middle">PR</span>}
                  </td>
                  <td className="muted">{o.buyer.name}</td>
                  <td>
                    <Link href={`/admin/users/${o.listing.publisherId}`} className="text-wt-green hover:underline">
                      {o.listing.publisher.name}
                    </Link>
                    <span className="muted block text-xs">view payment details</span>
                  </td>
                  <td className="font-bold text-wt-green">{money(o.payoutCents)}</td>
                  <td><StatusBadge status={o.status} /></td>
                  <td>
                    <div className="flex flex-wrap gap-2">
                      {o.status === "live" && (
                        <form action={adminConfirmLiveAction}>
                          <input type="hidden" name="orderId" value={o.id} />
                          <button className="btn-ghost btn-sm" type="submit">Confirm live</button>
                        </form>
                      )}
                      {o.withdrawalId ? (
                        <Link href="/admin/withdrawals" className="btn-accent btn-sm">In withdrawal #{o.withdrawalId}</Link>
                      ) : (
                        <form action={markPublisherPaidAction}>
                          <input type="hidden" name="orderId" value={o.id} />
                          <button className="btn-primary btn-sm" type="submit">Mark paid</button>
                        </form>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Orders in progress */}
      <h2 className="h3 mb-4">Orders in progress</h2>
      {inProgress.length === 0 ? (
        <div className="card muted">No orders in progress.</div>
      ) : (
        <div className="card overflow-x-auto">
          <table className="table-wt">
            <thead>
              <tr><th>#</th><th>Site</th><th>Buyer</th><th>Publisher</th><th>Amount</th><th>Turnaround left</th><th>Status</th><th>Give more time</th><th></th></tr>
            </thead>
            <tbody>
              {inProgress.map((o) => (
                <tr key={o.id}>
                  <td><Link href={`/orders/${o.id}`} className="text-wt-green">{o.id}</Link></td>
                  <td className="font-semibold">
                    {o.listing.domain}
                    {o.contentType === "pr_article" && <span className="badge badge-yellow ml-2 align-middle">PR</span>}
                  </td>
                  <td className="muted">{o.buyer.name}</td>
                  <td className="muted">{o.listing.publisher.name}</td>
                  <td>{money(o.amountCents)}</td>
                  <td className="whitespace-nowrap">
                    {o.dueAt ? <Countdown dueAt={o.dueAt.toISOString()} /> : <span className="muted">-</span>}
                  </td>
                  <td><StatusBadge status={o.status} /></td>
                  <td>
                    {o.dueAt ? <ExtendOrderForm orderId={o.id} compact /> : <span className="muted text-xs">no deadline</span>}
                  </td>
                  <td><Link href={`/orders/${o.id}`} className="text-wt-green whitespace-nowrap">Open →</Link></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
