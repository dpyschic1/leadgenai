import { endSession } from "@/server/auth/session";
import { publicRoute } from "@/server/http/handler";

/** Public so a client with an already-expired session can still clear its cookie. */
export const POST = publicRoute(async () => {
  await endSession();
  return new Response(null, { status: 204 });
});
