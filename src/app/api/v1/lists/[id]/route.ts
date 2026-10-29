import { EDITOR_ROLES } from "@/lib/permissions";
import { listSchema } from "@/lib/validation/lists";
import { authedRoute, parseJsonBody } from "@/server/http/handler";
import { uuidParam } from "@/server/http/params";
import { deleteList, getList, renameList } from "@/server/services/lists.service";

type Context = RouteContext<"/api/v1/lists/[id]">;

const listId = async (context: Context) => uuidParam((await context.params).id, "List");

export const GET = authedRoute<Context>(async ({ context, auth }) => Response.json(await getList(auth, await listId(context))));

export const PATCH = authedRoute<Context>(
  async ({ request, context, auth }) => {
    const id = await listId(context);
    const input = await parseJsonBody(request, listSchema);
    return Response.json(await renameList(auth, id, input));
  },
  { roles: EDITOR_ROLES },
);

export const DELETE = authedRoute<Context>(
  async ({ context, auth }) => {
    await deleteList(auth, await listId(context));
    return new Response(null, { status: 204 });
  },
  { roles: EDITOR_ROLES },
);
