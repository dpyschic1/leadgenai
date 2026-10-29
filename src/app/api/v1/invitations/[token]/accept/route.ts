import { acceptInvitationSchema } from "@/lib/validation/members";
import { startSession } from "@/server/auth/session";
import { parseJsonBody, publicRoute } from "@/server/http/handler";
import { clientIp, rateLimit } from "@/server/http/rate-limit";
import { acceptInvitation } from "@/server/services/members.service";

type Context = RouteContext<"/api/v1/invitations/[token]/accept">;

/** Public: joins the workspace and signs the new teammate in to it. */
export const POST = publicRoute<Context>(async ({ request, context }) => {
  const input = await parseJsonBody(request, acceptInvitationSchema);
  await rateLimit("acceptInvitation", clientIp(request));
  const me = await acceptInvitation((await context.params).token, input);
  await startSession(me.user.id, me.workspace.id, request.headers.get("user-agent"));
  return Response.json(me);
});
