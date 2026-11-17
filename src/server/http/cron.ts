import "server-only";
import { timingSafeEqual } from "node:crypto";
import type { NextRequest } from "next/server";
import { AppError } from "./errors";

/**
 * The scheduler's endpoints (`/api/v1/internal/*`) accept only `Authorization: Bearer <CRON_SECRET>`.
 */

/** Spaces, line breaks and quotes a pasted secret can pick up, in the dashboard or the scheduler. */
const clean = (value: string) => value.trim().replace(/^["']|["']$/g, "").trim();

export function assertCron(request: NextRequest, name: string): void {
  const secret = clean(process.env.CRON_SECRET ?? "");
  const given = clean((request.headers.get("authorization") ?? "").replace(/^\s*Bearer\s*/i, ""));
  const ok = secret.length > 0 && given.length === secret.length && timingSafeEqual(Buffer.from(given), Buffer.from(secret));
  if (!ok) {
    // Lengths only, never the values: enough to tell a missing, truncated or padded secret apart.
    console.warn(`[${name}] rejected: secret ${secret ? `set (${secret.length} chars)` : "not set"}, header ${given ? `${given.length} chars` : "missing"}`);
    throw new AppError("UNAUTHENTICATED", "Not allowed.");
  }
}
