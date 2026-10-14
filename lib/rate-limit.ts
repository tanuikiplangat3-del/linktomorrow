// Attempt limits for everything an anonymous visitor can hammer: sign-in,
// email codes, password resets, sign-ups, the chat and the publisher form.
//
// Counted in Postgres (the RateLimit table) so the limit holds across restarts
// and across more than one container. At this traffic a counter row per key is
// cheap. The read-then-write below can let a burst of simultaneous requests
// slightly overshoot a limit; that is acceptable for a rate limit, which only
// has to make guessing slow, not exact.
//
// Two kinds of key are used together:
//   - per email address: cannot be dodged by changing IP, protects one account
//   - per IP address: stops one machine working through many accounts

import { headers } from "next/headers";
import { prisma } from "@/lib/prisma";

export type Limit = { max: number; windowSeconds: number };

export const LIMITS = {
  loginPerEmail: { max: 8, windowSeconds: 15 * 60 },
  loginPerIp: { max: 30, windowSeconds: 15 * 60 },
  codePerEmail: { max: 10, windowSeconds: 60 * 60 },
  resendPerEmail: { max: 5, windowSeconds: 60 * 60 },
  forgotPerEmail: { max: 5, windowSeconds: 60 * 60 },
  forgotPerIp: { max: 20, windowSeconds: 60 * 60 },
  resetPerIp: { max: 20, windowSeconds: 60 * 60 },
  registerPerIp: { max: 10, windowSeconds: 60 * 60 },
  invitePerIp: { max: 10, windowSeconds: 60 * 60 },
  contactPerIp: { max: 5, windowSeconds: 60 * 60 },
  applyPerIp: { max: 5, windowSeconds: 60 * 60 },
  publisherLinkPerBuyer: { max: 20, windowSeconds: 24 * 60 * 60 },
  // Emailed order links (no sign-in): file downloads and the two publisher steps.
  orderLinkPerIp: { max: 60, windowSeconds: 60 * 60 },
} satisfies Record<string, Limit>;

export const TOO_MANY = "Too many attempts. Please wait a while and try again.";

/**
 * The visitor's IP address.
 *
 * The app sits behind the AWS load balancer, which APPENDS the address it saw
 * to X-Forwarded-For. Anything earlier in that header was written by the
 * visitor and can be faked, so only the LAST entry is trusted. If the site is
 * later put behind Cloudflare's proxy, the last entry becomes a Cloudflare
 * address; the per-email limits still hold, and this function is the one place
 * to change.
 */
export async function clientIp(): Promise<string> {
  const h = await headers();
  const xff = h.get("x-forwarded-for") || "";
  const parts = xff.split(",").map((p) => p.trim()).filter(Boolean);
  return parts[parts.length - 1] || h.get("x-real-ip") || "unknown";
}

/**
 * Count one attempt against `key`. Returns true while the caller is within the
 * limit, false once they are over it.
 */
export async function hit(key: string, limit: Limit): Promise<boolean> {
  const now = new Date();
  const k = key.slice(0, 200);
  try {
    const row = await prisma.rateLimit.findUnique({ where: { key: k } });
    if (!row || row.resetAt <= now) {
      await prisma.rateLimit.upsert({
        where: { key: k },
        create: { key: k, count: 1, resetAt: new Date(now.getTime() + limit.windowSeconds * 1000) },
        update: { count: 1, resetAt: new Date(now.getTime() + limit.windowSeconds * 1000) },
      });
      return true;
    }
    const updated = await prisma.rateLimit.update({ where: { key: k }, data: { count: { increment: 1 } } });
    return updated.count <= limit.max;
  } catch (e: any) {
    // Never lock everyone out because the counter table had a hiccup.
    console.error(`[rate-limit] could not count ${k}: ${e?.message || e}`);
    return true;
  }
}

/** True if every key is within its limit. All keys are counted either way. */
export async function allow(checks: Array<[string, Limit]>): Promise<boolean> {
  const results = await Promise.all(checks.map(([k, l]) => hit(k, l)));
  return results.every(Boolean);
}

/** Clear a counter, e.g. the per-email login count after a successful sign-in. */
export async function clear(key: string): Promise<void> {
  await prisma.rateLimit.deleteMany({ where: { key: key.slice(0, 200) } }).catch(() => {});
}

/** Drop expired rows. Called opportunistically; the table stays small. */
export async function sweepExpired(): Promise<void> {
  await prisma.rateLimit.deleteMany({ where: { resetAt: { lt: new Date() } } }).catch(() => {});
}
