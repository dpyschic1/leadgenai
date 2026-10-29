import { ADMIN_ROLES } from "@/lib/permissions";
import { authedRoute } from "@/server/http/handler";
import { uuidParam } from "@/server/http/params";
import { revokeInvitation } from "@/server/services/members.service";

type Context = RouteContext<"/api/v1/workspaces/me/invitations/[id]">;

export const DELETE = authedRoute<Context>(
  async ({ context, auth }) => {
    await revokeInvitation(auth, uuidParam((await context.params).id, "Invitation"));
    return new Response(null, { status: 204 });
  },
  { roles: ADMIN_ROLES },
);
