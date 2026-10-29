import { updateWorkspaceSchema } from "@/lib/validation/auth";
import { ADMIN_ROLES } from "@/lib/permissions";
import { authedRoute, parseJsonBody } from "@/server/http/handler";
import { getMe, updateWorkspace } from "@/server/services/workspace.service";

export const GET = authedRoute(async ({ auth }) => Response.json(await getMe(auth)));

export const PATCH = authedRoute(
  async ({ request, auth }) => {
    const input = await parseJsonBody(request, updateWorkspaceSchema);
    return Response.json(await updateWorkspace(auth, input));
  },
  { roles: ADMIN_ROLES },
);
