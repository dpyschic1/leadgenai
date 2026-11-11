import { z } from "zod";
import { MAX_STAGE_NAME, STAGE_KINDS } from "@/lib/domain/pipeline";
import { CONFIG_ROLES } from "@/lib/permissions";
import { authedRoute, parseJsonBody } from "@/server/http/handler";
import { createStage, listPipeline } from "@/server/services/pipeline.service";

const stageName = z.string().trim().min(1, "Give the stage a name").max(MAX_STAGE_NAME, `Keep it under ${MAX_STAGE_NAME} characters`);
const createSchema = z.object({ name: stageName, kind: z.enum(STAGE_KINDS).default("open") });

export const GET = authedRoute(async ({ auth }) => Response.json(await listPipeline(auth)));

export const POST = authedRoute(
  async ({ request, auth }) => Response.json(await createStage(auth, await parseJsonBody(request, createSchema)), { status: 201 }),
  { roles: CONFIG_ROLES },
);
