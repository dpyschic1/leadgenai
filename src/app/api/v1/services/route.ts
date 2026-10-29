import { serviceSchema } from "@/lib/validation/services";
import { CONFIG_ROLES } from "@/lib/permissions";
import { authedRoute, parseJsonBody } from "@/server/http/handler";
import { createService, listServices } from "@/server/services/services.service";

export const GET = authedRoute(async ({ auth }) => Response.json(await listServices(auth)));

export const POST = authedRoute(
  async ({ request, auth }) => {
    const input = await parseJsonBody(request, serviceSchema);
    return Response.json(await createService(auth, input), { status: 201 });
  },
  { roles: CONFIG_ROLES },
);
