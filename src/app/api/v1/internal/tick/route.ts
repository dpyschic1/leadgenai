import { publicRoute } from "@/server/http/handler";
import { assertCron } from "@/server/http/cron";
import { runTick } from "@/server/ingestion/worker";

/**
 * The scheduler's entry point: queues daily checks and processes queued jobs for every workspace.
 * Called every few minutes by an external cron (cron-job.org) with POST, and daily by Vercel Cron
 * with GET; both send `Authorization: Bearer <CRON_SECRET>`.
 */

export const maxDuration = 60;

const tick = publicRoute(async ({ request }) => {
  assertCron(request, "tick");
  // Stop claiming new jobs early: a job already started must still finish inside the 60s limit.
  return Response.json(await runTick({ budgetMs: 38_000 }));
});

export const GET = tick;
export const POST = tick;
