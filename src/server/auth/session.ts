import "server-only";
import { cookies } from "next/headers";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { sessions, workspaceMembers } from "@/db/schema";
import type { UserRole } from "@/lib/api/types";
import { SESSION_COOKIE } from "./constants";
import {
  generateSessionToken,
  hashSessionToken,
  sessionExpiry,
  shouldRenewSession,
} from "./session-token";

/**
 * Database-backed sessions. These functions write cookies, so they may only be called from
 * Route Handlers or Server Actions, never while rendering a Server Component.
 */

/** Who is making the request. Services scope every query by `workspaceId` from here. */
export type AuthContext = {
  userId: string;
  workspaceId: string;
  role: UserRole;
};

/**
 * Issues a fresh session for one workspace membership, revoking any session the browser
 * already had.
 */
export async function startSession(
  userId: string,
  workspaceId: string,
  userAgent: string | null,
): Promise<void> {
  const previous = (await cookies()).get(SESSION_COOKIE)?.value;
  if (previous) {
    await db.delete(sessions).where(eq(sessions.id, hashSessionToken(previous)));
  }

  const token = generateSessionToken();
  const expiresAt = sessionExpiry(new Date());
  await db
    .insert(sessions)
    .values({ id: hashSessionToken(token), userId, workspaceId, expiresAt, userAgent });
  await setSessionCookie(token, expiresAt);
}

/**
 * Resolves the session cookie to the current user and workspace. Returns null when the cookie
 * is missing, unknown or expired, or the membership is no longer active. Extends sessions
 * nearing expiry.
 */
export async function authenticate(): Promise<AuthContext | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return null;

  const sessionId = hashSessionToken(token);
  const [row] = await db
    .select({
      expiresAt: sessions.expiresAt,
      userId: workspaceMembers.userId,
      workspaceId: workspaceMembers.workspaceId,
      role: workspaceMembers.role,
      status: workspaceMembers.status,
    })
    .from(sessions)
    .innerJoin(
      workspaceMembers,
      and(
        eq(workspaceMembers.workspaceId, sessions.workspaceId),
        eq(workspaceMembers.userId, sessions.userId),
      ),
    )
    .where(eq(sessions.id, sessionId))
    .limit(1);

  if (!row || row.status !== "active") return null;

  const now = new Date();
  if (row.expiresAt <= now) {
    await db.delete(sessions).where(eq(sessions.id, sessionId));
    return null;
  }

  if (shouldRenewSession(row.expiresAt, now)) {
    const expiresAt = sessionExpiry(now);
    await db.update(sessions).set({ expiresAt }).where(eq(sessions.id, sessionId));
    await setSessionCookie(token, expiresAt);
  }

  return { userId: row.userId, workspaceId: row.workspaceId, role: row.role };
}

/** Revokes the current session (if any) and removes the cookie. */
export async function endSession(): Promise<void> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (token) {
    await db.delete(sessions).where(eq(sessions.id, hashSessionToken(token)));
  }
  await clearSessionCookie();
}

export async function clearSessionCookie(): Promise<void> {
  (await cookies()).delete(SESSION_COOKIE);
}

async function setSessionCookie(token: string, expiresAt: Date): Promise<void> {
  (await cookies()).set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    expires: expiresAt,
  });
}
