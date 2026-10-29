import { serviceSchema } from "@/lib/validation/services";
import { CONFIG_ROLES } from "@/lib/permissions";
import { authedRoute, parseJsonBody } from "@/server/http/handler";
import { rescoreAfterWorkspaceChange } from "@/server/scoring/rescore";
import { createService, listServices } from "@/server/services/services.service";

export const GET = authedRoute(async ({ auth }) => Response.json(await listServices(auth)));

export const POST = authedRoute(
  async ({ request, auth }) => {
    const input = await parseJsonBody(request, serviceSchema);
    const service = await createService(auth, input);
    await rescoreAfterWorkspaceChange(auth.workspaceId);
    return Response.json(service, { status: 201 });
  },
  { roles: CONFIG_ROLES },
);
