import { CONFIG_ROLES } from "@/lib/permissions";
import { serviceSchema } from "@/lib/validation/services";
import { authedRoute, parseJsonBody } from "@/server/http/handler";
import { uuidParam } from "@/server/http/params";
import { rescoreAfterWorkspaceChange } from "@/server/scoring/rescore";
import { deleteService, updateService } from "@/server/services/services.service";

type Context = RouteContext<"/api/v1/services/[id]">;

const serviceId = async (context: Context) => uuidParam((await context.params).id, "Service");

export const PATCH = authedRoute<Context>(
  async ({ request, context, auth }) => {
    const id = await serviceId(context);
    const input = await parseJsonBody(request, serviceSchema);
    const service = await updateService(auth, id, input);
    await rescoreAfterWorkspaceChange(auth.workspaceId);
    return Response.json(service);
  },
  { roles: CONFIG_ROLES },
);

export const DELETE = authedRoute<Context>(
  async ({ context, auth }) => {
    await deleteService(auth, await serviceId(context));
    await rescoreAfterWorkspaceChange(auth.workspaceId);
    return new Response(null, { status: 204 });
  },
  { roles: CONFIG_ROLES },
);
