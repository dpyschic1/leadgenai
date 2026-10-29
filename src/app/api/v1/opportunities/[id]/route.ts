import { EDITOR_ROLES } from "@/lib/permissions";
import { updateOpportunitySchema } from "@/lib/validation/opportunities";
import { authedRoute, parseJsonBody } from "@/server/http/handler";
import { uuidParam } from "@/server/http/params";
import { refreshStaleScores } from "@/server/scoring/rescore";
import { getOpportunity, updateOpportunity } from "@/server/services/opportunities.service";

type Context = RouteContext<"/api/v1/opportunities/[id]">;

const opportunityId = async (context: Context) => uuidParam((await context.params).id, "Opportunity");

export const GET = authedRoute<Context>(async ({ context, auth }) => {
  const id = await opportunityId(context);
  await refreshStaleScores(auth.workspaceId);
  return Response.json(await getOpportunity(auth, id));
});

/** Status and notes only; scores belong to the scoring engine. */
export const PATCH = authedRoute<Context>(
  async ({ request, context, auth }) => {
    const id = await opportunityId(context);
    const input = await parseJsonBody(request, updateOpportunitySchema);
    return Response.json(await updateOpportunity(auth, id, input));
  },
  { roles: EDITOR_ROLES },
);
