import { publicRoute } from "@/server/http/handler";
import { assertCron } from "@/server/http/cron";
import { runCollection } from "@/server/collection/runner";

/**
 * The Web Scraping & Discovery Engine's entry point, separate from the ingestion tick so each has
 * its own time limit and failures stay apart. Called every few minutes by the scheduler
 * (cron-job.org) with `Authorization: Bearer <CRON_SECRET>`, and every minute by the local ticker.
 */

export const maxDuration = 60;

const collect = publicRoute(async ({ request }) => {
  assertCron(request, "collect");
  // Stop starting targets early: a run already started must still finish inside the 60 s limit.
  return Response.json(await runCollection({ budgetMs: 40_000 }));
});

export const GET = collect;
export const POST = collect;
