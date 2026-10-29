import { EDITOR_ROLES } from "@/lib/permissions";
import { listSchema } from "@/lib/validation/lists";
import { authedRoute, parseJsonBody } from "@/server/http/handler";
import { createList, listLists } from "@/server/services/lists.service";

export const GET = authedRoute(async ({ auth }) => Response.json(await listLists(auth)));

export const POST = authedRoute(
  async ({ request, auth }) => {
    const input = await parseJsonBody(request, listSchema);
    return Response.json(await createList(auth, input), { status: 201 });
  },
  { roles: EDITOR_ROLES },
);
