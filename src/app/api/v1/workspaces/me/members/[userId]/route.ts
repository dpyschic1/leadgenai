import { ADMIN_ROLES } from "@/lib/permissions";
import { updateMemberSchema } from "@/lib/validation/members";
import { authedRoute, parseJsonBody } from "@/server/http/handler";
import { uuidParam } from "@/server/http/params";
import { removeMember, updateMemberRole } from "@/server/services/members.service";

type Context = RouteContext<"/api/v1/workspaces/me/members/[userId]">;

const memberId = async (context: Context) => uuidParam((await context.params).userId, "Team member");

export const PATCH = authedRoute<Context>(
  async ({ request, context, auth }) => {
    const userId = await memberId(context);
    const input = await parseJsonBody(request, updateMemberSchema);
    return Response.json(await updateMemberRole(auth, userId, input));
  },
  { roles: ADMIN_ROLES },
);

export const DELETE = authedRoute<Context>(
  async ({ context, auth }) => {
    await removeMember(auth, await memberId(context));
    return new Response(null, { status: 204 });
  },
  { roles: ADMIN_ROLES },
);
