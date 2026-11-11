import { engineToggleSchema } from "@/lib/validation/engine";
import { CONFIG_ROLES } from "@/lib/permissions";
import { authedRoute, parseJsonBody } from "@/server/http/handler";
import { getEngine, setEngineEnabled } from "@/server/services/engine.service";

export const GET = authedRoute(async ({ auth }) => Response.json(await getEngine(auth)));

/** The master LeadGen Engine switch. */
export const PUT = authedRoute(
  async ({ request, auth }) => {
    const { enabled } = await parseJsonBody(request, engineToggleSchema);
    return Response.json(await setEngineEnabled(auth, enabled));
  },
  { roles: CONFIG_ROLES },
);
