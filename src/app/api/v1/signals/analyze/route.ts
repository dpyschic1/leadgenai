import { EDITOR_ROLES } from "@/lib/permissions";
import { analyzeSignalSchema } from "@/lib/validation/signals";
import { authedRoute, parseJsonBody } from "@/server/http/handler";
import { suggestSignal } from "@/server/services/signals.service";

/** AI suggestion for a pasted source. Stateless: the client saves the reviewed result separately. */
export const POST = authedRoute(
  async ({ request, auth }) => {
    const input = await parseJsonBody(request, analyzeSignalSchema);
    return Response.json(await suggestSignal(auth, input));
  },
  { roles: EDITOR_ROLES },
);
