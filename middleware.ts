import { NextRequest, NextResponse } from "next/server";

/**
 * Content-Security-Policy, with a fresh nonce for every page.
 *
 * Only scripts that carry this request's nonce may run. Next.js adds the nonce
 * to its own scripts automatically. Anything an attacker manages to put into a
 * page (an injected <script>, an onerror= attribute, a javascript: link) has no
 * nonce and is refused by the browser. This is the second line of defence
 * behind validating input; see lib/safe-url.ts for the first.
 *
 * Styles allow 'unsafe-inline' because the app uses inline style attributes,
 * which a nonce cannot cover. Inline styles cannot run code.
 *
 * Cloudflare Workers (Nov 2026): this is middleware.ts on the edge runtime, not
 * Next 16's proxy.ts. proxy.ts always runs as Node.js middleware, which the
 * Cloudflare adapter supports only experimentally; edge middleware is its
 * supported path. Same policy, same matcher. btoa replaces Buffer, which the
 * edge runtime does not have.
 */
export function middleware(request: NextRequest) {
  const nonce = btoa(crypto.randomUUID());
  const isDev = process.env.NODE_ENV === "development";

  const csp = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${isDev ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' data: https://fonts.gstatic.com",
    // Images: our own, uploaded ones (data:), and https links (the logo lives
    // on welcometomorrow.io, and buyers may link a featured image).
    "img-src 'self' data: blob: https:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    // Forms post to us; card payment redirects to Stripe Checkout.
    "form-action 'self' https://checkout.stripe.com",
    "frame-ancestors 'none'",
  ].join("; ");

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", csp);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("Content-Security-Policy", csp);
  return response;
}

export const config = {
  matcher: [
    {
      // Pages only. API routes (the Stripe webhook, the health check), static
      // files and icons do not render HTML and need no policy.
      source: "/((?!api|_next/static|_next/image|favicon.ico|icon.png|apple-icon.png|email-logo.png).*)",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
  ],
};
