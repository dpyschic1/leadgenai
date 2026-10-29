import { z } from "zod";
import { authedRoute, parseQuery } from "@/server/http/handler";
import { listRecentSignals } from "@/server/services/signals.service";

const querySchema = z.object({ limit: z.coerce.number().int().min(1).max(50).default(10) });

/** The workspace's most recently recorded signals. */
export const GET = authedRoute(async ({ request, auth }) => {
  const { limit } = parseQuery(request, querySchema);
  return Response.json(await listRecentSignals(auth, limit));
});
