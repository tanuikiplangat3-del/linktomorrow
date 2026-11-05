// The Cloudflare Worker that serves Link Tomorrow (moved from AWS ECS, Nov 2026).
//
// OpenNext builds the Next.js app into .open-next/worker.js. This file wraps it
// to add two things:
//
//   fetch      every visitor request. Requests for /api/cron/ from outside are
//              answered 404 here, so the background jobs can only be started
//              by Cloudflare itself.
//   scheduled  Cron Triggers (wrangler.jsonc). They replace the in-app timers
//              the Docker server used: the 5-minute turnaround sweep and the
//              6-hourly Domain Rating refresh.

// @ts-ignore: created by `opennextjs-cloudflare build`
import { default as handler } from "./.open-next/worker.js";

const BASE = "/linktomorrow";
const CRON_PATH = `${BASE}/api/cron/`;

// Which job each Cron Trigger runs. Must match "triggers.crons" in wrangler.jsonc.
const JOBS: Record<string, string> = {
  "*/5 * * * *": "orders",
  "17 */6 * * *": "metrics",
};

export default {
  async fetch(request: Request, env: any, ctx: any): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith(CRON_PATH)) return new Response("Not found", { status: 404 });
    const res: Response = await handler.fetch(request, env, ctx);
    // Lets a deploy check tell this Worker apart from the old AWS server.
    const out = new Response(res.body, res);
    out.headers.set("x-lt-runtime", "workers");
    return out;
  },

  async scheduled(event: { cron: string }, env: any, ctx: any): Promise<void> {
    const job = JOBS[event.cron];
    if (!job) {
      console.error(`[cron] no job for schedule "${event.cron}"`);
      return;
    }
    const origin = String(env.APP_URL || "https://tools.welcometomorrow.io/linktomorrow").replace(/\/linktomorrow\/?$/, "");
    const req = new Request(`${origin}${CRON_PATH}${job}`, { headers: { "x-linktomorrow-cron": "1" } });
    // Straight into the Next.js handler, past the 404 guard in fetch() above.
    const res = await handler.fetch(req, env, ctx);
    if (!res.ok) console.error(`[cron] ${job} finished with HTTP ${res.status}`);
  },
};
