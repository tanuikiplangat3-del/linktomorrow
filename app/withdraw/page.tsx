import Link from "next/link";
import { requireRole } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { money } from "@/lib/money";
import { Flash } from "@/components/ui";
import SearchSelect from "@/components/SearchSelect";
import WithdrawFields from "@/components/WithdrawFields";
import WithdrawalBadge from "@/components/WithdrawalBadge";
import { COUNTRIES, contentTypeLabel } from "@/lib/data";
import { publisherBalance, readyToWithdrawWhere, withdrawMethodLabel } from "@/lib/withdrawals";
import { requestWithdrawalAction } from "@/app/actions/withdrawals";
import { LIST_OMIT } from "@/lib/orders";

export const dynamic = "force-dynamic";
export const metadata = { title: "Withdraw" };

export default async function WithdrawPage(
  props: {
    searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
  }
) {
  const searchParams = await props.searchParams;
  const user = await requireRole("publisher");
  const [me, bal, orders, history] = await Promise.all([
    prisma.user.findUnique({ where: { id: user.id } }),
    publisherBalance(user.id),
    prisma.order.findMany({
      where: readyToWithdrawWhere(user.id),
      omit: LIST_OMIT,
      include: { listing: true },
      orderBy: { createdAt: "asc" },
    }),
    prisma.withdrawal.findMany({ where: { publisherId: user.id }, orderBy: { createdAt: "desc" }, take: 20 }),
  ]);

  const saved = {
    paypal: me?.payPaypal || "",
    mpesa: me?.payMpesa || "",
    bank: me?.payBank || "",
    other: me?.payCard || "",
  };

  return (
    <div className="mx-auto max-w-2xl">
      <Link href="/dashboard" className="muted text-sm">← Dashboard</Link>
      <h1 className="h2 mb-1 mt-2">Withdraw</h1>
      <p className="muted mb-6">
        Ask to be paid for every order a buyer has confirmed. Our team reviews each request and pays
        within 72 hours.
      </p>
      <Flash searchParams={searchParams} />

      <div className="mb-5 grid gap-5 sm:grid-cols-2">
        <div className="card">
          <p className="muted text-sm">Ready to withdraw</p>
          <p className="text-4xl font-bold text-wt-green">{money(bal.readyCents)}</p>
          <p className="muted mt-2 text-xs">{bal.readyCount} confirmed order{bal.readyCount === 1 ? "" : "s"}</p>
        </div>
        <div className="card">
          <p className="muted text-sm">Waiting for the buyer to confirm</p>
          <p className="text-4xl font-bold text-wt-yellow">{money(bal.awaitingCents)}</p>
          <p className="muted mt-2 text-xs">Ready to withdraw once they confirm the link is live.</p>
        </div>
      </div>

      {bal.pending ? (
        <div className="card mb-8 border-wt-yellow/40">
          <h2 className="h3 mb-2">Your withdrawal is being reviewed</h2>
          <p className="muted text-sm">
            You asked for <strong className="text-white">{money(bal.pending.amountCents)}</strong> on{" "}
            {bal.pending.createdAt.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" })}.
            You will get an email as soon as it is paid. Anything that becomes ready in the meantime
            can go in your next request.
          </p>
        </div>
      ) : bal.readyCents <= 0 ? (
        <div className="card muted mb-8">
          Nothing is ready to withdraw yet. Payouts appear here once a buyer confirms your link is live.
        </div>
      ) : (
        <form action={requestWithdrawalAction} className="card mb-8">
          <h2 className="h3 mb-1">Withdraw {money(bal.readyCents)}</h2>
          <p className="muted mb-5 text-sm">
            Confirm where we should send it. We have filled in your saved details. Anything you
            change here is used for this withdrawal only.
          </p>
          <WithdrawFields method={me?.payMethod || "paypal"} saved={saved} />
          <div className="field">
            <span>Country</span>
            <SearchSelect name="country" options={COUNTRIES} defaultValue={me?.payCountry || ""} placeholder="Choose" title="Choose your country" />
          </div>

          <details className="mb-5">
            <summary className="cursor-pointer text-sm font-semibold text-white/80">
              What is included ({orders.length} order{orders.length === 1 ? "" : "s"})
            </summary>
            <table className="table-wt mt-3">
              <thead><tr><th>#</th><th>Site</th><th>Type</th><th>Payout</th></tr></thead>
              <tbody>
                {orders.map((o) => (
                  <tr key={o.id}>
                    <td><Link href={`/orders/${o.id}`} className="text-wt-green">{o.id}</Link></td>
                    <td>{o.listing.domain}</td>
                    <td className="muted">{contentTypeLabel(o.contentType)}</td>
                    <td className="font-semibold">{money(o.payoutCents)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </details>

          <button className="btn-primary w-full" type="submit">Request withdrawal</button>
          <p className="muted mt-3 text-center text-xs">Every withdrawal is approved by our team before it is paid.</p>
        </form>
      )}

      <h2 className="h3 mb-3">Your withdrawals</h2>
      {history.length === 0 ? (
        <div className="card muted">No withdrawals yet.</div>
      ) : (
        <div className="card overflow-x-auto">
          <table className="table-wt">
            <thead><tr><th>Date</th><th>Amount</th><th>Method</th><th>Status</th><th>Note</th></tr></thead>
            <tbody>
              {history.map((w) => (
                <tr key={w.id}>
                  <td className="whitespace-nowrap">{w.createdAt.toLocaleDateString("en-GB")}</td>
                  <td className="font-semibold">{money(w.amountCents)}</td>
                  <td className="muted">{withdrawMethodLabel(w.method)}</td>
                  <td><WithdrawalBadge status={w.status} /></td>
                  <td className="muted">{w.adminNote || (w.reference ? `Ref: ${w.reference}` : "-")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
