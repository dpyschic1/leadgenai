import { opportunityListQuerySchema } from "@/lib/validation/opportunities";
import { authedRoute, parseQuery } from "@/server/http/handler";
import { listOpportunities } from "@/server/services/opportunities.service";

export const GET = authedRoute(async ({ request, auth }) =>
  Response.json(await listOpportunities(auth, parseQuery(request, opportunityListQuerySchema))),
);
