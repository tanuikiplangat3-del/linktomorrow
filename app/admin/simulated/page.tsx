import Link from "next/link";
import { requireRole } from "@/lib/auth";
import { money } from "@/lib/money";
import { Flash } from "@/components/ui";
import { simulatedReport } from "@/lib/simulated";
import { PASSWORD_PATTERN, PASSWORD_RULES } from "@/lib/password";
import { createSimulatedBuyerAction, creditSimulatedAction, deleteSimulatedAction } from "@/app/actions/simulated";

export const dynamic = "force-dynamic";
export const metadata = { title: "Simulated accounts" };

export default async function AdminSimulated(
  props: {
    searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
  }
) {
  const searchParams = await props.searchParams;
  await requireRole("admin");
  const r = await simulatedReport();
  // Deleted accounts with completed orders still count in the totals above,
  // but are not listed: nobody can sign in to them any more.
  const live = r.rows.filter((a) => !a.retired);

  return (
    <div>
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="h2">Simulated accounts</h1>
          <p className="muted mt-1 max-w-2xl text-sm">
            Real buyer accounts with a balance we credited instead of charging a card. They order
            like any other buyer and the publisher is paid real money. None of the figures below
            are counted as revenue anywhere else in the admin.
          </p>
        </div>
        <Link href="/admin" className="btn-ghost btn-sm">← Admin</Link>
      </div>

      <Flash searchParams={searchParams} />

      {/* ---- The report ---- */}
      <div className="mb-4 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
        <div className="card">
          <p className="muted text-sm">Simulated in</p>
          <p className="text-3xl font-bold">{money(r.grossCents)}</p>
          <p className="muted text-xs">
            {money(r.feeCents)} service fee, {money(r.netCents)} on balances
          </p>
        </div>
        <div className="card">
          <p className="muted text-sm">Spent on placements</p>
          <p className="text-3xl font-bold">{money(r.buyerValueCents)}</p>
          <p className="muted text-xs">
            {r.orders} order{r.orders === 1 ? "" : "s"}, {money(r.balanceLeftCents)} still unspent
          </p>
        </div>
        <div className="card">
          <p className="muted text-sm">Real money to publishers</p>
          <p className="text-3xl font-bold text-red-300">{money(r.publisherCostCents)}</p>
          <p className="muted text-xs">
            {money(r.publisherPaidCents)} sent, {money(r.publisherOwedCents)} still to send
          </p>
        </div>
        <div className="card">
          <p className="muted text-sm">Margin not charged in cash</p>
          <p className="text-3xl font-bold text-wt-green">{money(r.marginCents)}</p>
          <p className="muted text-xs">what a real buyer would have paid us on top</p>
        </div>
      </div>

      <div className="card mb-8">
        <h2 className="h3 mb-2">What these numbers mean</h2>
        <ul className="muted space-y-2 text-sm">
          <li>
            <strong className="text-white">{money(r.publisherCostCents)}</strong> is the only real
            money in this report. It is what the placements actually cost us, paid out of our own
            pocket rather than out of buyer deposits.
          </li>
          <li>
            <strong className="text-white">{money(r.marginCents)}</strong> is the margin the
            platform would have charged for the same placements. It is not revenue: we charged it to
            ourselves. It is the number that says what buying this way saved against buying through
            the marketplace as an ordinary customer.
          </li>
          <li>
            <strong className="text-white">{money(r.cardCostAvoidedCents)}</strong> is card
            processing we did not pay, because no card was charged. Roughly 2.9% plus 30 cents on
            each credit.
          </li>
          <li>
            The 5% service fee is withheld exactly as it is on a real deposit, so these accounts
            behave identically to a paying buyer. Credit $1,000 and the balance reads $950.
          </li>
        </ul>
      </div>

      {/* ---- The accounts ---- */}
      <h2 className="h3 mb-3">Accounts</h2>
      {r.retiredAccounts > 0 && (
        <p className="muted mb-3 text-xs">
          The totals above include {r.retiredAccounts} deleted account{r.retiredAccounts === 1 ? "" : "s"},
          kept on record because {r.retiredAccounts === 1 ? "it has" : "they have"} completed orders.
        </p>
      )}
      {live.length === 0 ? (
        <div className="card muted mb-8">No simulated accounts yet. Create one below.</div>
      ) : (
        <div className="mb-8 grid gap-5">
          {live.map((a) => (
            <div key={a.id} className="card">
              <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="text-lg font-bold">{a.name}</p>
                  <p className="muted text-sm">{a.email}</p>
                  <p className="muted text-xs">
                    Created {a.createdAt.toISOString().slice(0, 10)}
                  </p>
                </div>
                <div className="text-right">
                  <p className="muted text-xs">Balance</p>
                  <p className="text-2xl font-bold text-wt-green">{money(a.balanceCents)}</p>
                </div>
              </div>

              <div className="mb-4 grid gap-4 rounded-md border border-wt-border bg-white/5 p-4 sm:grid-cols-4">
                <div>
                  <p className="muted text-xs">Credited (gross)</p>
                  <p className="text-lg font-bold">{money(a.grossCents)}</p>
                </div>
                <div>
                  <p className="muted text-xs">Orders</p>
                  <p className="text-lg font-bold">{a.orders}</p>
                </div>
                <div>
                  <p className="muted text-xs">Spent</p>
                  <p className="text-lg font-bold">{money(a.buyerValueCents)}</p>
                </div>
                <div>
                  <p className="muted text-xs">Real cost to us</p>
                  <p className="text-lg font-bold text-red-300">{money(a.publisherCostCents)}</p>
                </div>
              </div>

              <form action={creditSimulatedAction} className="flex flex-wrap items-end gap-3">
                <input type="hidden" name="userId" value={a.id} />
                <label className="field mb-0 w-36">
                  <span>Add (USD)</span>
                  <input className="input" name="amount" type="number" min="1" step="1" placeholder="1000" required />
                </label>
                <label className="field mb-0 min-w-[12rem] flex-1">
                  <span>Note <span className="muted">(optional)</span></span>
                  <input className="input" name="note" placeholder="Client campaign, October" />
                </label>
                <button className="btn-primary" type="submit">Add balance</button>
              </form>
              <p className="muted mt-2 text-xs">
                The 5% service fee comes off, the same as a card deposit.
              </p>

              <details className="mt-4 border-t border-wt-border pt-4">
                <summary className="cursor-pointer list-none text-sm font-semibold text-white/80">
                  Delete this account &rarr;
                </summary>
                {a.openOrderIds.length > 0 ? (
                  <p className="muted mt-3 text-sm">
                    Order{a.openOrderIds.length === 1 ? "" : "s"}{" "}
                    {a.openOrderIds.map((id, i) => (
                      <span key={id}>
                        {i > 0 && ", "}
                        <Link href={`/orders/${id}`} className="text-wt-green">#{id}</Link>
                      </span>
                    ))}{" "}
                    {a.openOrderIds.length === 1 ? "is" : "are"} still open, so this account cannot be
                    deleted yet. Wait for {a.openOrderIds.length === 1 ? "it" : "them"} to complete, or
                    cancel {a.openOrderIds.length === 1 ? "it" : "them"} from the order page.
                  </p>
                ) : (
                  <form action={deleteSimulatedAction} className="mt-3 space-y-3">
                    <input type="hidden" name="userId" value={a.id} />
                    <p className="muted text-sm">
                      {a.completedOrders > 0
                        ? `The account is removed: it can no longer sign in and ${a.email} is free to use again. Its ${a.completedOrders} completed order${a.completedOrders === 1 ? " stays" : "s stay"} on record, so the publishers' earnings and the totals above do not change.`
                        : "The account is deleted with its history. Nothing real was bought on it."}
                      {a.balanceCents > 0 ? ` The unspent ${money(a.balanceCents)} balance is cleared.` : ""}
                    </p>
                    <label className="flex items-center gap-2 text-sm">
                      <input type="checkbox" name="confirm" value="yes" required />
                      Yes, delete {a.name}
                    </label>
                    <button className="btn-danger btn-sm" type="submit">Delete account</button>
                  </form>
                )}
              </details>
            </div>
          ))}
        </div>
      )}

      {/* ---- New account ---- */}
      <h2 className="h3 mb-3">Create a simulated account</h2>
      <form action={createSimulatedBuyerAction} className="card">
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="field mb-0">
            <span>Name</span>
            <input className="input" name="name" placeholder="Acme Media (managed)" required />
          </label>
          <label className="field mb-0">
            <span>Email</span>
            <input className="input" type="email" name="email" placeholder="acme@welcometomorrow.io" required autoComplete="off" />
          </label>
          <label className="field mb-0">
            <span>Password</span>
            <input className="input" type="password" name="password" pattern={PASSWORD_PATTERN} required autoComplete="new-password" />
            <small className="muted">{PASSWORD_RULES.map((r) => r.label).join(", ")}.</small>
          </label>
          <label className="field mb-0">
            <span>Opening balance (USD) <span className="muted">(optional)</span></span>
            <input className="input" name="opening" type="number" min="0" step="1" placeholder="1000" />
          </label>
        </div>
        <label className="field mt-4">
          <span>Note <span className="muted">(optional)</span></span>
          <input className="input" name="note" placeholder="Why this account exists" />
        </label>
        <button className="btn-primary" type="submit">Create account</button>
      </form>
    </div>
  );
}
