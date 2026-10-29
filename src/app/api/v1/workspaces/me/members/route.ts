import { authedRoute } from "@/server/http/handler";
import { getTeam } from "@/server/services/members.service";

/** Everyone can see who's on the team; invitations are included for owners and admins only. */
export const GET = authedRoute(async ({ auth }) => Response.json(await getTeam(auth)));
