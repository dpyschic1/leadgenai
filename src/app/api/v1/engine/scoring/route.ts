import { z } from "zod";
import { engineWeightsSchema } from "@/lib/domain/engine";
import { CONFIG_ROLES } from "@/lib/permissions";
import { authedRoute, parseJsonBody } from "@/server/http/handler";
import { saveEngineWeights } from "@/server/services/engine.service";

/** `weights: null` resets to the spec's defaults. */
const schema = z.object({ weights: engineWeightsSchema.nullable() });

export const PUT = authedRoute(
  async ({ request, auth }) => Response.json(await saveEngineWeights(auth, (await parseJsonBody(request, schema)).weights)),
  { roles: CONFIG_ROLES },
);
