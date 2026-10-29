import { EDITOR_ROLES } from "@/lib/permissions";
import { personSchema } from "@/lib/validation/companies";
import { authedRoute, parseJsonBody } from "@/server/http/handler";
import { uuidParam } from "@/server/http/params";
import { getCompany } from "@/server/services/companies.service";
import { addPerson } from "@/server/services/people.service";

type Context = RouteContext<"/api/v1/companies/[id]/people">;

/** Adds a person to the company; responds with the updated company. */
export const POST = authedRoute<Context>(
  async ({ request, context, auth }) => {
    const companyId = uuidParam((await context.params).id, "Company");
    const input = await parseJsonBody(request, personSchema);
    await addPerson(auth, companyId, input);
    return Response.json(await getCompany(auth, companyId), { status: 201 });
  },
  { roles: EDITOR_ROLES },
);
