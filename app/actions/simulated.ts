"use server";

import { audit, formSummary } from "@/lib/audit";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requireRole, hashPassword } from "@/lib/auth";
import { passwordProblem } from "@/lib/password";
import { centsFromUsd, money } from "@/lib/money";
import { splitCredit, removeSimulatedAccount, simulatedRemoveRedirect } from "@/lib/simulated";

const q = (s: string) => encodeURIComponent(s);
const back = "/admin/simulated";

/**
 * Create a simulated buyer account.
 *
 * This is a real buyer in every way that matters: it signs in, it sees the real
 * marketplace, it places real orders and the publisher behind each order is
 * paid real money. It is flagged only so that the money credited to it can be
 * reported separately from money that was actually paid in.
 *
 * Deliberately NOT a demo account. A demo buyer sees invented websites and
 * cannot place a real order, which is the opposite of what this is for.
 *
 * The password is typed into the form by the admin and never travels through
 * chat.
 */
export async function createSimulatedBuyerAction(formData: FormData) {
  const admin = await requireRole("admin");
  await audit(admin, "createSimulatedBuyerAction", null, formSummary(formData));
  const name = String(formData.get("name") || "").trim();
  const email = String(formData.get("email") || "").trim().toLowerCase();
  const password = String(formData.get("password") || "");
  const openingUsd = parseFloat(String(formData.get("opening") || "0")) || 0;
  const note = String(formData.get("note") || "").trim();

  if (!name) redirect(`${back}?error=${q("Give the account a name.")}`);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) redirect(`${back}?error=${q("Enter a valid email address.")}`);
  const problem = passwordProblem(password);
  if (problem) redirect(`${back}?error=${q("Password: " + problem)}`);
  if (openingUsd < 0) redirect(`${back}?error=${q("An opening balance cannot be negative.")}`);

  const clash = await prisma.user.findUnique({ where: { email } });
  if (clash) redirect(`${back}?error=${q("An account already uses " + email + ".")}`);

  const user = await prisma.user.create({
    data: {
      name,
      email,
      passwordHash: await hashPassword(password),
      role: "buyer",
      verified: true,
      isSimulated: true,
      // Never a demo account, and never a founding buyer - those ten slots
      // belong to real buyers who signed up.
      isDemo: false,
    },
  });

  if (openingUsd > 0) {
    await creditSimulated(user.id, centsFromUsd(openingUsd), note || "Opening balance", admin.id);
  }

  revalidatePath(back);
  redirect(
    `${back}?success=${q(
      `${name} created. Sign in as ${email} with the password you just set.` +
        (openingUsd > 0 ? ` Credited ${money(centsFromUsd(openingUsd))} gross.` : "")
    )}`
  );
}

/** Add simulated balance to an existing simulated account. */
export async function creditSimulatedAction(formData: FormData) {
  const admin = await requireRole("admin");
  await audit(admin, "creditSimulatedAction", null, formSummary(formData));
  const userId = parseInt(String(formData.get("userId") || "0")) || 0;
  const amountUsd = parseFloat(String(formData.get("amount") || "0")) || 0;
  const note = String(formData.get("note") || "").trim();

  if (amountUsd <= 0) redirect(`${back}?error=${q("Enter an amount greater than zero.")}`);

  // Scoped to simulated accounts on purpose. Posting this form by hand must
  // never be able to conjure balance onto a real buyer's wallet.
  const user = await prisma.user.findFirst({ where: { id: userId, isSimulated: true } });
  if (!user) redirect(`${back}?error=${q("That is not a simulated account.")}`);

  const { grossCents, feeCents, netCents } = await creditSimulated(
    user!.id,
    centsFromUsd(amountUsd),
    note,
    admin.id
  );

  revalidatePath(back);
  redirect(
    `${back}?success=${q(
      `${user!.name}: ${money(grossCents)} added, ${money(feeCents)} service fee, ${money(netCents)} on the balance.`
    )}`
  );
}

/**
 * The credit itself. Written in one transaction so a balance can never move
 * without the record that explains it.
 *
 * Three rows, on purpose:
 *   - the balance goes up by the net, exactly as a card deposit does
 *   - SimulatedCredit keeps the gross, the fee and the net for the report
 *   - WalletTx keeps the buyer's own wallet history looking normal
 */
async function creditSimulated(userId: number, grossCents: number, note: string, adminId: number) {
  const split = splitCredit(grossCents);
  await prisma.$transaction([
    prisma.user.update({ where: { id: userId }, data: { balanceCents: { increment: split.netCents } } }),
    prisma.simulatedCredit.create({
      data: {
        userId,
        grossCents: split.grossCents,
        feeCents: split.feeCents,
        netCents: split.netCents,
        note: note || null,
        createdById: adminId,
      },
    }),
    prisma.walletTx.create({
      data: {
        userId,
        kind: "topup",
        amountCents: split.netCents,
        method: "simulated",
        note: note || "Balance added by an admin",
      },
    }),
  ]);
  return split;
}

/**
 * Delete a simulated account. The rules (refuse with open orders, delete
 * outright when nothing real was bought, otherwise keep the orders and remove
 * the person) live in lib/simulated.ts, shared with Admin -> Users -> Delete.
 */
export async function deleteSimulatedAction(formData: FormData) {
  const admin = await requireRole("admin");
  await audit(admin, "deleteSimulatedAction", null, formSummary(formData));
  const userId = parseInt(String(formData.get("userId") || "0")) || 0;
  if (formData.get("confirm") !== "yes") {
    redirect(`${back}?error=${q("Tick the box to confirm you want to delete this account.")}`);
  }
  const res = await removeSimulatedAccount(userId);
  revalidatePath(back);
  revalidatePath("/admin/users");
  redirect(simulatedRemoveRedirect(back, res));
}
