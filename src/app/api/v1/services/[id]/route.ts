import { z } from "zod";
import { serviceSchema } from "@/lib/validation/services";
import { CONFIG_ROLES } from "@/lib/permissions";
import { AppError } from "@/server/http/errors";
import { authedRoute, parseJsonBody } from "@/server/http/handler";
import { deleteService, updateService } from "@/server/services/services.service";

type Context = RouteContext<"/api/v1/services/[id]">;

async function serviceId(context: Context): Promise<string> {
  const { id } = await context.params;
  if (!z.uuid().safeParse(id).success) throw new AppError("NOT_FOUND", "Service not found.");
  return id;
}

export const PATCH = authedRoute<Context>(
  async ({ request, context, auth }) => {
    const id = await serviceId(context);
    const input = await parseJsonBody(request, serviceSchema);
    return Response.json(await updateService(auth, id, input));
  },
  { roles: CONFIG_ROLES },
);

export const DELETE = authedRoute<Context>(
  async ({ context, auth }) => {
    await deleteService(auth, await serviceId(context));
    return new Response(null, { status: 204 });
  },
  { roles: CONFIG_ROLES },
);
