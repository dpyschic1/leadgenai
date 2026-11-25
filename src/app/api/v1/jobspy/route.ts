import { after } from "next/server";
import { CONFIG_ROLES } from "@/lib/permissions";
import { jobspyRunSchema, jobspySwitchSchema } from "@/lib/validation/jobspy";
import { authedRoute, parseJsonBody } from "@/server/http/handler";
import { jobspyStatus, runJobspy } from "@/server/jobspy";
import { matchJobspyForEnabledWorkspaces, setJobspyEnabled } from "@/server/jobspy-opportunities";

/** The JobSpy service is given 50 s; the rest is for saving. */
export const maxDuration = 60;

/** JobSpy import status: last run, when Run is allowed again, stored jobs (Settings → JobSpy import). */
export const GET = authedRoute(async ({ auth }) => Response.json(await jobspyStatus(auth.workspaceId)), { roles: CONFIG_ROLES });

/**
 * Runs one JobSpy search and stores the jobs; refused with 429 during the cooldown. Afterwards the
 * new jobs are matched in every workspace with "Send to Opportunities" on, in the time left.
 */
export const POST = authedRoute(
  async ({ request, auth }) => {
    const started = Date.now();
    const status = await runJobspy(auth, await parseJsonBody(request, jobspyRunSchema));
    after(() => matchJobspyForEnabledWorkspaces(started + (maxDuration - 5) * 1000));
    return Response.json(status);
  },
  { roles: CONFIG_ROLES },
);

/** "Send to Opportunities": on matches the stored jobs now; off removes what JobSpy added. */
export const PUT = authedRoute(
  async ({ request, auth }) => {
    const { sendToOpportunities } = await parseJsonBody(request, jobspySwitchSchema);
    const result = await setJobspyEnabled(auth, sendToOpportunities);
    return Response.json({ ...result, status: await jobspyStatus(auth.workspaceId) });
  },
  { roles: CONFIG_ROLES },
);
