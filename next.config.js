/** @type {import('next').NextConfig} */

// Security headers sent with every response. The Content-Security-Policy is
// not here: it carries a fresh nonce per request, so it is set in proxy.ts.
const securityHeaders = [
  // Browsers only ever talk to this site over HTTPS, for a year.
  { key: "Strict-Transport-Security", value: "max-age=31536000" },
  // No other site may put these pages in a frame (clickjacking).
  { key: "X-Frame-Options", value: "DENY" },
  // Files are treated as the type we say they are, never guessed.
  { key: "X-Content-Type-Options", value: "nosniff" },
  // Other sites see only our domain in the Referer header, never full URLs.
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  // The app uses none of these, so no page can ask for them.
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=(), usb=()" },
];

const nextConfig = {
  reactStrictMode: true,
  // Cloudflare Workers (Nov 2026): loaded at run time by the Worker rather than
  // bundled by Next.js, as the Cloudflare adapter requires for Prisma and pg.
  serverExternalPackages: ["@prisma/client", ".prisma/client", "@prisma/adapter-pg", "pg"],
  // Served under tools.welcometomorrow.io/linktomorrow (sibling of /ranktomorrow)
  basePath: "/linktomorrow",
  // Self-contained server build for a small Docker image (matches ranktomorrow)
  output: "standalone",
  // Do not announce which framework runs the site.
  poweredByHeader: false,
  // next/image is not used. No remote hosts are allowed through the optimizer.
  images: {
    unoptimized: true,
  },
  experimental: {
    // Buyers upload a featured image (4MB) and an article document (6MB) with
    // an order, so the Server Action body limit is raised to fit both.
    serverActions: { bodySizeLimit: "12mb" },
  },
  // Type errors stop the build. The whole project type-checks cleanly, so a
  // new error is a real bug and must not reach production.
  typescript: { ignoreBuildErrors: false },
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};
module.exports = nextConfig;
