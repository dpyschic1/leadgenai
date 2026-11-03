import { EDITOR_ROLES } from "@/lib/permissions";
import { authedRoute } from "@/server/http/handler";
import { rateLimit } from "@/server/http/rate-limit";
import { listDataSources, runSourcesNow } from "@/server/services/data-sources.service";

/** Finding companies and reading their sites takes a while; the worker stops well before this. */
export const maxDuration = 60;

/** The data sources, their health and this workspace's switches (Settings → Data sources). */
export const GET = authedRoute(async ({ auth }) => Response.json(await listDataSources(auth)));

/**
 * "Run now": finds new companies for the workspace's Services & ICP and checks tenders, without
 * waiting for the daily run. Processes ~30 s of work; the rest continues in the background.
 */
export const POST = authedRoute(
  async ({ auth }) => {
    await rateLimit("sourcesRun", auth.userId);
    return Response.json(await runSourcesNow(auth));
  },
  { roles: EDITOR_ROLES },
);
