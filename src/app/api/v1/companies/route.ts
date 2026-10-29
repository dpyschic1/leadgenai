import { EDITOR_ROLES } from "@/lib/permissions";
import { companyListQuerySchema, companySchema } from "@/lib/validation/companies";
import { authedRoute, parseJsonBody, parseQuery } from "@/server/http/handler";
import { createCompany, listCompanies } from "@/server/services/companies.service";

export const GET = authedRoute(async ({ request, auth }) => {
  const { q } = parseQuery(request, companyListQuerySchema);
  return Response.json(await listCompanies(auth, q));
});

export const POST = authedRoute(
  async ({ request, auth }) => {
    const input = await parseJsonBody(request, companySchema);
    return Response.json(await createCompany(auth, input), { status: 201 });
  },
  { roles: EDITOR_ROLES },
);
