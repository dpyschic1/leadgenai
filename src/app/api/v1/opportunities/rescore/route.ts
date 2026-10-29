import { CONFIG_ROLES } from "@/lib/permissions";
import { authedRoute } from "@/server/http/handler";
import { rescoreWorkspace } from "@/server/scoring/rescore";

/** Re-scores every opportunity in the workspace now. Normally automatic; useful after imports. */
export const POST = authedRoute(
  async ({ auth }) => {
    await rescoreWorkspace(auth.workspaceId);
    return new Response(null, { status: 204 });
  },
  { roles: CONFIG_ROLES },
);
