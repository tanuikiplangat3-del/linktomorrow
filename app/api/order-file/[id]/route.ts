// Download one of an order's files from an emailed link (added 8 Oct 2026).
//
//   /api/order-file/12?f=doc|image|text&s=publisher|file&k=<signed token>
//
// The token is checked against the order and scope (lib/order-links.ts). A
// publisher token must still belong to the listing's current publisher. Files
// are only ever sent as downloads (Content-Disposition: attachment) of the
// types the upload accepted, never shown as a page on our site.

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { verifyOrderLink, type OrderLinkScope } from "@/lib/order-links";
import { safeDataUrl, featuredImageHref, DOCUMENT_TYPES, IMAGE_TYPES } from "@/lib/safe-url";
import { allow, clientIp, LIMITS } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

const EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};

function plain(status: number, message: string) {
  return new NextResponse(message, {
    status,
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
  });
}

function fileResponse(body: Buffer, type: string, name: string) {
  // The stored name was already cut down to letters, digits, dot, dash, space
  // and underscore on upload; this repeats it so the header can never break.
  const safeName = name.replace(/[^\w.\- ]+/g, "_").slice(0, 120) || "download";
  return new NextResponse(new Uint8Array(body), {
    status: 200,
    headers: {
      "Content-Type": type,
      "Content-Disposition": `attachment; filename="${safeName}"`,
      "Content-Length": String(body.length),
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox",
    },
  });
}

/** Decode a data: URL that passed safeDataUrl. */
function decode(dataUrl: string): { type: string; body: Buffer } {
  const comma = dataUrl.indexOf(",");
  const type = dataUrl.slice(5, dataUrl.indexOf(";")).toLowerCase();
  return { type, body: Buffer.from(dataUrl.slice(comma + 1), "base64") };
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const orderId = parseInt(id, 10);
  const sp = req.nextUrl.searchParams;
  const scope = sp.get("s") === "file" ? "file" : ("publisher" as OrderLinkScope);
  const kind = sp.get("f");

  if (!(await allow([[`orderlink:ip:${await clientIp()}`, LIMITS.orderLinkPerIp]]))) {
    return plain(429, "Too many downloads. Please wait a while and try again.");
  }
  const userId = verifyOrderLink(scope, orderId, sp.get("k"));
  if (userId === null) {
    return plain(403, "This download link has expired or is not valid. Sign in to Link Tomorrow and open the order from Orders.");
  }

  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: {
      articleDocUrl: true,
      articleDocName: true,
      featuredImage: true,
      articleContent: true,
      listing: { select: { publisherId: true } },
    },
  });
  if (!order) return plain(404, "This order no longer exists.");
  // Admin-desk links are issued to user 0; publisher links to the publisher,
  // and only while they still own the listing.
  if (scope === "file" ? userId !== 0 : order.listing.publisherId !== userId) {
    return plain(403, "This download link can no longer be used. Sign in to Link Tomorrow and open the order from Orders.");
  }

  if (kind === "doc") {
    const doc = safeDataUrl(order.articleDocUrl, DOCUMENT_TYPES);
    if (!doc) return plain(404, "This order has no article document.");
    const { type, body } = decode(doc);
    return fileResponse(body, type, order.articleDocName || "article-document");
  }

  if (kind === "image") {
    const img = safeDataUrl(order.featuredImage, IMAGE_TYPES);
    if (img) {
      const { type, body } = decode(img);
      return fileResponse(body, type, `order-${orderId}-featured-image.${EXT[type] || "img"}`);
    }
    // The buyer gave a link to an image instead of uploading one. Send them
    // there; featuredImageHref only passes clean http(s) links.
    const href = featuredImageHref(order.featuredImage);
    if (href) return NextResponse.redirect(href, 302);
    return plain(404, "This order has no featured image.");
  }

  if (kind === "text") {
    const text = (order.articleContent || "").trim();
    if (!text) return plain(404, "The buyer did not paste any article text.");
    return fileResponse(Buffer.from(text.replace(/\r?\n/g, "\r\n"), "utf8"), "text/plain; charset=utf-8", `order-${orderId}-article.txt`);
  }

  return plain(400, "Unknown file.");
}
