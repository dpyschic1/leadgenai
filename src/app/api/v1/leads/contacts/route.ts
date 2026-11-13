import { leadContactsQuerySchema } from "@/lib/validation/opportunities";
import { authedRoute, parseQuery } from "@/server/http/handler";
import { listLeadContacts } from "@/server/services/opportunities.service";

/** Every lead the Leads page's filters match, with its email and phone: "copy all matching". */
export const GET = authedRoute(async ({ request, auth }) => Response.json(await listLeadContacts(auth, parseQuery(request, leadContactsQuerySchema))));
