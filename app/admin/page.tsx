import { RETIRED_EMAIL_DOMAIN } from "@/lib/simulated";
import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { requireRole } from "@/lib/auth";
import { Flash } from "@/components/ui";
import { sendTestEmailAction } from "@/app/actions/admin";
import { countConflicts } from "@/lib/duplicates";

export default async function AdminHome(
  props: {
    searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
  }
) {
  const searchParams = await props.searchParams;
  await requireRole("admin");
  const [users, publishers, pending, orders, funded, invites] = await Promise.all([
    prisma.user.count(),
    prisma.user.count({ where: { role: "publisher" } }),
    prisma.listing.count({ where: { status: "pending" } }),
    prisma.order.count(),
    prisma.order.count({ where: { status: "funded" } }),
    prisma.invite.count({ where: { acceptedAt: null } }),
  ]);
  const siteRequests = await prisma.siteRequest.count({ where: { status: "pending" } });
  const conflicts = await countConflicts();
  const simulated = await prisma.user.count({ where: { isSimulated: true, NOT: { email: { endsWith: RETIRED_EMAIL_DOMAIN } } } });
  const payoutReviews = await prisma.user.count({ where: { role: "publisher", payStatus: "pending" } });
  const withdrawals = await prisma.withdrawal.count({ where: { status: "pending" } });
  const auditToday = await prisma.adminAudit.count({ where: { createdAt: { gte: new Date(Date.now() - 86400_000) } } });

  const cards = [
    { href: "/admin/listings", label: "Review listings", value: pending, hint: "pending" },
    { href: "/admin/conflicts", label: "Conflicts", value: conflicts, hint: "duplicate domains" },
    { href: "/admin/orders", label: "Orders", value: orders, hint: `${funded} funded` },
    { href: "/admin/site-requests", label: "Site requests", value: siteRequests, hint: "awaiting review" },
    { href: "/admin/invites", label: "Publisher invites", value: invites, hint: "open" },
    { href: "/admin/users", label: "Users", value: users, hint: `${publishers} publishers` },
    { href: "/admin/simulated", label: "Simulated accounts", value: simulated, hint: "our own buyers" },
    { href: "/admin/withdrawals", label: "Withdrawals", value: withdrawals, hint: "to pay" },
    { href: "/admin/payouts", label: "Payout methods", value: payoutReviews, hint: "awaiting review" },
    { href: "/admin/audit", label: "Audit log", value: auditToday, hint: "admin actions today" },
  ];

  return (
    <div>
      <h1 className="h2 mb-1">Admin</h1>
      <p className="muted mb-6">Manage the marketplace.</p>
      <Flash searchParams={searchParams} />
      <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
        {cards.map((c) => (
          <Link key={c.href} href={c.href} className="card hover:border-wt-green/50">
            <p className="muted text-sm">{c.label}</p>
            <p className="text-3xl font-bold">{c.value}</p>
            <p className="muted text-xs">{c.hint}</p>
          </Link>
        ))}
      </div>

      <div className="card mt-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="font-semibold">Check email delivery</p>
          <p className="muted text-sm">
            Sends a test message to the admin address. Use this to confirm notifications are
            working without having to take a payment first.
          </p>
        </div>
        <form action={sendTestEmailAction}>
          <button className="btn-ghost btn-sm" type="submit">Send test email</button>
        </form>
      </div>
    </div>
  );
}
