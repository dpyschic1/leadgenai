import { EDITOR_ROLES } from "@/lib/permissions";
import { authedRoute } from "@/server/http/handler";
import { uuidParam } from "@/server/http/params";
import { rateLimit } from "@/server/http/rate-limit";
import { runTick } from "@/server/ingestion/worker";
import { getCompanySources, refreshCompany } from "@/server/services/data-sources.service";

export const maxDuration = 60;

type Context = RouteContext<"/api/v1/companies/[id]/sources">;

const companyId = async (context: Context) => uuidParam((await context.params).id, "Company");

/** Where the company's information came from, and what is still being checked. */
export const GET = authedRoute<Context>(async ({ context, auth }) => Response.json(await getCompanySources(auth, await companyId(context))));

/** "Refresh from sources": re-checks the register, website and job board now (~30 s), then reports. */
export const POST = authedRoute<Context>(
  async ({ context, auth }) => {
    const id = await companyId(context);
    await rateLimit("companyRefresh", auth.userId);
    await refreshCompany(auth, id);
    await runTick({ workspaceId: auth.workspaceId, budgetMs: 20_000 });
    return Response.json(await getCompanySources(auth, id));
  },
  { roles: EDITOR_ROLES },
);
