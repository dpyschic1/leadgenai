import { authedRoute } from "@/server/http/handler";
import { dashboardReport } from "@/server/services/pipeline.service";

export const GET = authedRoute(async ({ auth }) => Response.json(await dashboardReport(auth)));
