import { EDITOR_ROLES } from "@/lib/permissions";
import { personSchema } from "@/lib/validation/companies";
import { authedRoute, parseJsonBody } from "@/server/http/handler";
import { uuidParam } from "@/server/http/params";
import { getCompany } from "@/server/services/companies.service";
import { removePerson, updatePerson } from "@/server/services/people.service";

type Context = RouteContext<"/api/v1/companies/[id]/people/[personId]">;

async function ids(context: Context) {
  const { id, personId } = await context.params;
  return { companyId: uuidParam(id, "Company"), personId: uuidParam(personId, "Person") };
}

/** Updates the person and their role here; responds with the updated company. */
export const PATCH = authedRoute<Context>(
  async ({ request, context, auth }) => {
    const { companyId, personId } = await ids(context);
    const input = await parseJsonBody(request, personSchema);
    await updatePerson(auth, companyId, personId, input);
    return Response.json(await getCompany(auth, companyId));
  },
  { roles: EDITOR_ROLES },
);

/** Removes the person from the company; responds with the updated company. */
export const DELETE = authedRoute<Context>(
  async ({ context, auth }) => {
    const { companyId, personId } = await ids(context);
    await removePerson(auth, companyId, personId);
    return Response.json(await getCompany(auth, companyId));
  },
  { roles: EDITOR_ROLES },
);
