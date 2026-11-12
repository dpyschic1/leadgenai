import { EDITOR_ROLES } from "@/lib/permissions";
import { bulkOpportunitiesSchema } from "@/lib/validation/opportunities";
import { authedRoute, parseJsonBody } from "@/server/http/handler";
import { bulkUpdateOpportunities } from "@/server/services/opportunities.service";

/** One action on the selected opportunities: move to a stage, archive/restore, or add to a list. */
export const POST = authedRoute(
  async ({ request, auth }) => {
    const input = await parseJsonBody(request, bulkOpportunitiesSchema);
    return Response.json(await bulkUpdateOpportunities(auth, input));
  },
  { roles: EDITOR_ROLES },
);
