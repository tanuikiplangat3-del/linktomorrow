// Simulated buyer accounts.
//
// These are ordinary buyer accounts. They sign in, see the real marketplace,
// place real orders, and the publishers behind those orders are paid in real
// money. The one difference is where the balance came from: an admin credited
// it, no card was charged, and so that money never existed.
//
// Everything here exists to keep those two kinds of money apart. A simulated
// deposit must never be added to real revenue, and the cash that actually left
// the business - the publisher payouts - must be visible on its own.
//
// The 5% service fee is applied exactly as it is on a card deposit, so a
// simulated account behaves the same way a real one does: credit $1,000 and the
// balance reads $950.

import { randomBytes } from "crypto";
import { prisma } from "@/lib/prisma";
import { depositFee } from "@/lib/money";
import { hashPassword } from "@/lib/auth";
import { detachBuyer } from "@/lib/buyer-cleanup";

/**
 * A simulated account that was deleted but had to be kept as a record (it has
 * completed orders) gets an address on this domain. ".invalid" is reserved and
 * can never receive mail or belong to a real person, so it cannot clash with a
 * real sign-up and frees the original address for reuse. Added 14 Oct 2026, so
 * that deleting needs no database change.
 */
export const RETIRED_EMAIL_DOMAIN = "@deleted.simulated.invalid";

export function isRetiredEmail(email: string | null | undefined): boolean {
  return String(email || "").toLowerCase().endsWith(RETIRED_EMAIL_DOMAIN);
}

/** Orders where the buyer's money is held and a publisher is still working or waiting. */
const OPEN_ORDER_STATUSES = ["funded", "in_progress", "live"];

export type RemoveResult =
  | { kind: "not_found" }
  | { kind: "open_orders"; orderIds: number[] }
  | { kind: "deleted"; name: string; demoted: number }
  | { kind: "retired"; name: string; demoted: number; completed: number };

/**
 * Delete a simulated account.
 *
 * Deleting a user cascades to their orders. For a simulated buyer that is only
 * safe while none of those orders is a real placement, because a completed
 * order is also the publisher's record of money owed or paid, and part of the
 * simulated report's "real money to publishers". So:
 *
 *   - Open orders (funded, in progress, live): refused. Finish or cancel first.
 *   - No completed orders: deleted outright, with its credits and history.
 *   - Completed orders: the person is removed (cannot sign in, email freed,
 *     gone from the lists, unspent balance cleared) but the row stays so the
 *     orders, the publishers' earnings and the report stay correct.
 */
export async function removeSimulatedAccount(userId: number): Promise<RemoveResult> {
  const user = await prisma.user.findFirst({ where: { id: userId, isSimulated: true } });
  if (!user || isRetiredEmail(user.email)) return { kind: "not_found" };

  const open = await prisma.order.findMany({
    where: { buyerId: userId, status: { in: OPEN_ORDER_STATUSES } },
    select: { id: true },
    orderBy: { id: "asc" },
  });
  if (open.length) return { kind: "open_orders", orderIds: open.map((o) => o.id) };

  const completed = await prisma.order.count({ where: { buyerId: userId, status: "completed" } });
  const demoted = await detachBuyer(userId);

  if (completed === 0) {
    // Unpaid and cancelled orders, credits and wallet history go with it.
    // Guarded on still being simulated and still having no completed order, in
    // case an order completed in the moments since the checks above.
    const gone = await prisma.user.deleteMany({
      where: { id: userId, isSimulated: true, orders: { none: { status: { in: [...OPEN_ORDER_STATUSES, "completed"] } } } },
    });
    if (gone.count === 1) return { kind: "deleted", name: user.name, demoted };
    return { kind: "open_orders", orderIds: [] };
  }

  await prisma.$transaction([
    prisma.user.update({
      where: { id: userId },
      data: {
        name: `${user.name} (deleted)`,
        email: `${userId}-${Date.now()}${RETIRED_EMAIL_DOMAIN}`,
        // Nobody knows this password, and the bump ends any open session.
        passwordHash: await hashPassword(randomBytes(32).toString("hex")),
        sessionVersion: { increment: 1 },
        balanceCents: 0,
      },
    }),
    ...(user.balanceCents > 0
      ? [
          prisma.walletTx.create({
            data: {
              userId,
              kind: "spend",
              amountCents: user.balanceCents,
              method: "simulated",
              note: "Unspent simulated balance cleared when the account was deleted",
            },
          }),
        ]
      : []),
  ]);
  return { kind: "retired", name: user.name, demoted, completed };
}

/** Orders that represent real spending. A cancelled order was refunded. */
const REAL_ORDERS = { not: "cancelled" };

/**
 * Stripe's own cost on a card deposit, roughly 2.9% + $0.30. Not charged here,
 * which is the point: it is the one figure in the report that is genuinely cash
 * saved rather than money moved from one internal pocket to another.
 */
function cardCostCents(grossCents: number): number {
  return Math.round(grossCents * 0.029) + 30;
}

export type SimulatedAccountRow = {
  id: number;
  name: string;
  email: string;
  balanceCents: number;
  grossCents: number;
  feeCents: number;
  netCents: number;
  orders: number;
  buyerValueCents: number;
  publisherCostCents: number;
  publisherPaidCents: number;
  createdAt: Date;
  /** Deleted, kept only because it has completed orders. Counted, not listed. */
  retired: boolean;
  openOrderIds: number[];   // funded, in progress or live: blocks a delete
  completedOrders: number;
};

export type SimulatedReport = {
  rows: SimulatedAccountRow[];
  accounts: number;
  retiredAccounts: number;    // deleted accounts whose orders still count
  grossCents: number;        // credited, before the service fee
  feeCents: number;          // service fee withheld
  netCents: number;          // what landed on the balances
  balanceLeftCents: number;  // still unspent
  orders: number;
  buyerValueCents: number;      // what these orders would have cost a real buyer
  publisherCostCents: number;   // real money owed to publishers
  publisherPaidCents: number;   // real money already sent
  publisherOwedCents: number;   // real money still to send
  marginCents: number;          // buyer value minus publisher cost - never real revenue
  cardCostAvoidedCents: number; // the card processing we did not pay
};

/** Everything Admin -> Simulated accounts needs, in one place. */
export async function simulatedReport(): Promise<SimulatedReport> {
  const users = await prisma.user.findMany({
    where: { isSimulated: true },
    orderBy: { createdAt: "asc" },
    select: { id: true, name: true, email: true, balanceCents: true, createdAt: true },
  });

  const ids = users.map((u) => u.id);
  const empty: SimulatedReport = {
    rows: [],
    accounts: 0,
    retiredAccounts: 0,
    grossCents: 0,
    feeCents: 0,
    netCents: 0,
    balanceLeftCents: 0,
    orders: 0,
    buyerValueCents: 0,
    publisherCostCents: 0,
    publisherPaidCents: 0,
    publisherOwedCents: 0,
    marginCents: 0,
    cardCostAvoidedCents: 0,
  };
  if (ids.length === 0) return empty;

  const [credits, orders] = await Promise.all([
    prisma.simulatedCredit.findMany({
      where: { userId: { in: ids } },
      select: { userId: true, grossCents: true, feeCents: true, netCents: true },
    }),
    prisma.order.findMany({
      where: { buyerId: { in: ids }, status: REAL_ORDERS },
      select: { id: true, buyerId: true, amountCents: true, payoutCents: true, publisherPaid: true, status: true },
    }),
  ]);

  const rows: SimulatedAccountRow[] = users.map((u) => {
    const mine = credits.filter((c) => c.userId === u.id);
    const myOrders = orders.filter((o) => o.buyerId === u.id);
    return {
      ...u,
      retired: isRetiredEmail(u.email),
      openOrderIds: myOrders.filter((o) => OPEN_ORDER_STATUSES.includes(o.status)).map((o) => o.id),
      completedOrders: myOrders.filter((o) => o.status === "completed").length,
      grossCents: mine.reduce((s, c) => s + c.grossCents, 0),
      feeCents: mine.reduce((s, c) => s + c.feeCents, 0),
      netCents: mine.reduce((s, c) => s + c.netCents, 0),
      orders: myOrders.length,
      buyerValueCents: myOrders.reduce((s, o) => s + o.amountCents, 0),
      publisherCostCents: myOrders.reduce((s, o) => s + o.payoutCents, 0),
      publisherPaidCents: myOrders.filter((o) => o.publisherPaid).reduce((s, o) => s + o.payoutCents, 0),
    };
  });

  const sum = (pick: (r: SimulatedAccountRow) => number) => rows.reduce((s, r) => s + pick(r), 0);
  const publisherCostCents = sum((r) => r.publisherCostCents);
  const publisherPaidCents = sum((r) => r.publisherPaidCents);
  const buyerValueCents = sum((r) => r.buyerValueCents);

  return {
    rows,
    accounts: rows.filter((r) => !r.retired).length,
    retiredAccounts: rows.filter((r) => r.retired).length,
    grossCents: sum((r) => r.grossCents),
    feeCents: sum((r) => r.feeCents),
    netCents: sum((r) => r.netCents),
    balanceLeftCents: sum((r) => r.balanceCents),
    orders: sum((r) => r.orders),
    buyerValueCents,
    publisherCostCents,
    publisherPaidCents,
    publisherOwedCents: publisherCostCents - publisherPaidCents,
    marginCents: buyerValueCents - publisherCostCents,
    cardCostAvoidedCents: credits.reduce((s, c) => s + cardCostCents(c.grossCents), 0),
  };
}

/** Split a credit the same way a card deposit is split. */
export function splitCredit(grossCents: number): { grossCents: number; feeCents: number; netCents: number } {
  const feeCents = depositFee(grossCents);
  return { grossCents, feeCents, netCents: grossCents - feeCents };
}

/** The message an admin sees after a delete, wherever they pressed it. */
export function simulatedRemoveRedirect(page: string, res: RemoveResult): string {
  const q = (t: string) => encodeURIComponent(t);
  const pricing = (n: number) => (n ? ` ${n} site(s) they had introduced now use standard pricing.` : "");
  switch (res.kind) {
    case "not_found":
      return `${page}?error=${q("That simulated account was not found. It may already have been deleted.")}`;
    case "open_orders":
      return `${page}?error=${q(
        res.orderIds.length
          ? `Not deleted: order${res.orderIds.length === 1 ? "" : "s"} ${res.orderIds.map((i) => "#" + i).join(", ")} ${res.orderIds.length === 1 ? "is" : "are"} still open. Wait for ${res.orderIds.length === 1 ? "it" : "them"} to complete, or cancel ${res.orderIds.length === 1 ? "it" : "them"} from the order page, then delete again.`
          : "Not deleted: an order on this account changed just now. Please try again."
      )}`;
    case "deleted":
      return `${page}?success=${q(`${res.name} deleted, with its balance and history.` + pricing(res.demoted))}`;
    case "retired":
      return `${page}?success=${q(
        `${res.name} deleted. It can no longer sign in and its email address is free to reuse. Its ${res.completed} completed order${res.completed === 1 ? " stays" : "s stay"} on record so the publishers' earnings and this report remain correct.` +
          pricing(res.demoted)
      )}`;
  }
}
