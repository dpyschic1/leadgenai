import { EDITOR_ROLES } from "@/lib/permissions";
import { updateOpportunitySchema } from "@/lib/validation/opportunities";
import { authedRoute, parseJsonBody } from "@/server/http/handler";
import { uuidParam } from "@/server/http/params";
import { after } from "next/server";
import { contactsWanted } from "@/server/ingestion/queue";
import { refreshStaleScores } from "@/server/scoring/rescore";
import { getOpportunity, updateOpportunity } from "@/server/services/opportunities.service";

type Context = RouteContext<"/api/v1/opportunities/[id]">;

const opportunityId = async (context: Context) => uuidParam((await context.params).id, "Opportunity");

export const GET = authedRoute<Context>(async ({ context, auth }) => {
  const id = await opportunityId(context);
  await refreshStaleScores(auth.workspaceId);
  const opportunity = await getOpportunity(auth, id);
  // Opened without any contact yet: look its company up first (the next tick, within a minute).
  if (!opportunity.contactDetails && opportunity.companyContacts.length === 0) {
    after(() => contactsWanted(auth.workspaceId, opportunity.company.id).catch((error) => console.error("[contacts] on-demand lookup", error)));
  }
  return Response.json(opportunity);
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
