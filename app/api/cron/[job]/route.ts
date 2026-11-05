// The two background jobs, on Cloudflare Workers (Nov 2026).
//
// On the old Docker server these ran on in-app timers (instrumentation.ts). A
// Worker has no long-running process, so Cloudflare Cron Triggers call
// worker.ts's scheduled() handler, which calls this route INSIDE the Worker.
//
// This route can never be reached from the internet: worker.ts answers 404 to
// any outside request for /api/cron/ before Next.js sees it, and scheduled()
// adds the internal marker header checked below as a second lock.
//
//   orders   every 5 minutes: cancel orders whose turnaround has run out
//   metrics  every 6 hours:   refresh Domain Rating for listings due a refresh

import { NextResponse } from "next/server";
import { cancelExpiredOrders } from "@/lib/order-scheduler";
import { runMetricsPass } from "@/lib/metrics-scheduler";

export const dynamic = "force-dynamic";

const CRON_HEADER = "x-linktomorrow-cron";

export async function GET(req: Request, props: { params: Promise<{ job: string }> }) {
  if (req.headers.get(CRON_HEADER) !== "1") return new NextResponse("Not found", { status: 404 });
  const { job } = await props.params;

  if (job === "orders") {
    try {
      const n = await cancelExpiredOrders();
      if (n > 0) console.log(`[orders] turnaround sweep: ${n} order(s) auto-cancelled and refunded`);
      return NextResponse.json({ ok: true, cancelled: n });
    } catch (e: any) {
      console.error("[orders] turnaround sweep failed:", e?.message || e);
      return NextResponse.json({ ok: false }, { status: 500 });
    }
  }
  if (job === "metrics") {
    await runMetricsPass(); // logs its own result and errors
    return NextResponse.json({ ok: true });
  }
  return new NextResponse("Not found", { status: 404 });
}
