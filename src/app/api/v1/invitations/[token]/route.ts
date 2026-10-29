import { publicRoute } from "@/server/http/handler";
import { getInvitationPreview } from "@/server/services/members.service";

type Context = RouteContext<"/api/v1/invitations/[token]">;

/** Public: the token itself is the credential (256 random bits), so this needs no session. */
export const GET = publicRoute<Context>(async ({ context }) =>
  Response.json(await getInvitationPreview((await context.params).token)),
);
