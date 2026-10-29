import { scoringProfileSchema } from "@/lib/validation/scoring";
import { CONFIG_ROLES } from "@/lib/permissions";
import { authedRoute, parseJsonBody } from "@/server/http/handler";
import { getScoringProfile, saveScoringProfile } from "@/server/services/scoring.service";

export const GET = authedRoute(async ({ auth }) => Response.json(await getScoringProfile(auth)));

export const PUT = authedRoute(
  async ({ request, auth }) => {
    const input = await parseJsonBody(request, scoringProfileSchema);
    return Response.json(await saveScoringProfile(auth, input));
  },
  { roles: CONFIG_ROLES },
);
