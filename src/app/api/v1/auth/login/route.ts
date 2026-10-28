import { loginSchema } from "@/lib/validation/auth";
import { startSession } from "@/server/auth/session";
import { parseJsonBody, publicRoute } from "@/server/http/handler";
import { verifyCredentials } from "@/server/services/auth.service";

export const POST = publicRoute(async ({ request }) => {
  const input = await parseJsonBody(request, loginSchema);
  const me = await verifyCredentials(input);
  await startSession(me.user.id, request.headers.get("user-agent"));
  return Response.json(me);
});
