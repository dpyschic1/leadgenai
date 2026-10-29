import { EDITOR_ROLES } from "@/lib/permissions";
import { opportunityExportQuerySchema } from "@/lib/validation/opportunities";
import { authedRoute, parseQuery } from "@/server/http/handler";
import { rateLimit } from "@/server/http/rate-limit";
import { exportOpportunities } from "@/server/services/exports.service";

/** CSV download of the filtered feed or of one saved list. Viewers are read-only, so can't export. */
export const GET = authedRoute(
  async ({ request, auth }) => {
    const query = parseQuery(request, opportunityExportQuerySchema);
    await rateLimit("export", auth.userId);
    const { filename, csv, count } = await exportOpportunities(auth, query);
    return new Response(csv, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Cache-Control": "no-store",
        "X-Export-Count": String(count),
      },
    });
  },
  { roles: EDITOR_ROLES },
);
