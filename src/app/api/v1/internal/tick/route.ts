import { timingSafeEqual } from "node:crypto";
import type { NextRequest } from "next/server";
import { publicRoute } from "@/server/http/handler";
import { AppError } from "@/server/http/errors";
import { runTick } from "@/server/ingestion/worker";

/**
 * The scheduler's entry point: queues daily checks and processes queued jobs for every workspace.
 * Called every few minutes by an external cron (cron-job.org) with POST, and daily by Vercel Cron
 * with GET; both send `Authorization: Bearer <CRON_SECRET>`.
 */

export const maxDuration = 60;

/** Spaces, line breaks and quotes a pasted secret can pick up, in the dashboard or the scheduler. */
const clean = (value: string) => value.trim().replace(/^["']|["']$/g, "").trim();

function assertCron(request: NextRequest): void {
  const secret = clean(process.env.CRON_SECRET ?? "");
  const given = clean((request.headers.get("authorization") ?? "").replace(/^\s*Bearer\s*/i, ""));
  const ok = secret.length > 0 && given.length === secret.length && timingSafeEqual(Buffer.from(given), Buffer.from(secret));
  if (!ok) {
    // Lengths only, never the values: enough to tell a missing, truncated or padded secret apart.
    console.warn(`[tick] rejected: secret ${secret ? `set (${secret.length} chars)` : "not set"}, header ${given ? `${given.length} chars` : "missing"}`);
    throw new AppError("UNAUTHENTICATED", "Not allowed.");
  }
}

const tick = publicRoute(async ({ request }) => {
  assertCron(request);
  // Stop claiming new jobs early: a job already started must still finish inside the 60s limit.
  return Response.json(await runTick({ budgetMs: 38_000 }));
});

export const GET = tick;
export const POST = tick;
