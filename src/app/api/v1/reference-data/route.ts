import { authedRoute } from "@/server/http/handler";
import { getReferenceData } from "@/server/services/reference-data.service";

export const GET = authedRoute(async () => Response.json(await getReferenceData()));
