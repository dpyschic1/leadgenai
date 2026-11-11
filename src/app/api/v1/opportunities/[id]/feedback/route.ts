import { EDITOR_ROLES } from "@/lib/permissions";
import { feedbackSchema } from "@/lib/validation/feedback";
import { authedRoute, parseJsonBody } from "@/server/http/handler";
import { uuidParam } from "@/server/http/params";
import { rescoreAfterCompanyChange } from "@/server/scoring/rescore";
import { giveFeedback } from "@/server/services/feedback.service";
import { getOpportunity } from "@/server/services/opportunities.service";

type Context = RouteContext<"/api/v1/opportunities/[id]/feedback">;

/** Gives the signed-in user's verdict; returns the opportunity, re-matched if the verdict corrects it. */
export const POST = authedRoute<Context>(
  async ({ request, context, auth }) => {
    const id = uuidParam((await context.params).id, "Opportunity");
    const input = await parseJsonBody(request, feedbackSchema);
    const change = await giveFeedback(auth, id, input);
    if (change.correctsMatch && change.companyId) await rescoreAfterCompanyChange(auth.workspaceId, change.companyId);
    return Response.json(await getOpportunity(auth, id));
  },
  { roles: EDITOR_ROLES },
);
