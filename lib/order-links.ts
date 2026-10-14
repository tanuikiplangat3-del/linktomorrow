// Signed links that go out in order emails, so a publisher can act on an order
// straight from their inbox without signing in (added 8 Oct 2026).
//
// A link carries the order id, who it is for, what it may do (its "scope") and
// an expiry, signed with AUTH_SECRET. Nothing is stored in the database: the
// signature is the proof. Changing AUTH_SECRET invalidates every emailed link,
// the same way it signs everyone out.
//
// Scopes:
//   "publisher"  the order's publisher. Opens /publish/[id]: read the brief,
//                download the files, confirm receipt, submit the live URL.
//   "file"       the admin desk. Downloads the order's files only. It can never
//                change an order.
//
// The links do not grant anything the publisher could not already do signed in,
// and every action re-checks the order's status and owner, exactly like the
// signed-in buttons. A link to an order that has moved on simply shows its
// current state.
//
// lib/email.ts must never import this file (it would pull "crypto" into the
// edge bundle and fail the build). Links are built by the caller and passed in.

import { createHmac, timingSafeEqual } from "crypto";
import { appUrl } from "./app-url";

export type OrderLinkScope = "publisher" | "file";

/** How long an emailed link works. Longest turnaround is 10 days; this leaves room. */
const LINK_DAYS = 30;

/**
 * The signing key. Same rule as lib/auth.ts: no fallback in production, because
 * the code is public and a default key would let anyone forge a link. Read
 * lazily so `next build` can load this file without the production environment.
 */
function key(): string {
  const s = process.env.AUTH_SECRET || "";
  if (s.length >= 32) return s;
  if (process.env.NODE_ENV === "production") {
    throw new Error("AUTH_SECRET is missing or shorter than 32 characters. Refusing to sign or read order links.");
  }
  return "local-development-only-secret-not-for-production";
}

function sign(scope: OrderLinkScope, orderId: number, userId: number, exp: number): string {
  // Prefixed so this signature can never be mistaken for any other use of the key.
  return createHmac("sha256", key())
    .update(`order-link-v1:${scope}:${orderId}:${userId}:${exp}`)
    .digest("base64url");
}

/** A fresh token for one order, one person, one scope. */
export function orderLinkToken(scope: OrderLinkScope, orderId: number, userId: number, now = Date.now()): string {
  const exp = Math.floor(now / 1000) + LINK_DAYS * 86400;
  return `${userId}.${exp}.${sign(scope, orderId, userId, exp)}`;
}

/**
 * Check a token. Returns the user id it was issued to, or null when it is
 * malformed, forged, for another order or scope, or expired.
 */
export function verifyOrderLink(scope: OrderLinkScope, orderId: number, token: unknown): number | null {
  const t = String(token ?? "");
  const m = /^(\d{1,10})\.(\d{1,12})\.([A-Za-z0-9_-]{43})$/.exec(t);
  if (!m || !Number.isFinite(orderId) || orderId <= 0) return null;
  const userId = parseInt(m[1], 10);
  const exp = parseInt(m[2], 10);
  if (exp * 1000 < Date.now()) return null;
  const want = Buffer.from(sign(scope, orderId, userId, exp));
  const got = Buffer.from(m[3]);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
  return userId;
}

/** The no-sign-in page where the publisher handles the order. */
export function publisherDeskUrl(orderId: number, publisherId: number): string {
  return `${appUrl()}/publish/${orderId}?k=${encodeURIComponent(orderLinkToken("publisher", orderId, publisherId))}`;
}

export type OrderFileKind = "doc" | "image" | "text";

/** A direct download of one of the order's files. */
export function orderFileUrl(scope: OrderLinkScope, orderId: number, userId: number, file: OrderFileKind): string {
  return `${appUrl()}/api/order-file/${orderId}?f=${file}&s=${scope}&k=${encodeURIComponent(orderLinkToken(scope, orderId, userId))}`;
}

/** The same download, for a token already verified on a page (keeps its expiry). */
export function orderFileUrlWithToken(scope: OrderLinkScope, orderId: number, token: string, file: OrderFileKind): string {
  return `${appUrl()}/api/order-file/${orderId}?f=${file}&s=${scope}&k=${encodeURIComponent(token)}`;
}
