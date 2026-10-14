"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { randomBytes } from "crypto";
import { prisma } from "@/lib/prisma";
import { requireRole } from "@/lib/auth";
import { audit, formSummary } from "@/lib/audit";
import { appUrl } from "@/lib/stripe";
import {
  emailEnabled,
  sendInviteEmail,
  sendApplicationRejected,
  sendAdminInviteEmail,
  sendPublisherPaid,
  sendTestEmail,
  ADMIN_NOTIFY,
} from "@/lib/email";
import { ahrefsEnabled } from "@/lib/ahrefs";
import { refreshDueMetrics } from "@/lib/metrics";
import { normalizeCountry } from "@/lib/data";
import { detachBuyer } from "@/lib/buyer-cleanup";
import { removeSimulatedAccount, simulatedRemoveRedirect } from "@/lib/simulated";
import { STATUS_ARCHIVED } from "@/lib/duplicates";

const q = (s: string) => encodeURIComponent(s);

export async function invitePublisherAction(formData: FormData) {
  const auditAdmin = await requireRole("admin");
  await audit(auditAdmin, "invitePublisherAction", null, formSummary(formData));
  const email = String(formData.get("email") || "").trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email))
    redirect(`/admin/invites?error=${q("Enter a valid email address.")}`);

  const existingUser = await prisma.user.findUnique({ where: { email } });
  if (existingUser) redirect(`/admin/invites?error=${q("A user with that email already exists.")}`);

  const token = randomBytes(24).toString("hex");
  await prisma.invite.create({
    data: { email, token, role: "publisher", expiresAt: new Date(Date.now() + 7 * 86400_000) },
  });
  const link = `${appUrl()}/accept-invite?token=${token}`;

  if (emailEnabled()) {
    await sendInviteEmail(email, link);
    redirect(`/admin/invites?success=${q("Invite sent to " + email)}`);
  }
  // Email off - show the link so the admin can share it manually.
  redirect(`/admin/invites?success=${q("Invite created. Share this link: " + link)}`);
}

/** Create a shareable publisher invite link (not tied to a specific email). */
export async function createShareInviteAction() {
  const auditAdmin = await requireRole("admin");
  await audit(auditAdmin, "createShareInviteAction", null, formSummary(null));
  const token = randomBytes(24).toString("hex");
  await prisma.invite.create({
    data: { email: null, token, role: "publisher", expiresAt: new Date(Date.now() + 7 * 86400_000) },
  });
  const link = `${appUrl()}/accept-invite?token=${token}`;
  redirect(`/admin/invites?success=${q("Shareable invite link created. Send it to your publisher: " + link)}`);
}

/**
 * Invite another admin by email. Admin invites grant full access, so they are
 * always tied to one address and are never shareable links.
 */
export async function inviteAdminAction(formData: FormData) {
  const auditAdmin = await requireRole("admin");
  await audit(auditAdmin, "inviteAdminAction", null, formSummary(formData));
  const email = String(formData.get("email") || "").trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email))
    redirect(`/admin/invites?error=${q("Enter a valid email address for the new admin.")}`);

  const existingUser = await prisma.user.findUnique({ where: { email } });
  if (existingUser) redirect(`/admin/invites?error=${q("A user with that email already exists.")}`);

  const token = randomBytes(24).toString("hex");
  await prisma.invite.create({
    data: { email, token, role: "admin", expiresAt: new Date(Date.now() + 7 * 86400_000) },
  });
  const link = `${appUrl()}/accept-invite?token=${token}`;

  if (emailEnabled()) {
    await sendAdminInviteEmail(email, link);
    redirect(`/admin/invites?success=${q("Admin invite sent to " + email)}`);
  }
  redirect(`/admin/invites?success=${q("Admin invite created. Share this link only with " + email + ": " + link)}`);
}

export async function revokeInviteAction(formData: FormData) {
  const auditAdmin = await requireRole("admin");
  await audit(auditAdmin, "revokeInviteAction", null, formSummary(formData));
  const id = parseInt(String(formData.get("id") || "0"));
  await prisma.invite.deleteMany({ where: { id, acceptedAt: null } });
  redirect(`/admin/invites?success=${q("Invite revoked.")}`);
}

export async function approveListingAction(formData: FormData) {
  const auditAdmin = await requireRole("admin");
  await audit(auditAdmin, "approveListingAction", null, formSummary(formData));
  const id = parseInt(String(formData.get("id") || "0"));
  await prisma.listing.update({ where: { id }, data: { status: "approved" } });
  revalidatePath("/admin/listings");
  revalidatePath("/marketplace");
  redirect(`/admin/listings?success=${q("Listing approved.")}`);
}

export async function rejectListingAction(formData: FormData) {
  const auditAdmin = await requireRole("admin");
  await audit(auditAdmin, "rejectListingAction", null, formSummary(formData));
  const id = parseInt(String(formData.get("id") || "0"));
  await prisma.listing.update({ where: { id }, data: { status: "rejected" } });
  revalidatePath("/admin/listings");
  redirect(`/admin/listings?success=${q("Listing rejected.")}`);
}

export async function approveAllListingsAction() {
  const auditAdmin = await requireRole("admin");
  await audit(auditAdmin, "approveAllListingsAction", null, formSummary(null));
  await prisma.listing.updateMany({ where: { status: "pending" }, data: { status: "approved" } });
  revalidatePath("/admin/listings");
  revalidatePath("/marketplace");
  redirect(`/admin/listings?success=${q("All pending listings approved.")}`);
}

/**
 * Refresh Domain Rating on demand. Monthly traffic is publisher-entered and is
 * deliberately left alone here. The app already does this on its own
 * every 7 days (see lib/metrics-scheduler.ts); this button is for when an admin
 * does not want to wait - after a big bulk upload, for example.
 *
 * One batch per click, so the request never outlives the load balancer.
 */
export async function refreshListingMetricsAction() {
  const auditAdmin = await requireRole("admin");
  await audit(auditAdmin, "refreshListingMetricsAction", null, formSummary(null));
  if (!ahrefsEnabled()) {
    redirect(`/admin/listings?error=${q("The Ahrefs API key is not set on the server, so DR cannot be fetched.")}`);
  }

  const r = await refreshDueMetrics({ maxItems: 600, budgetMs: 25_000, parallel: 10 });

  if (r.processed === 0) {
    redirect(`/admin/listings?success=${q("Every website is already up to date.")}`);
  }

  revalidatePath("/admin/listings");
  revalidatePath("/marketplace");
  revalidatePath("/");
  const msg =
    `Refreshed the Domain Rating on ${r.updated} website(s).` +
    (r.failed ? ` ${r.failed} could not be reached - they will be retried automatically.` : "") +
    (r.remaining ? ` ${r.remaining} still to go - click Refresh again to continue.` : " All websites are up to date.");
  redirect(`/admin/listings?success=${q(msg)}`);
}

/**
 * Send a test email to the admin desk. Lets an admin prove the email layer works
 * without having to take a real payment first, and reports the exact reason when
 * it does not - the Resend API rejects messages without throwing, so a failure
 * here is the quickest way to see why nothing is arriving.
 */
export async function sendTestEmailAction() {
  const auditAdmin = await requireRole("admin");
  await audit(auditAdmin, "sendTestEmailAction", null, formSummary(null));
  if (!emailEnabled()) {
    redirect(`/admin?error=${q("RESEND_API_KEY is not set on the server, so no email can be sent.")}`);
  }
  const ok = await sendTestEmail();
  if (ok) {
    redirect(`/admin?success=${q("Test email sent to " + ADMIN_NOTIFY + ". If it does not arrive, check the sending domain in Resend.")}`);
  }
  redirect(`/admin?error=${q("Resend rejected the message. Check the container logs for a line starting [email] REJECTED - it names the reason.")}`);
}

/**
 * Super admin: clear out every website belonging to one publisher, in one press,
 * so a bad spreadsheet can simply be re-uploaded.
 *
 * Sites that have never been ordered are deleted outright. Sites that carry
 * orders are archived instead - Listing -> Order cascades in the database, so
 * deleting one of those would delete the payment history with it. Archived sites
 * leave the marketplace immediately, exactly like deleted ones, and re-uploading
 * the same domain creates a fresh listing.
 *
 * Guarded by typing DELETE, because there is no undo.
 */
export async function deletePublisherListingsAction(formData: FormData) {
  const auditAdmin = await requireRole("admin");
  await audit(auditAdmin, "deletePublisherListingsAction", null, formSummary(formData));
  const id = parseInt(String(formData.get("id") || "0"));
  const back = `/admin/users/${id}`;
  const pub = await prisma.user.findUnique({ where: { id } });
  if (!pub) redirect(`/admin/users?error=${q("Publisher not found.")}`);

  const confirm = String(formData.get("confirm") || "").trim().toUpperCase();
  if (confirm !== "DELETE")
    redirect(`${back}?error=${q('Type DELETE in the box to remove every website for this publisher.')}`);

  const listings = await prisma.listing.findMany({ where: { publisherId: id }, select: { id: true } });
  const ids = listings.map((l) => l.id);
  if (ids.length === 0) redirect(`${back}?error=${q("This publisher has no websites listed.")}`);

  // Which of them have order history and therefore must be kept as records.
  const orders = await prisma.order.findMany({
    where: { listingId: { in: ids } },
    select: { listingId: true },
  });
  const withOrders = new Set(orders.map((o) => o.listingId));
  const removable = ids.filter((i) => !withOrders.has(i));

  let archived = 0;
  if (withOrders.size > 0) {
    const res = await prisma.listing.updateMany({
      where: { id: { in: Array.from(withOrders) } },
      data: { status: STATUS_ARCHIVED },
    });
    archived = res.count;
  }

  let deleted = 0;
  for (let i = 0; i < removable.length; i += 250) {
    const res = await prisma.listing.deleteMany({ where: { id: { in: removable.slice(i, i + 250) } } });
    deleted += res.count;
  }

  console.log(`[admin] cleared publisher ${id} (${pub!.email}): deleted ${deleted}, archived ${archived}`);

  revalidatePath(back);
  revalidatePath("/admin/listings");
  revalidatePath("/marketplace");
  const msg =
    `Removed ${deleted + archived} website(s) for ${pub!.name}.` +
    (archived
      ? ` ${archived} had orders on them, so they were archived instead of deleted - the payment history stays intact and they are off the marketplace.`
      : "") +
    " You can re-upload the spreadsheet now.";
  redirect(`${back}?success=${q(msg)}`);
}

/**
 * Repair country names already in the database.
 *
 * Sites uploaded before country matching existed kept whatever the sheet said
 * ("dr congo", "Ivory Coast"), which no country filter ever matched. This walks
 * every distinct country value and rewrites the ones it recognises.
 */
export async function normalizeListingCountriesAction() {
  const auditAdmin = await requireRole("admin");
  await audit(auditAdmin, "normalizeListingCountriesAction", null, formSummary(null));
  const listings = await prisma.listing.findMany({ select: { country: true } });

  const counts = new Map<string, number>();
  for (const l of listings) counts.set(l.country, (counts.get(l.country) || 0) + 1);

  let fixed = 0;
  const renamed: string[] = [];
  const unknown: [string, number][] = [];

  for (const [raw, n] of Array.from(counts.entries())) {
    const canonical = normalizeCountry(raw);
    if (!canonical) {
      if (raw.trim()) unknown.push([raw, n]);
      continue;
    }
    if (canonical === raw) continue;
    const res = await prisma.listing.updateMany({ where: { country: raw }, data: { country: canonical } });
    fixed += res.count;
    renamed.push(`"${raw}" -> ${canonical} (${res.count})`);
  }

  console.log(`[countries] fixed ${fixed} listing(s): ${renamed.join("; ") || "none"}`);

  revalidatePath("/admin/listings");
  revalidatePath("/marketplace");
  revalidatePath("/");

  if (fixed === 0 && unknown.length === 0)
    redirect(`/admin/listings?success=${q("Every website already uses a recognised country name.")}`);

  unknown.sort((a, b) => b[1] - a[1]);
  const msg =
    (fixed
      ? `Corrected ${fixed} website(s): ${renamed.slice(0, 6).join(", ")}${renamed.length > 6 ? `, and ${renamed.length - 6} more` : ""}.`
      : "No country names needed correcting.") +
    (unknown.length
      ? ` ${unknown.reduce((n, [, c]) => n + c, 0)} website(s) still use a name we do not recognise: ` +
        unknown.slice(0, 8).map(([name, c]) => `"${name}" (${c})`).join(", ") +
        (unknown.length > 8 ? ` and ${unknown.length - 8} more` : "") + "."
      : "");
  redirect(`/admin/listings?success=${q(msg)}`);
}

/** Super admin: permanently delete any user (and their sites/orders via cascade). */
export async function deleteUserAction(formData: FormData) {
  const me = await requireRole("admin");
  await audit(me, "deleteUserAction", null, formSummary(formData));
  const id = parseInt(String(formData.get("id") || "0"));
  if (id === me.id) redirect(`/admin/users?error=${q("You cannot delete your own account.")}`);
  const target = await prisma.user.findUnique({ where: { id } });
  if (!target) redirect(`/admin/users?error=${q("User not found.")}`);

  // Simulated buyers follow their own rules: deleting one outright would also
  // delete completed orders that are publishers' records of money owed or
  // paid. See removeSimulatedAccount.
  if (target!.isSimulated) {
    const res = await removeSimulatedAccount(id);
    revalidatePath("/admin/users");
    revalidatePath("/admin/simulated");
    redirect(simulatedRemoveRedirect("/admin/users", res));
  }

  // Publishers and invites that point at this buyer are cleaned up first
  // (lib/buyer-cleanup.ts).
  const demoted = target!.role === "buyer" ? await detachBuyer(id) : 0;

  await prisma.user.delete({ where: { id } });
  revalidatePath("/admin/users");
  revalidatePath("/marketplace");
  redirect(
    `/admin/users?success=${q(
      "Deleted " + target!.email + "." +
      (demoted ? ` ${demoted} site(s) they had introduced now use standard pricing.` : "")
    )}`
  );
}

/** Approve a publisher request: create an invite and email them the sign-up link. */
export async function approveApplicationAction(formData: FormData) {
  const auditAdmin = await requireRole("admin");
  await audit(auditAdmin, "approveApplicationAction", null, formSummary(formData));
  const id = parseInt(String(formData.get("id") || "0"));
  const app = await prisma.publisherApplication.findUnique({ where: { id } });
  if (!app) redirect(`/admin/applications?error=${q("Request not found.")}`);

  const existing = await prisma.user.findUnique({ where: { email: app!.email } });
  if (existing) {
    await prisma.publisherApplication.update({ where: { id }, data: { status: "approved" } });
    redirect(`/admin/applications?error=${q("An account already exists for that email.")}`);
  }

  const token = randomBytes(24).toString("hex");
  await prisma.invite.create({
    data: { email: app!.email, token, role: "publisher", expiresAt: new Date(Date.now() + 7 * 86400_000) },
  });
  const link = `${appUrl()}/accept-invite?token=${token}`;
  if (emailEnabled()) await sendInviteEmail(app!.email, link);
  await prisma.publisherApplication.update({ where: { id }, data: { status: "approved" } });
  revalidatePath("/admin/applications");
  redirect(`/admin/applications?success=${q(emailEnabled() ? "Approved. Sign-up link emailed to " + app!.email : "Approved. Share this link: " + link)}`);
}

/** Reject a publisher request: email the applicant with an optional note. */
export async function rejectApplicationAction(formData: FormData) {
  const auditAdmin = await requireRole("admin");
  await audit(auditAdmin, "rejectApplicationAction", null, formSummary(formData));
  const id = parseInt(String(formData.get("id") || "0"));
  const note = String(formData.get("note") || "").trim();
  const app = await prisma.publisherApplication.findUnique({ where: { id } });
  if (!app) redirect(`/admin/applications?error=${q("Request not found.")}`);
  if (emailEnabled()) await sendApplicationRejected(app!.email, note);
  await prisma.publisherApplication.update({ where: { id }, data: { status: "rejected" } });
  revalidatePath("/admin/applications");
  redirect(`/admin/applications?success=${q("Request rejected and the applicant was notified.")}`);
}

export async function markPublisherPaidAction(formData: FormData) {
  const auditAdmin = await requireRole("admin");
  await audit(auditAdmin, "markPublisherPaidAction", null, formSummary(formData));
  const orderId = parseInt(String(formData.get("orderId") || "0"));
  const order = await prisma.order.findUnique({ where: { id: orderId } });
  if (!order || !["live", "completed"].includes(order.status)) {
    redirect(`/admin/orders?error=${q("The link must be live before you can pay the publisher.")}`);
  }
  // Part of a withdrawal request: pay it there, or the request total and the
  // orders it covers would no longer agree.
  if (order!.withdrawalId) {
    redirect(`/admin/withdrawals?error=${q(`Order #${orderId} is in withdrawal #${order!.withdrawalId}. Pay or decline it here.`)}`);
  }
  // Paying settles the order: mark paid and close it (releases the buyer's hold).
  await prisma.order.update({
    where: { id: orderId },
    data: { publisherPaid: true, status: "completed" },
  });

  // Tell the publisher their payment was approved.
  if (emailEnabled()) {
    const full = await prisma.order.findUnique({
      where: { id: orderId },
      include: { listing: { include: { publisher: true } } },
    });
    const pub = full?.listing.publisher;
    if (pub) await sendPublisherPaid(pub.email, orderId, full!.listing.domain);
  }

  revalidatePath("/admin/orders");
  redirect(`/admin/orders?success=${q("Publisher marked as paid. Buyer hold released.")}`);
}
