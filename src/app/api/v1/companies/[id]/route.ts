import { CONFIG_ROLES } from "@/lib/permissions";
import { companySchema } from "@/lib/validation/companies";
import { authedRoute, parseJsonBody } from "@/server/http/handler";
import { uuidParam } from "@/server/http/params";
import { deleteCompany, getCompany, updateCompany } from "@/server/services/companies.service";

type Context = RouteContext<"/api/v1/companies/[id]">;

const companyId = async (context: Context) => uuidParam((await context.params).id, "Company");

export const GET = authedRoute<Context>(async ({ context, auth }) =>
  Response.json(await getCompany(auth, await companyId(context))),
);

export const PATCH = authedRoute<Context>(
  async ({ request, context, auth }) => {
    const id = await companyId(context);
    const input = await parseJsonBody(request, companySchema);
    return Response.json(await updateCompany(auth, id, input));
  },
  { roles: CONFIG_ROLES },
);

export const DELETE = authedRoute<Context>(
  async ({ context, auth }) => {
    await deleteCompany(auth, await companyId(context));
    return new Response(null, { status: 204 });
  },
  { roles: CONFIG_ROLES },
);
