import Link from "next/link";
import { hrefOrNone } from "@/lib/safe-url";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/auth";
import { money } from "@/lib/money";
import { one } from "@/lib/util";
import { StatusBadge, Flash, EmptyState } from "@/components/ui";
import Countdown from "@/components/Countdown";
import { NOT_CANCELLED, LIST_OMIT } from "@/lib/orders";

export default async function OrdersPage(
  props: { searchParams: Promise<{ [key: string]: string | string[] | undefined }> }
) {
  const searchParams = await props.searchParams;
  const user = await requireUser();
  const f = one(searchParams.f);

  const roleWhere: any =
    user.role === "buyer"
      ? { buyerId: user.id }
      : user.role === "publisher"
      ? { listing: { publisherId: user.id } }
      : {};

  // Cancelled orders are never listed, for buyers, publishers or admins
  // (5 Nov 2026). Both filters below only name open statuses anyway.
  const filter: any = { status: NOT_CANCELLED };
  if (f === "pending") filter.status = { in: ["pending_payment", "funded", "in_progress"] };
  if (f === "live") filter.status = { in: ["live", "completed"] };
  const where = { ...roleWhere, ...filter };

  const orders = await prisma.order.findMany({
    where,
    omit: LIST_OMIT,
    include: { listing: true, buyer: true },
    orderBy: { createdAt: "desc" },
    take: 200,
  });

  const heading = f === "live" ? "Live links" : f === "pending" ? "Pending orders" : "Orders";
  const subtitle =
    f === "live"
      ? "Every live link you have acquired."
      : f === "pending"
      ? "Orders that are awaiting payment or in progress."
      : user.role === "buyer"
      ? "Your placement orders."
      : user.role === "publisher"
      ? "Orders on your sites."
      : "All orders.";

  return (
    <div>
      <div className="mb-6 flex flex-wrap items-center gap-3">
        <h1 className="h2">{heading}</h1>
        {f && <Link href="/orders" className="text-sm font-semibold text-wt-green">Show all →</Link>}
      </div>
      <p className="muted -mt-4 mb-6">{subtitle}</p>
      <Flash searchParams={searchParams} />

      {orders.length === 0 ? (
        <EmptyState
          title="No orders yet"
          hint={user.role === "buyer" ? "Browse the marketplace to place your first order." : "Orders will appear here."}
          cta={user.role === "buyer" ? { href: "/marketplace", label: "Browse sites" } : undefined}
        />
      ) : (
        <div className="card overflow-x-auto">
          <table className="table-wt">
            <thead>
              <tr>
                <th>#</th><th>Site</th>
                {user.role !== "buyer" && <th>Buyer</th>}
                <th>{user.role === "publisher" ? "Payout" : "Amount"}</th>
                <th>Turnaround left</th>
                <th>Status</th><th>Live URL</th><th></th>
              </tr>
            </thead>
            <tbody>
              {orders.map((o) => (
                <tr key={o.id}>
                  <td>{o.id}</td>
                  <td className="font-semibold">
                    {o.listing.domain}
                    {o.contentType === "pr_article" && <span className="badge badge-yellow ml-2 align-middle">PR</span>}
                  </td>
                  {user.role !== "buyer" && <td className="muted">{o.buyer.name}</td>}
                  <td>{money(user.role === "publisher" ? o.payoutCents : o.amountCents)}</td>
                  <td className="whitespace-nowrap">
                    {o.dueAt && ["funded", "in_progress"].includes(o.status)
                      ? <Countdown dueAt={o.dueAt.toISOString()} />
                      : <span className="muted">-</span>}
                  </td>
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
