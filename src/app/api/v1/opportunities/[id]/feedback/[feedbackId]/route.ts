import { EDITOR_ROLES } from "@/lib/permissions";
import { authedRoute } from "@/server/http/handler";
import { uuidParam } from "@/server/http/params";
import { rescoreAfterCompanyChange } from "@/server/scoring/rescore";
import { removeFeedback } from "@/server/services/feedback.service";
import { getOpportunity } from "@/server/services/opportunities.service";

type Context = RouteContext<"/api/v1/opportunities/[id]/feedback/[feedbackId]">;

/** Removes one of the signed-in user's own verdicts; returns the opportunity, re-matched if needed. */
export const DELETE = authedRoute<Context>(
  async ({ context, auth }) => {
    const params = await context.params;
    const id = uuidParam(params.id, "Opportunity");
    const change = await removeFeedback(auth, id, uuidParam(params.feedbackId, "Feedback"));
    if (change.correctsMatch && change.companyId) await rescoreAfterCompanyChange(auth.workspaceId, change.companyId);
    return Response.json(await getOpportunity(auth, id));
  },
  { roles: EDITOR_ROLES },
);
