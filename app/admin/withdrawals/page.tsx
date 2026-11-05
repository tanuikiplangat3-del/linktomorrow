import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { requireRole } from "@/lib/auth";
import { money } from "@/lib/money";
import { Flash } from "@/components/ui";
import WithdrawalBadge from "@/components/WithdrawalBadge";
import { decideWithdrawalAction } from "@/app/actions/withdrawals";
import { withdrawMethodLabel, WITHDRAWAL_PENDING } from "@/lib/withdrawals";
import { contentTypeLabel } from "@/lib/data";
import { LIST_OMIT } from "@/lib/orders";

export const dynamic = "force-dynamic";
export const metadata = { title: "Withdrawals" };

export default async function AdminWithdrawals(
  props: {
    searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
  }
) {
  const searchParams = await props.searchParams;
  await requireRole("admin");

  const [pending, decided] = await Promise.all([
    prisma.withdrawal.findMany({
      where: { status: WITHDRAWAL_PENDING },
      include: { publisher: true },
      orderBy: { createdAt: "asc" },
    }),
    prisma.withdrawal.findMany({
      where: { status: { not: WITHDRAWAL_PENDING } },
      include: { publisher: true },
      orderBy: { decidedAt: "desc" },
      take: 50,
    }),
  ]);

  // The orders behind each pending request, so the admin can see what is being
  // paid for before sending money.
  const orders = pending.length
    ? await prisma.order.findMany({
        where: { withdrawalId: { in: pending.map((w) => w.id) } },
        omit: LIST_OMIT,
        include: { listing: true, buyer: true },
        orderBy: { id: "asc" },
      })
    : [];
  const owed = pending.reduce((s, w) => s + w.amountCents, 0);

  return (
    <div>
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="h2">Withdrawals</h1>
          <p className="muted mt-1 max-w-2xl text-sm">
            Publishers ask to be paid here. Each one has been told they will be paid within 72 hours.
            Send the money first, then approve. Declining releases the orders so they can ask again.
          </p>
        </div>
        <Link href="/admin" className="btn-ghost btn-sm">← Admin</Link>
      </div>

      <Flash searchParams={searchParams} />

      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <h2 className="h3">Waiting on you ({pending.length})</h2>
        <span className="muted text-sm">Total requested: <span className="font-bold text-wt-green">{money(owed)}</span></span>
      </div>
      {pending.length === 0 ? (
        <div className="card muted mb-10">Nothing to pay right now.</div>
      ) : (
        <div className="mb-10 grid gap-5">
          {pending.map((w) => {
            const mine = orders.filter((o) => o.withdrawalId === w.id);
            const simulated = mine.filter((o) => o.buyer.isSimulated).length;
            return (
              <div key={w.id} className="card">
                <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <p className="text-lg font-bold">
                      #{w.id} · {w.publisher.name}{" "}
                      <span className="text-wt-green">{money(w.amountCents)}</span>
                    </p>
                    <p className="muted text-sm">
                      <Link href={`/admin/users/${w.publisherId}`} className="hover:underline">{w.publisher.email}</Link>
                    </p>
                    <p className="muted text-xs">
                      Asked {w.createdAt.toISOString().slice(0, 16).replace("T", " ")} UTC
                      {w.country ? ` · ${w.country}` : ""}
                    </p>
                  </div>
                  <span className="badge badge-yellow">{withdrawMethodLabel(w.method)}</span>
                </div>

                <p className="mb-3 whitespace-pre-wrap rounded-md border border-wt-border bg-black/30 p-3 text-sm">
                  {w.details}
                </p>

                <details className="mb-4">
                  <summary className="cursor-pointer text-sm font-semibold text-white/80">
                    {mine.length} order{mine.length === 1 ? "" : "s"} included
                    {simulated > 0 ? ` (${simulated} from simulated accounts)` : ""}
                  </summary>
                  <table className="table-wt mt-3">
                    <thead><tr><th>#</th><th>Site</th><th>Type</th><th>Buyer</th><th>Payout</th></tr></thead>
                    <tbody>
                      {mine.map((o) => (
                        <tr key={o.id}>
                          <td><Link href={`/orders/${o.id}`} className="text-wt-green">{o.id}</Link></td>
                          <td>{o.listing.domain}</td>
                          <td className="muted">{contentTypeLabel(o.contentType)}</td>
                          <td className="muted">{o.buyer.name}{o.buyer.isSimulated ? " (simulated)" : ""}</td>
                          <td className="font-semibold">{money(o.payoutCents)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </details>

                <form action={decideWithdrawalAction} className="grid gap-3 md:grid-cols-[1fr_1fr_auto_auto]">
                  <input type="hidden" name="withdrawalId" value={w.id} />
                  <label className="field mb-0">
                    <span>Payment reference <span className="muted">(optional)</span></span>
                    <input className="input" name="reference" placeholder="PayPal / M-Pesa transaction ID" />
                  </label>
                  <label className="field mb-0">
                    <span>Message to the publisher <span className="muted">(needed to decline)</span></span>
                    <input className="input" name="note" placeholder="Paid, thank you. / That account name does not match." />
                  </label>
                  <button className="btn-primary self-end" name="decision" value="approve" type="submit">
                    Approve, paid
                  </button>
                  <button className="btn-danger self-end" name="decision" value="reject" type="submit">
                    Decline
                  </button>
                </form>
              </div>
            );
          })}
        </div>
      )}

      <h2 className="h3 mb-3">Answered</h2>
      {decided.length === 0 ? (
        <div className="card muted">Nothing answered yet.</div>
      ) : (
        <div className="card overflow-x-auto">
          <table className="table-wt">
            <thead><tr><th>#</th><th>Publisher</th><th>Amount</th><th>Method</th><th>Status</th><th>Reference / note</th><th>Answered</th></tr></thead>
            <tbody>
              {decided.map((w) => (
                <tr key={w.id}>
                  <td>{w.id}</td>
                  <td className="font-semibold">{w.publisher.name}<br /><span className="muted text-xs">{w.publisher.email}</span></td>
                  <td className="font-semibold">{money(w.amountCents)}</td>
                  <td className="muted">{withdrawMethodLabel(w.method)}</td>
                  <td><WithdrawalBadge status={w.status} /></td>
                  <td className="muted">{[w.reference, w.adminNote].filter(Boolean).join(" · ") || "-"}</td>
                  <td className="muted whitespace-nowrap">{w.decidedAt ? w.decidedAt.toISOString().slice(0, 10) : "-"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
