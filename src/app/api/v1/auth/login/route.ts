import { loginSchema } from "@/lib/validation/auth";
import { startSession } from "@/server/auth/session";
import { parseJsonBody, publicRoute } from "@/server/http/handler";
import { clearRateLimit, clientIp, rateLimit } from "@/server/http/rate-limit";
import { verifyCredentials } from "@/server/services/auth.service";

export const POST = publicRoute(async ({ request }) => {
  const input = await parseJsonBody(request, loginSchema);
  const ip = clientIp(request);
  const account = `${ip}|${input.email}`;
  // Counted before the password is checked, so guesses are limited whether they succeed or not.
  await rateLimit("loginIp", ip);
  await rateLimit("login", account);

  const me = await verifyCredentials(input);
  await clearRateLimit("login", account);
  await startSession(me.user.id, me.workspace.id, request.headers.get("user-agent"));
  return Response.json(me);
});
