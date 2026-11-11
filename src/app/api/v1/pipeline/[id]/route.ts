import { z } from "zod";
import { MAX_STAGE_NAME } from "@/lib/domain/pipeline";
import { CONFIG_ROLES } from "@/lib/permissions";
import { authedRoute, parseJsonBody } from "@/server/http/handler";
import { uuidParam } from "@/server/http/params";
import { deleteStage, renameStage } from "@/server/services/pipeline.service";

type Context = RouteContext<"/api/v1/pipeline/[id]">;
const renameSchema = z.object({ name: z.string().trim().min(1, "Give the stage a name").max(MAX_STAGE_NAME, `Keep it under ${MAX_STAGE_NAME} characters`) });
const deleteSchema = z.object({ moveTo: z.uuid().nullable().default(null) });

export const PATCH = authedRoute<Context>(
  async ({ request, context, auth }) => {
    const id = uuidParam((await context.params).id, "Stage");
    return Response.json(await renameStage(auth, id, (await parseJsonBody(request, renameSchema)).name));
  },
  { roles: CONFIG_ROLES },
);

/** Removes a stage; `moveTo` says where its opportunities go (required when it has any). */
export const DELETE = authedRoute<Context>(
  async ({ request, context, auth }) => {
    const id = uuidParam((await context.params).id, "Stage");
    const body = request.headers.get("content-length") === "0" ? { moveTo: null } : await parseJsonBody(request, deleteSchema).catch(() => ({ moveTo: null }));
    return Response.json(await deleteStage(auth, id, body.moveTo));
  },
  { roles: CONFIG_ROLES },
);
