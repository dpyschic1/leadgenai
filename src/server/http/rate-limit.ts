import "server-only";
import { createHash } from "node:crypto";
import { lt, sql } from "drizzle-orm";
import type { NextRequest } from "next/server";
import { db } from "@/db";
import { rateLimits } from "@/db/schema";
import { AppError } from "./errors";

/**
 * Rate limits (SRS §14): slow down password guessing and sign-up abuse, and keep one user or
 * workspace from using up the shared AI quota.
 */
export const RATE_LIMITS = {
  /** Per IP + email: guessing one account's password. Cleared after a successful sign-in. */
  login: { limit: 10, windowSeconds: 15 * 60 },
  /** Per IP: trying many accounts from one address. */
  loginIp: { limit: 50, windowSeconds: 15 * 60 },
  /** Per IP. */
  register: { limit: 5, windowSeconds: 60 * 60 },
  /** Per IP: accepting with an existing account checks its password, so it's limited like sign-in. */
  acceptInvitation: { limit: 10, windowSeconds: 15 * 60 },
  /** Per user: AI signal analysis. */
  aiAnalysis: { limit: 30, windowSeconds: 60 * 60 },
  /** Per user: AI search (short requests, so cheaper than analysis). */
  aiSearch: { limit: 60, windowSeconds: 60 * 60 },
  /** Per workspace, across every AI feature: the AI provider's daily quota is shared by everyone. */
  aiWorkspace: { limit: 300, windowSeconds: 24 * 60 * 60 },
  /** Per user. */
  export: { limit: 30, windowSeconds: 60 * 60 },
  /** Per user: "Run now" on the data sources (finds companies and runs ~30 s of background work). */
  sourcesRun: { limit: 30, windowSeconds: 60 * 60 },
  /** Per user: "Refresh from sources" on a company. */
  companyRefresh: { limit: 30, windowSeconds: 60 * 60 },
} as const satisfies Record<string, { limit: number; windowSeconds: number }>;

export type RateLimitRule = keyof typeof RATE_LIMITS;

/** Share of calls that also delete long-expired counters, so the table stays small without a cron job. */
const CLEANUP_RATE = 0.01;

/**
 * Counts one request by `subject` (an IP, email, user or workspace id) against `rule`, and throws
 * RATE_LIMITED once the window's limit is passed. One atomic upsert, so it's safe under concurrency.
 */
export async function rateLimit(rule: RateLimitRule, subject: string): Promise<void> {
  const { limit, windowSeconds } = RATE_LIMITS[rule];
  const expired = sql`${rateLimits.windowStart} <= now() - make_interval(secs => ${windowSeconds})`;

  const [row] = await db
    .insert(rateLimits)
    .values({ key: rateLimitKey(rule, subject), count: 1, windowStart: sql`now()` })
    .onConflictDoUpdate({
      target: rateLimits.key,
      set: {
        count: sql`case when ${expired} then 1 else ${rateLimits.count} + 1 end`,
        windowStart: sql`case when ${expired} then now() else ${rateLimits.windowStart} end`,
      },
    })
    .returning({
      count: rateLimits.count,
      retryAfter: sql<number>`ceil(extract(epoch from ${rateLimits.windowStart} + make_interval(secs => ${windowSeconds}) - now()))::int`,
    });

  if (Math.random() < CLEANUP_RATE) {
    await db.delete(rateLimits).where(lt(rateLimits.windowStart, sql`now() - interval '1 day'`));
  }

  if (row.count > limit) {
    const retryAfter = Math.max(1, row.retryAfter);
    throw new AppError("RATE_LIMITED", `Too many attempts. Try again in ${formatWait(retryAfter)}.`, undefined, {
      retryAfter,
    });
  }
}

/** Forgets `subject`'s count, e.g. failed sign-ins once the right password is given. */
export async function clearRateLimit(rule: RateLimitRule, subject: string): Promise<void> {
  await db.delete(rateLimits).where(sql`${rateLimits.key} = ${rateLimitKey(rule, subject)}`);
}

/**
 * The caller's IP. Behind the hosting proxy (e.g. Vercel) the first `x-forwarded-for` entry is
 * the client; without a proxy every request shares the "unknown" bucket, which only tightens limits.
 */
export function clientIp(request: NextRequest): string {
  return (
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip")?.trim() ||
    "unknown"
  );
}

export function rateLimitKey(rule: RateLimitRule, subject: string): string {
  return `${rule}:${createHash("sha256").update(subject.toLowerCase()).digest("hex")}`;
}

/** "45 seconds", "1 minute", "14 minutes", "3 hours". */
export function formatWait(seconds: number): string {
  const [value, unit] =
    seconds < 60 ? [seconds, "second"] : seconds < 3600 ? [Math.ceil(seconds / 60), "minute"] : [Math.ceil(seconds / 3600), "hour"];
  return `${value} ${unit}${value === 1 ? "" : "s"}`;
}
