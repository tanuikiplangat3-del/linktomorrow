// Weekly Domain Rating refresh, running inside the app itself.
// (Monthly traffic is publisher-entered and is never refreshed from Ahrefs.)
//
// Deliberately not an AWS cron / EventBridge job: this needs no extra AWS setup
// and no public endpoint to secure. The container wakes up every few hours,
// asks lib/metrics which listings are older than 7 days, and refreshes those.
// Anything it does not finish in one pass is simply picked up on the next.

import { ahrefsEnabled } from "@/lib/ahrefs";

const CHECK_EVERY_MS = 6 * 60 * 60 * 1000; // look for due listings every 6 hours
const FIRST_RUN_DELAY_MS = 2 * 60 * 1000; // let the container finish booting first
const RUN_BUDGET_MS = 4 * 60 * 1000; // work for up to 4 minutes per pass
const RUN_MAX_ITEMS = 500;

let started = false;
let running = false;

/** One refresh pass. Exported for the Cloudflare cron (app/api/cron/[job]). */
export async function runMetricsPass() {
  return runOnce();
}

async function runOnce() {
  if (running) return; // never let two passes overlap
  if (!ahrefsEnabled()) return; // no key - nothing to do, and lib/ahrefs already logged it
  running = true;
  try {
    const { refreshDueMetrics } = await import("@/lib/metrics");
    const r = await refreshDueMetrics({ maxItems: RUN_MAX_ITEMS, budgetMs: RUN_BUDGET_MS });
    if (r.processed > 0) {
      console.log(
        `[metrics] weekly refresh: ${r.updated} updated, ${r.failed} unreachable, ${r.remaining} still due`
      );
    }
  } catch (e: any) {
    console.error("[metrics] weekly refresh failed:", e?.message || e);
  } finally {
    running = false;
  }
}

/** Called once from instrumentation.ts when the server process starts. */
export function startMetricsScheduler() {
  if (started) return;
  started = true;
  setTimeout(runOnce, FIRST_RUN_DELAY_MS).unref?.();
  setInterval(runOnce, CHECK_EVERY_MS).unref?.();
  console.log("[metrics] weekly DR refresh scheduler started");
}
