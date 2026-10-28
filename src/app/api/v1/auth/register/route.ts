import { registerSchema } from "@/lib/validation/auth";
import { startSession } from "@/server/auth/session";
import { parseJsonBody, publicRoute } from "@/server/http/handler";
import { registerOwner } from "@/server/services/auth.service";

export const POST = publicRoute(async ({ request }) => {
  const input = await parseJsonBody(request, registerSchema);
  const me = await registerOwner(input);
  await startSession(me.user.id, me.workspace.id, request.headers.get("user-agent"));
  return Response.json(me, { status: 201 });
});
