import { EDITOR_ROLES } from "@/lib/permissions";
import { authedRoute } from "@/server/http/handler";
import { uuidParam } from "@/server/http/params";
import { addToList, removeFromList } from "@/server/services/lists.service";

type Context = RouteContext<"/api/v1/lists/[id]/opportunities/[opportunityId]">;

async function ids(context: Context) {
  const params = await context.params;
  return [uuidParam(params.id, "List"), uuidParam(params.opportunityId, "Opportunity")] as const;
}

/** Idempotent: saving an opportunity that's already on the list succeeds without a duplicate. */
export const PUT = authedRoute<Context>(
  async ({ context, auth }) => {
    await addToList(auth, ...(await ids(context)));
    return new Response(null, { status: 204 });
  },
  { roles: EDITOR_ROLES },
);

export const DELETE = authedRoute<Context>(
  async ({ context, auth }) => {
    await removeFromList(auth, ...(await ids(context)));
    return new Response(null, { status: 204 });
  },
  { roles: EDITOR_ROLES },
);
