import { createHash, randomBytes } from "node:crypto";

/** Pure session-token helpers, kept free of DB/cookie access so they are unit-testable. */

export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** Extend a session once less than this much of its lifetime remains. */
export const SESSION_RENEW_THRESHOLD_MS = 15 * 24 * 60 * 60 * 1000;

export function generateSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

/** The DB stores only this hash, so a leaked sessions table can't be used to log in. */
export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function sessionExpiry(now: Date): Date {
  return new Date(now.getTime() + SESSION_TTL_MS);
}

export function shouldRenewSession(expiresAt: Date, now: Date): boolean {
  return expiresAt.getTime() - now.getTime() < SESSION_RENEW_THRESHOLD_MS;
}
