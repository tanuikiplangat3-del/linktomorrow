import Link from "next/link";
import { hrefOrNone } from "@/lib/safe-url";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/auth";
import { money } from "@/lib/money";
import { Flash, StatusBadge } from "@/components/ui";
import { publisherBalance } from "@/lib/withdrawals";
import { NOT_CANCELLED, LIST_OMIT } from "@/lib/orders";

export const metadata = { title: "Dashboard" };

export default async function DashboardPage(
  props: {
    searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
  }
) {
  const searchParams = await props.searchParams;
  const user = await requireUser();

  return (
    <div>
      <h1 className="h2 mb-1">Dashboard</h1>
      <p className="muted mb-6">Signed in as {user.name}, {user.role}</p>
      <Flash searchParams={searchParams} />

      {user.role === "buyer" && <BuyerDash userId={user.id} balance={user.balanceCents} />}
      {user.role === "publisher" && <PublisherDash user={user} />}
      {user.role === "admin" && <AdminDash />}
    </div>
  );
}

async function BuyerDash({ userId, balance }: { userId: number; balance: number }) {
  const [total, pending, live, holdAgg, recent] = await Promise.all([
    prisma.order.count({ where: { buyerId: userId, status: NOT_CANCELLED } }),
    prisma.order.count({ where: { buyerId: userId, status: { in: ["pending_payment", "funded", "in_progress"] } } }),
    prisma.order.count({ where: { buyerId: userId, status: { in: ["live", "completed"] } } }),
    prisma.order.aggregate({
      _sum: { amountCents: true },
      where: { buyerId: userId, publisherPaid: false, status: { in: ["funded", "in_progress", "live"] } },
    }),
    prisma.order.findMany({
      where: { buyerId: userId, status: NOT_CANCELLED },
      omit: LIST_OMIT,
      include: { listing: true },
      orderBy: { createdAt: "desc" },
      take: 8,
    }),
  ]);
  const onHold = holdAgg._sum.amountCents || 0;

  return (
    <div>
      <div className="mb-5 grid gap-5 sm:grid-cols-2">
        <Link href="/topup" className="card hover:border-wt-green/50"><p className="muted text-sm">Available balance</p><p className="text-4xl font-bold text-wt-green">{money(balance)}</p><p className="mt-4 text-sm font-semibold text-wt-green">Top up →</p></Link>
        <div className="card"><p className="muted text-sm">On hold (orders being processed)</p><p className="text-4xl font-bold text-wt-yellow">{money(onHold)}</p><p className="muted mt-4 text-xs">Released once you confirm the live link.</p></div>
      </div>
      <div className="grid gap-5 sm:grid-cols-3">
        <Link href="/orders" className="card hover:border-wt-green/50"><p className="muted text-sm">Orders placed</p><p className="text-3xl font-bold">{total}</p><p className="mt-4 text-sm font-semibold text-wt-green">View all →</p></Link>
        <Link href="/orders?f=pending" className="card hover:border-wt-green/50"><p className="muted text-sm">Pending</p><p className="text-3xl font-bold text-wt-yellow">{pending}</p><p className="mt-4 text-sm font-semibold text-wt-green">View pending →</p></Link>
        <Link href="/orders?f=live" className="card hover:border-wt-green/50"><p className="muted text-sm">Live links</p><p className="text-3xl font-bold text-[#8ea0ff]">{live}</p><p className="mt-4 text-sm font-semibold text-wt-green">View live links →</p></Link>
      </div>

      <h2 className="h3 mb-3 mt-8">Your orders</h2>
      {recent.length === 0 ? (
        <div className="card muted">You have not placed any orders yet. <Link href="/marketplace" className="text-wt-green">Browse the marketplace</Link>.</div>
      ) : (
        <div className="card overflow-x-auto">
          <table className="table-wt">
            <thead>
              <tr><th>#</th><th>Site</th><th>Amount</th><th>Status</th><th>Live URL</th><th></th></tr>
            </thead>
            <tbody>
              {recent.map((o) => (
                <tr key={o.id}>
                  <td>{o.id}</td>
                  <td className="font-semibold">{o.listing.domain}</td>
                  <td>{money(o.amountCents)}</td>
                  <td><StatusBadge status={o.status} /></td>
                  <td>
                    {o.liveUrl ? (
                      <a href={hrefOrNone(o.liveUrl)} target="_blank" rel="noopener noreferrer" className="text-wt-green break-all hover:underline">{o.liveUrl}</a>
                    ) : (
                      <span className="muted">-</span>
                    )}
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

async function PublisherDash({ user }: { user: any }) {
  const [sites, toFulfill, bal] = await Promise.all([
    prisma.listing.count({ where: { publisherId: user.id } }),
    prisma.order.count({ where: { listing: { publisherId: user.id }, status: { in: ["funded", "in_progress", "live"] } } }),
    // One definition of what can be withdrawn, shared with /withdraw and the
    // action that makes the request. See lib/withdrawals.ts.
    publisherBalance(user.id),
  ]);
  const earned = bal.readyCents + bal.awaitingCents + bal.inReviewCents + bal.receivedCents;
  const hasPayout = !!(user.payMethod || user.payMpesa || user.payPaypal);

  return (
    <div>
      <div className="mb-5 flash flash-info">
        When a buyer confirms your link is live, the payout is ready to withdraw. Press{" "}
        <strong>Withdraw</strong>, confirm your payment details, and we pay within{" "}
        <strong>72 hours</strong>. If a payment has not arrived within that window, contact
        seo@welcometomorrow.io immediately and we will resolve it.
      </div>

      {!hasPayout && (
        <div className="card mb-5 flex flex-wrap items-center justify-between gap-3 border-wt-yellow/40 bg-wt-yellow/10">
          <span className="text-sm">Add your payment details so we can pay your earnings.</span>
          <Link href="/payout" className="btn-accent btn-sm">Add payment details</Link>
        </div>
      )}

      <div className="grid gap-5 md:grid-cols-3">
        <div className="card">
          <p className="muted text-sm">Ready to withdraw</p>
          <p className="text-3xl font-bold text-wt-green">{money(bal.readyCents)}</p>
          {bal.pending ? (
            <p className="muted mt-4 text-xs">
              {money(bal.pending.amountCents)} withdrawal in review.{" "}
              <Link href="/withdraw" className="text-wt-green">View →</Link>
            </p>
          ) : bal.readyCents > 0 ? (
            <Link href="/withdraw" className="btn-primary btn-sm mt-4">Withdraw</Link>
          ) : (
            <p className="muted mt-4 text-xs">
              {bal.awaitingCents > 0
                ? `${money(bal.awaitingCents)} waiting for buyers to confirm.`
                : "Payouts appear here once a buyer confirms your link."}
            </p>
          )}
        </div>
        <div className="card"><p className="muted text-sm">Total received</p><p className="text-3xl font-bold">{money(bal.receivedCents)}</p><Link href="/withdraw" className="btn-ghost btn-sm mt-4">Withdrawal history</Link></div>
        <div className="card"><p className="muted text-sm">Total earned</p><p className="text-3xl font-bold">{money(earned)}</p><Link href="/payout" className="btn-ghost btn-sm mt-4">Payment details</Link></div>
      </div>

      <div className="mt-5 grid gap-5 md:grid-cols-2">
        <div className="card"><p className="muted text-sm">Your websites</p><p className="text-3xl font-bold">{sites}</p><div className="mt-4 flex gap-2"><Link href="/my-listings" className="btn-ghost btn-sm">Manage</Link><Link href="/new-listing" className="btn-primary btn-sm">Add a website</Link></div></div>
        <div className="card"><p className="muted text-sm">Orders to fulfil</p><p className="text-3xl font-bold">{toFulfill}</p><Link href="/orders" className="btn-ghost btn-sm mt-4">View orders</Link></div>
      </div>
    </div>
  );
}

async function AdminDash() {
  const [buyers, publishers, pending, orders, invites, apps] = await Promise.all([
    prisma.user.count({ where: { role: "buyer" } }),
    prisma.user.count({ where: { role: "publisher" } }),
    prisma.listing.count({ where: { status: "pending" } }),
    prisma.order.count({ where: { status: NOT_CANCELLED } }),
    prisma.invite.count({ where: { acceptedAt: null } }),
    prisma.publisherApplication.count({ where: { status: "new" } }),
  ]);
  return (
    <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
      <Link href="/admin/users" className="card hover:border-wt-green/50"><p className="muted text-sm">Buyers</p><p className="text-3xl font-bold">{buyers}</p></Link>
      <Link href="/admin/users" className="card hover:border-wt-green/50"><p className="muted text-sm">Publishers</p><p className="text-3xl font-bold">{publishers}</p></Link>
      <Link href="/admin/applications" className="card hover:border-wt-green/50"><p className="muted text-sm">Publisher requests</p><p className="text-3xl font-bold text-wt-yellow">{apps}</p></Link>
      <Link href="/admin/listings" className="card hover:border-wt-green/50"><p className="muted text-sm">Pending listings</p><p className="text-3xl font-bold text-wt-yellow">{pending}</p></Link>
      <Link href="/admin/orders" className="card hover:border-wt-green/50"><p className="muted text-sm">Orders</p><p className="text-3xl font-bold">{orders}</p></Link>
      <Link href="/admin/invites" className="card hover:border-wt-green/50"><p className="muted text-sm">Open invites</p><p className="text-3xl font-bold">{invites}</p></Link>
      <Link href="/admin/payments" className="card hover:border-wt-green/50"><p className="muted text-sm">Payment history</p><p className="text-lg font-bold text-wt-green">Deposits &amp; payouts →</p></Link>
    </div>
  );
}
