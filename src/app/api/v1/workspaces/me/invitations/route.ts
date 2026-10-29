import { ADMIN_ROLES } from "@/lib/permissions";
import { inviteMemberSchema } from "@/lib/validation/members";
import { authedRoute, parseJsonBody } from "@/server/http/handler";
import { inviteMember } from "@/server/services/members.service";

/** Creates (or replaces) an invitation and returns its one-time token for the link. */
export const POST = authedRoute(
  async ({ request, auth }) => {
    const input = await parseJsonBody(request, inviteMemberSchema);
    return Response.json(await inviteMember(auth, input), { status: 201 });
  },
  { roles: ADMIN_ROLES },
);
