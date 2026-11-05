// The database client, for Cloudflare Workers (moved from AWS ECS, Nov 2026).
//
// Two things are different from a normal Node server:
//
// 1. The connection goes through a driver adapter (pg over a TCP socket) rather
//    than Prisma's native engine, which cannot run on Workers.
// 2. A Worker may not reuse a network connection opened while serving another
//    request ("Cannot perform I/O on behalf of a different request"). So each
//    request gets its own client, created on first use and keyed on that
//    request's context. In production the connection goes to Hyperdrive,
//    Cloudflare's pool in front of Supabase, so a new client per request is
//    cheap: Hyperdrive keeps the real database connections open.
//
// The rest of the code keeps importing `prisma` exactly as before. It is a
// stand-in that forwards every call to the current request's client.

import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { getCloudflareContext } from "@opennextjs/cloudflare";

/** The app's tables live in the "ecopulse" schema, never "public". */
const SCHEMA = "ecopulse";

function connectionString(env: any): string {
  // Production: the Hyperdrive binding. Local tests: DATABASE_URL.
  const raw: string = env?.HYPERDRIVE?.connectionString || process.env.DATABASE_URL || "";
  if (!raw) throw new Error("No database configured: neither the HYPERDRIVE binding nor DATABASE_URL is set.");
  // "?schema=" is a Prisma URL option; Postgres itself would reject it as an
  // unknown startup parameter. The schema is passed to the adapter instead.
  const u = new URL(raw);
  u.searchParams.delete("schema");
  return u.toString();
}

function newClient(env: any): PrismaClient {
  const pool = new Pool({ connectionString: connectionString(env), max: 1 });
  return new PrismaClient({
    adapter: new PrismaPg(pool, { schema: SCHEMA }),
    log: ["error"],
  });
}

// One client per request. Keyed on the request's ExecutionContext, which is a
// fresh object for every request, so a WeakMap lets finished requests' clients
// be garbage collected.
const perRequest = new WeakMap<object, PrismaClient>();
// Outside a request (should not happen in the app; kept for scripts and tests).
let outside: PrismaClient | null = null;

function current(): PrismaClient {
  let ctx: { env: any; ctx: object } | null = null;
  try {
    ctx = getCloudflareContext() as any;
  } catch {
    ctx = null;
  }
  if (!ctx?.ctx) {
    if (!outside) outside = newClient(ctx?.env);
    return outside;
  }
  let c = perRequest.get(ctx.ctx);
  if (!c) {
    c = newClient(ctx.env);
    perRequest.set(ctx.ctx, c);
  }
  return c;
}

export const prisma: PrismaClient = new Proxy({} as PrismaClient, {
  get(_target, prop) {
    const c = current() as any;
    const v = c[prop];
    return typeof v === "function" ? v.bind(c) : v;
  },
});
