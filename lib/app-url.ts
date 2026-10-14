// The app's public address, for links in emails. Kept free of Node-only
// imports: lib/email.ts reaches the edge bundle through instrumentation.ts,
// where "crypto" does not exist and fails the build.

/** e.g. https://tools.welcometomorrow.io/linktomorrow */
export function appUrl(): string {
  return (process.env.APP_URL || "https://tools.welcometomorrow.io/linktomorrow").replace(/\/$/, "");
}

/** The signed-in order page. */
export function orderPageUrl(orderId: number): string {
  return `${appUrl()}/orders/${orderId}`;
}
