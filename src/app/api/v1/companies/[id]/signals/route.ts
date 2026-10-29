import { EDITOR_ROLES } from "@/lib/permissions";
import { signalSchema } from "@/lib/validation/signals";
import { authedRoute, parseJsonBody } from "@/server/http/handler";
import { uuidParam } from "@/server/http/params";
import { createSignal, listCompanySignals } from "@/server/services/signals.service";

type Context = RouteContext<"/api/v1/companies/[id]/signals">;

const companyId = async (context: Context) => uuidParam((await context.params).id, "Company");

export const GET = authedRoute<Context>(async ({ context, auth }) =>
  Response.json(await listCompanySignals(auth, await companyId(context))),
);

export const POST = authedRoute<Context>(
  async ({ request, context, auth }) => {
    const id = await companyId(context);
    const input = await parseJsonBody(request, signalSchema);
    return Response.json(await createSignal(auth, id, input), { status: 201 });
  },
  { roles: EDITOR_ROLES },
);
