import { z } from "zod";
import { CONFIG_ROLES } from "@/lib/permissions";
import { authedRoute, parseJsonBody } from "@/server/http/handler";
import { reorderStages } from "@/server/services/pipeline.service";

const orderSchema = z.object({ stageIds: z.array(z.uuid()).min(1).max(50) });

export const PUT = authedRoute(
  async ({ request, auth }) => Response.json(await reorderStages(auth, (await parseJsonBody(request, orderSchema)).stageIds)),
  { roles: CONFIG_ROLES },
);
