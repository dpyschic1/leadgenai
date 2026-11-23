import { CONFIG_ROLES } from "@/lib/permissions";
import { describeServiceSchema } from "@/lib/validation/services";
import { describeService } from "@/server/ai/service-description";
import { authedRoute, parseJsonBody } from "@/server/http/handler";
import { rateLimit } from "@/server/http/rate-limit";
import { getReferenceData } from "@/server/services/reference-data.service";

/** AI draft of a service's "What does it include?", from its name. Saves nothing. */
export const POST = authedRoute(
  async ({ request, auth }) => {
    const input = await parseJsonBody(request, describeServiceSchema);
    await rateLimit("aiSearch", auth.userId);
    await rateLimit("aiWorkspace", auth.workspaceId);
    const ref = await getReferenceData();
    const names = new Map(ref.serviceCategories.map((c) => [c.slug, c.name]));
    const categories = input.categories.flatMap((slug) => names.get(slug) ?? []);
    return Response.json({ description: await describeService(input.name, categories) });
  },
  { roles: CONFIG_ROLES },
);
