import { authedRoute } from "@/server/http/handler";
import { pipelineBoard } from "@/server/services/opportunities.service";

export const GET = authedRoute(async ({ auth }) => Response.json(await pipelineBoard(auth)));
