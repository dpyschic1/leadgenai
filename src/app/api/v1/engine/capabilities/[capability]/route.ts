import { CAPABILITIES, type Capability } from "@/lib/domain/engine";
import { CONFIG_ROLES } from "@/lib/permissions";
import { capabilityUpdateSchema } from "@/lib/validation/engine";
import { authedRoute, parseJsonBody } from "@/server/http/handler";
import { AppError } from "@/server/http/errors";
import { updateCapability } from "@/server/services/engine.service";

type Context = RouteContext<"/api/v1/engine/capabilities/[capability]">;

export const PATCH = authedRoute<Context>(
  async ({ request, context, auth }) => {
    const { capability } = await context.params;
    if (!(CAPABILITIES as readonly string[]).includes(capability)) throw new AppError("NOT_FOUND", "Capability not found.");
    const input = await parseJsonBody(request, capabilityUpdateSchema);
    return Response.json(await updateCapability(auth, capability as Capability, input));
  },
  { roles: CONFIG_ROLES },
);
