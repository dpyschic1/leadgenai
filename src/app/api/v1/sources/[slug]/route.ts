import { z } from "zod";
import { SOURCE_SLUGS } from "@/lib/domain/sources";
import { ADMIN_ROLES } from "@/lib/permissions";
import { authedRoute, parseJsonBody } from "@/server/http/handler";
import { AppError } from "@/server/http/errors";
import { setDataSourceEnabled } from "@/server/services/data-sources.service";

type Context = RouteContext<"/api/v1/sources/[slug]">;

const bodySchema = z.object({ enabled: z.boolean() });

/** Switches a source on or off for this workspace (owners and admins). */
export const PATCH = authedRoute<Context>(
  async ({ request, context, auth }) => {
    const slug = z.enum(SOURCE_SLUGS).safeParse((await context.params).slug);
    if (!slug.success) throw new AppError("NOT_FOUND", "Source not found.");
    const { enabled } = await parseJsonBody(request, bodySchema);
    return Response.json(await setDataSourceEnabled(auth, slug.data, enabled));
  },
  { roles: ADMIN_ROLES },
);
