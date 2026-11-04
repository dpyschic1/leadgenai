import { leadListQuerySchema } from "@/lib/validation/opportunities";
import { authedRoute, parseQuery } from "@/server/http/handler";
import { listLeads } from "@/server/services/opportunities.service";

/** The Leads page: active leads by how they can be reached, one page at a time. */
export const GET = authedRoute(async ({ request, auth }) => Response.json(await listLeads(auth, parseQuery(request, leadListQuerySchema))));
