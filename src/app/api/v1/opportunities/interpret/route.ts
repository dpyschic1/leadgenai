import { interpretSearchSchema } from "@/lib/validation/opportunities";
import { authedRoute, parseJsonBody } from "@/server/http/handler";
import { rateLimit } from "@/server/http/rate-limit";
import { interpretSearch } from "@/server/services/search.service";

/** AI search: returns filters for the feed. Read-only, so every role may use it. */
export const POST = authedRoute(async ({ request, auth }) => {
  const input = await parseJsonBody(request, interpretSearchSchema);
  await rateLimit("aiSearch", auth.userId);
  await rateLimit("aiWorkspace", auth.workspaceId);
  return Response.json(await interpretSearch(auth, input));
});
