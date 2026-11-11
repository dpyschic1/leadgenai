import { authedRoute } from "@/server/http/handler";
import { pipelineReport } from "@/server/services/pipeline.service";

export const GET = authedRoute(async ({ auth }) => Response.json(await pipelineReport(auth)));
