// Intentionally empty (Cloudflare Workers, Nov 2026).
//
// On the old Docker/ECS server this file started two in-app timers: the
// 5-minute turnaround auto-cancel and the weekly Domain Rating refresh. A
// Worker has no long-running process, so those jobs now run from Cloudflare
// Cron Triggers: see worker.ts and app/api/cron/[job]/route.ts.

export async function register() {}
