import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { SignJWT, jwtVerify } from "jose";
import bcrypt from "bcryptjs";
import { prisma } from "@/lib/prisma";
import type { User } from "@prisma/client";

const COOKIE = "linktomorrow_session";

// SESSION LENGTHS. Admins can move money, so their sessions are short. Anyone
// else stays signed in for a week. Both are absolute: activity does not extend
// them.
const ADMIN_SESSION_SECONDS = 60 * 60 * 12; // 12 hours
const USER_SESSION_SECONDS = 60 * 60 * 24 * 7; // 7 days

/**
 * The key sessions are signed with.
 *
 * There is deliberately NO fallback in production. The code is public, so a
 * default string here would let anyone sign a cookie for any user id. Read
 * lazily, not at import time, because `next build` loads this module without
 * the production environment.
 */
function secret(): Uint8Array {
  const s = process.env.AUTH_SECRET || "";
  if (s.length >= 32) return new TextEncoder().encode(s);
  if (process.env.NODE_ENV === "production") {
    throw new Error("AUTH_SECRET is missing or shorter than 32 characters. Refusing to sign or read sessions.");
  }
  return new TextEncoder().encode("local-development-only-secret-not-for-production");
}

export type Role = "buyer" | "publisher" | "admin";

// bcrypt reads only the first 72 bytes of a password, so anything longer is
// refused at sign-up rather than silently truncated (see lib/password.ts).
// Cost 12: OWASP's floor is 10; 12 is ~4x slower for an attacker.
const BCRYPT_COST = 12;

export async function hashPassword(pw: string): Promise<string> {
  return bcrypt.hash(pw, BCRYPT_COST);
}
export async function verifyPassword(pw: string, hash: string): Promise<boolean> {
  return bcrypt.compare(pw, hash);
}

/**
 * Sign the user in. The token carries the user's sessionVersion; bumping that
 * number on the user row ends every session they have, on every device.
 */
export async function createSession(userId: number): Promise<void> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { role: true, sessionVersion: true } });
  if (!user) return;
  const ttl = user.role === "admin" ? ADMIN_SESSION_SECONDS : USER_SESSION_SECONDS;
  const token = await new SignJWT({ uid: userId, sv: user.sessionVersion })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${ttl}s`)
    .sign(secret());
  (await cookies()).set(COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: ttl,
  });
}

/** Clear this browser's cookie. */
export async function destroySession(): Promise<void> {
  (await cookies()).set(COOKIE, "", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });
}

/** End every session this user has, everywhere. Used on sign-out and password reset. */
export async function revokeAllSessions(userId: number): Promise<void> {
  await prisma.user.updateMany({ where: { id: userId }, data: { sessionVersion: { increment: 1 } } });
}

export async function getCurrentUser(): Promise<User | null> {
  const token = (await cookies()).get(COOKIE)?.value;
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, secret(), { algorithms: ["HS256"] });
    const uid = Number(payload.uid);
    if (!uid) return null;
    const user = await prisma.user.findUnique({ where: { id: uid } });
    if (!user) return null;
    // Tokens from before revocable sessions carry no version, and are refused:
    // everyone signs in once after this deploy.
    if (typeof payload.sv !== "number" || payload.sv !== user.sessionVersion) return null;
    // A buyer awaiting approval, or rejected, has no session anywhere, even
    // one issued before an admin changed their status.
    if (user.approvalStatus && user.approvalStatus !== "approved") return null;
    return user;
  } catch (e: any) {
    if (String(e?.message || "").includes("AUTH_SECRET")) throw e;
    return null;
  }
}

export async function requireUser(): Promise<User> {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  return user;
}

export async function requireRole(...roles: Role[]): Promise<User> {
  const user = await requireUser();
  if (!roles.includes(user.role as Role)) redirect("/dashboard");
  return user;
}

export function isRole(user: User | null, ...roles: Role[]): boolean {
  return !!user && roles.includes(user.role as Role);
}
