import { describe, expect, it } from "vitest";
import {
  SESSION_RENEW_THRESHOLD_MS,
  SESSION_TTL_MS,
  generateSessionToken,
  hashSessionToken,
  sessionExpiry,
  shouldRenewSession,
} from "./session-token";

describe("session tokens", () => {
  it("generates unique, URL-safe 256-bit tokens", () => {
    const a = generateSessionToken();
    const b = generateSessionToken();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("hashes deterministically and never returns the raw token", () => {
    const token = generateSessionToken();
    expect(hashSessionToken(token)).toBe(hashSessionToken(token));
    expect(hashSessionToken(token)).not.toContain(token);
    expect(hashSessionToken(token)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("session expiry", () => {
  const now = new Date("2026-11-01T00:00:00Z");

  it("expires a full TTL after now", () => {
    expect(sessionExpiry(now).getTime() - now.getTime()).toBe(SESSION_TTL_MS);
  });

  it("renews only once less than the threshold remains", () => {
    const fresh = new Date(now.getTime() + SESSION_RENEW_THRESHOLD_MS + 1000);
    const ageing = new Date(now.getTime() + SESSION_RENEW_THRESHOLD_MS - 1000);
    expect(shouldRenewSession(fresh, now)).toBe(false);
    expect(shouldRenewSession(ageing, now)).toBe(true);
  });
});
