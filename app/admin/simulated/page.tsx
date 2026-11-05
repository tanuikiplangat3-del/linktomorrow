import Link from "next/link";
import { requireRole } from "@/lib/auth";
import { money } from "@/lib/money";
import { Flash } from "@/components/ui";
import { simulatedReport } from "@/lib/simulated";
import { PASSWORD_PATTERN, PASSWORD_RULES } from "@/lib/password";
import { createSimulatedBuyerAction, creditSimulatedAction, deleteSimulatedAction, setSimulatedPasswordAction } from "@/app/actions/simulated";
import { NewPasswordFields } from "@/components/PasswordField";
import { StatusBadge } from "@/components/ui";

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

      {/* ---- Spend by account (5 Nov 2026): each account on its own line ---- */}
      {r.rows.length > 0 && (
        <div className="mb-8">
          <h2 className="h3 mb-3">Spend by account</h2>
          <div className="card overflow-x-auto">
            <table className="table-wt">
              <thead>
                <tr>
                  <th>Account</th>
                  <th className="text-right">Credited</th>
                  <th className="text-right">Spent</th>
                  <th className="text-right">Orders</th>
                  <th className="text-right">Refunded</th>
                  <th className="text-right">Balance left</th>
                  <th className="text-right">Real cost to us</th>
                </tr>
              </thead>
              <tbody>
                {r.rows.map((a) => (
                  <tr key={a.id}>
                    <td>
                      {a.retired ? (
                        <span className="muted">{a.name}</span>
                      ) : (
                        <a href={`#account-${a.id}`} className="font-semibold text-wt-green hover:underline">{a.name}</a>
                      )}
                    </td>
                    <td className="text-right tabular-nums">{money(a.grossCents)}</td>
                    <td className="text-right font-bold tabular-nums">{money(a.buyerValueCents)}</td>
                    <td className="text-right tabular-nums">{a.orders}</td>
                    <td className="muted text-right tabular-nums">{money(a.refundedCents)}</td>
                    <td className="text-right tabular-nums text-wt-green">{money(a.balanceCents)}</td>
                    <td className="text-right tabular-nums text-red-300">{money(a.publisherCostCents)}</td>
                  </tr>
                ))}
                {r.rows.length > 1 && (
                  <tr className="font-bold">
                    <td>All accounts</td>
                    <td className="text-right tabular-nums">{money(r.grossCents)}</td>
                    <td className="text-right tabular-nums">{money(r.buyerValueCents)}</td>
                    <td className="text-right tabular-nums">{r.orders}</td>
                    <td className="text-right tabular-nums">{money(r.refundedCents)}</td>
                    <td className="text-right tabular-nums text-wt-green">{money(r.balanceLeftCents)}</td>
                    <td className="text-right tabular-nums text-red-300">{money(r.publisherCostCents)}</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          <p className="muted mt-2 text-xs">
            Spent counts paid orders only. Orders not yet paid for are not counted, and cancelled
            orders are not counted because the money went back to the balance (shown as Refunded).
          </p>
        </div>
      )}

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
            <div key={a.id} id={`account-${a.id}`} className="card scroll-mt-24">
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

              <div className="mb-4 grid gap-4 rounded-md border border-wt-border bg-white/5 p-4 sm:grid-cols-3 lg:grid-cols-6">
                <div>
                  <p className="muted text-xs">Credited (gross)</p>
                  <p className="text-lg font-bold">{money(a.grossCents)}</p>
                  <p className="muted text-xs">{money(a.netCents)} after the fee</p>
                </div>
                <div>
                  <p className="muted text-xs">Spent on placements</p>
                  <p className="text-lg font-bold">{money(a.buyerValueCents)}</p>
                  <p className="muted text-xs">{a.orders} paid order{a.orders === 1 ? "" : "s"}</p>
                </div>
                <div>
                  <p className="muted text-xs">Refunded</p>
                  <p className="text-lg font-bold">{money(a.refundedCents)}</p>
                  <p className="muted text-xs">from cancelled orders</p>
                </div>
                <div>
                  <p className="muted text-xs">Balance left</p>
                  <p className="text-lg font-bold text-wt-green">{money(a.balanceCents)}</p>
                </div>
                <div>
                  <p className="muted text-xs">Real cost to us</p>
                  <p className="text-lg font-bold text-red-300">{money(a.publisherCostCents)}</p>
                  <p className="muted text-xs">{money(a.publisherPaidCents)} sent, {money(a.publisherOwedCents)} to send</p>
                </div>
                <div>
                  <p className="muted text-xs">Margin not charged</p>
                  <p className="text-lg font-bold text-wt-green">{money(a.buyerValueCents - a.publisherCostCents)}</p>
                </div>
              </div>

              {a.orderLines.length > 0 && (
                <details className="mb-4">
                  <summary className="cursor-pointer list-none text-sm font-semibold text-wt-green">
                    Orders on this account ({a.orderLines.length}) &rarr;
                  </summary>
                  <div className="mt-3 overflow-x-auto">
                    <table className="table-wt">
                      <thead>
                        <tr><th>#</th><th>Site</th><th>Date</th><th className="text-right">Spent</th><th className="text-right">Publisher gets</th><th>Status</th></tr>
                      </thead>
                      <tbody>
                        {a.orderLines.map((o) => (
                          <tr key={o.id}>
                            <td><Link href={`/orders/${o.id}`} className="text-wt-green">{o.id}</Link></td>
                            <td className="font-semibold">{o.domain}</td>
                            <td className="muted whitespace-nowrap">{o.createdAt.toISOString().slice(0, 10)}</td>
                            <td className="text-right tabular-nums">{money(o.amountCents)}</td>
                            <td className="text-right tabular-nums text-red-300">
                              {money(o.payoutCents)}
                              <span className="muted block text-xs">{o.publisherPaid ? "sent" : "to send"}</span>
                            </td>
                            <td><StatusBadge status={o.status} /></td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </details>
              )}

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
                  Set a new password &rarr;
                </summary>
                <form action={setSimulatedPasswordAction} className="mt-3 max-w-md">
                  <input type="hidden" name="userId" value={a.id} />
                  <p className="muted mb-3 text-sm">
                    Replaces the password for {a.email}. Anyone signed in to this account is signed out.
                  </p>
                  <NewPasswordFields label="New password" confirmLabel="Type it again" />
                  <button className="btn-primary btn-sm" type="submit">Save new password</button>
                </form>
              </details>

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
