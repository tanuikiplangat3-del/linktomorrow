import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { requireRole } from "@/lib/auth";
import { money } from "@/lib/money";
import { Flash } from "@/components/ui";
import { deleteUserAction, approveBuyerAction, rejectBuyerAction } from "@/app/actions/admin";
import { isRetiredEmail } from "@/lib/simulated";
import { FOUNDER_BUYER_LIMIT } from "@/lib/money";
import { resetDemoDataAction } from "@/app/actions/demo";
import { DEMO_BUYER_EMAIL, DEMO_PUBLISHER_EMAIL, DEMO_SITES } from "@/lib/demo";

export const metadata = { title: "Users" };

export default async function AdminUsers(
  props: {
    searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
  }
) {
  const searchParams = await props.searchParams;
  const me = await requireRole("admin");
  // Deleted simulated accounts kept only for their completed orders are not
  // people any more, so they are not listed (see lib/simulated.ts).
  const users = (await prisma.user.findMany({ orderBy: { createdAt: "desc" } })).filter((u) => !isRetiredEmail(u.email));

  const publishers = users.filter((u) => u.role === "publisher");
  // Buyers who signed up and are waiting for an admin. They cannot sign in
  // until approved here. Confirmed emails first: those are the real queue.
  const awaiting = users
    .filter((u) => u.role === "buyer" && u.approvalStatus === "pending")
    .sort((a, b) => Number(b.verified) - Number(a.verified));
  const buyers = users.filter((u) => u.role === "buyer" && u.approvalStatus !== "pending");
  const admins = users.filter((u) => u.role === "admin");
  const founders = users.filter((u) => u.founderNumber !== null).length;
  const demoReady = users.some((u) => u.email === DEMO_BUYER_EMAIL) && users.some((u) => u.email === DEMO_PUBLISHER_EMAIL);
  // Publishers a buyer brought in through a link, so the pricing on their sites
  // is visible from here rather than only in the database.
  const buyerById = new Map<number, any>(users.map((u) => [u.id, u]));

  return (
    <div>
      <h1 className="h2 mb-1">Users</h1>
      <p className="muted mb-6">
        Publishers and buyers, kept separate. {founders} of {FOUNDER_BUYER_LIMIT} founding
        buyer places taken. Founding buyers see the whole marketplace without depositing,
        for life.
      </p>
      <Flash searchParams={searchParams} />

      <Section title="Buyers awaiting approval" count={awaiting.length}>
        <p className="muted mb-3 text-sm">
          New buyers cannot sign in until you approve them. Approving emails them that they can
          sign in. Rejecting keeps the account, so you can still approve it later.
        </p>
        <ApprovalTable users={awaiting} />
      </Section>

      <div className="card mb-8 border-wt-yellow/40">
        <h2 className="h3 mb-1">Demo accounts</h2>
        <p className="muted mb-4 text-sm">
          A separate sandbox for showing the platform. The demo buyer and demo publisher only ever
          see {DEMO_SITES.length} demo websites, and nobody else can see them. Two of the
          {" "}{DEMO_SITES.length} are attributed to the demo buyer, and one of those costs the same
          as a site that is not, so the price difference shows on screen.
          {demoReady
            ? " The accounts exist. Running this again resets the websites and sets a new password."
            : " Not created yet."}
        </p>
        <form action={resetDemoDataAction} className="flex flex-wrap items-end gap-3">
          <label className="field mb-0 flex-1">
            <span>Password for both demo accounts</span>
            <input className="input" type="password" name="demoPassword" required autoComplete="new-password" />
          </label>
          <button className="btn-accent" type="submit">
            {demoReady ? "Reset demo data" : "Create demo data"}
          </button>
        </form>
        <p className="muted mt-3 text-xs">
          Sign in as <span className="font-mono">{DEMO_BUYER_EMAIL}</span> or{" "}
          <span className="font-mono">{DEMO_PUBLISHER_EMAIL}</span>.
        </p>
      </div>

      <Section title="Publishers" count={publishers.length}>
        <UserTable users={publishers} meId={me.id} kind="publisher" buyerById={buyerById} />
      </Section>

      <Section title="Buyers" count={buyers.length}>
        <UserTable users={buyers} meId={me.id} kind="buyer" buyerById={buyerById} />
      </Section>

      <Section title="Admins" count={admins.length}>
        <UserTable users={admins} meId={me.id} kind="admin" buyerById={buyerById} />
      </Section>
    </div>
  );
}

function Section({ title, count, children }: { title: string; count: number; children: React.ReactNode }) {
  return (
    <div className="mb-8">
      <h2 className="h3 mb-3">{title} <span className="muted text-base font-normal">({count})</span></h2>
      {children}
    </div>
  );
}

function UserTable({
  users,
  meId,
  kind,
  buyerById,
}: {
  users: any[];
  meId: number;
  kind: string;
  buyerById: Map<number, any>;
}) {
  if (users.length === 0) return <div className="card muted">None yet.</div>;
  return (
    <div className="card overflow-x-auto">
      <table className="table-wt">
        <thead>
          <tr>
            <th>Name</th><th>Email</th>
            {kind === "buyer" && <th>Balance</th>}
            {kind === "buyer" && <th>Founding</th>}
            {kind === "publisher" && <th>Brought in by</th>}
            <th>Verified</th><th>Joined</th><th></th>
          </tr>
        </thead>
        <tbody>
          {users.map((u) => (
            <tr key={u.id}>
              <td className="font-semibold">
                {u.role === "publisher" ? (
                  <Link href={`/admin/users/${u.id}`} className="text-wt-green hover:underline">{u.name}</Link>
                ) : (
                  u.name
                )}
                {u.isDemo && <span className="badge badge-yellow ml-2">demo</span>}
                {u.approvalStatus === "rejected" && <span className="badge badge-red ml-2">rejected</span>}
              </td>
              <td className="muted">{u.email}</td>
              {kind === "buyer" && <td>{money(u.balanceCents)}</td>}
              {kind === "buyer" && (
                <td>
                  {u.founderNumber !== null ? (
                    <span className="badge badge-green">#{u.founderNumber}</span>
                  ) : (
                    <span className="muted">-</span>
                  )}
                </td>
              )}
              {kind === "publisher" && (
                <td className="muted">
                  {u.invitedByBuyerId
                    ? buyerById.get(u.invitedByBuyerId)?.name || `buyer #${u.invitedByBuyerId}`
                    : "-"}
                </td>
              )}
              <td>{u.verified ? "✓" : "-"}</td>
              <td className="muted">{u.createdAt.toISOString().slice(0, 10)}</td>
              <td className="text-right">
                <div className="flex justify-end gap-2">
                  {u.approvalStatus === "rejected" && (
                    <form action={approveBuyerAction}>
                      <input type="hidden" name="id" value={u.id} />
                      <button type="submit" className="btn-primary btn-sm">Approve</button>
                    </form>
                  )}
                  {u.id !== meId && (
                    <form action={deleteUserAction}>
                      <input type="hidden" name="id" value={u.id} />
                      <button type="submit" className="btn-danger btn-sm">Delete</button>
                    </form>
                  )}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ApprovalTable({ users }: { users: any[] }) {
  if (users.length === 0) return <div className="card muted">Nobody is waiting.</div>;
  return (
    <div className="card overflow-x-auto">
      <table className="table-wt">
        <thead>
          <tr>
            <th>Name</th><th>Email</th><th>Email confirmed</th><th>Signed up</th><th></th>
          </tr>
        </thead>
        <tbody>
          {users.map((u) => (
            <tr key={u.id}>
              <td className="font-semibold">{u.name}</td>
              <td className="muted">{u.email}</td>
              <td>{u.verified ? "\u2713" : <span className="muted">Not yet</span>}</td>
              <td className="muted">{u.createdAt.toISOString().slice(0, 10)}</td>
              <td className="text-right">
                <div className="flex justify-end gap-2">
                  <form action={approveBuyerAction}>
                    <input type="hidden" name="id" value={u.id} />
                    <button type="submit" className="btn-primary btn-sm">Approve</button>
                  </form>
                  <form action={rejectBuyerAction}>
                    <input type="hidden" name="id" value={u.id} />
                    <button type="submit" className="btn-danger btn-sm">Reject</button>
                  </form>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
