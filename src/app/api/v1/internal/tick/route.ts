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

function assertCron(request: NextRequest): void {
  const secret = process.env.CRON_SECRET;
  const given = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  const ok = Boolean(secret) && given.length === secret!.length && timingSafeEqual(Buffer.from(given), Buffer.from(secret!));
  if (!ok) throw new AppError("UNAUTHENTICATED", "Not allowed.");
}

const tick = publicRoute(async ({ request }) => {
  assertCron(request);
  // Stop claiming new jobs early: a job already started must still finish inside the 60s limit.
  return Response.json(await runTick({ budgetMs: 30_000 }));
});

export const GET = tick;
export const POST = tick;
