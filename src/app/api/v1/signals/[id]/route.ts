import { EDITOR_ROLES } from "@/lib/permissions";
import { signalSchema } from "@/lib/validation/signals";
import { authedRoute, parseJsonBody } from "@/server/http/handler";
import { uuidParam } from "@/server/http/params";
import { deleteSignal, updateSignal } from "@/server/services/signals.service";

type Context = RouteContext<"/api/v1/signals/[id]">;

const signalId = async (context: Context) => uuidParam((await context.params).id, "Signal");

export const PATCH = authedRoute<Context>(
  async ({ request, context, auth }) => {
    const id = await signalId(context);
    const input = await parseJsonBody(request, signalSchema);
    return Response.json(await updateSignal(auth, id, input));
  },
  { roles: EDITOR_ROLES },
);

export const DELETE = authedRoute<Context>(
  async ({ context, auth }) => {
    await deleteSignal(auth, await signalId(context));
    return new Response(null, { status: 204 });
  },
  { roles: EDITOR_ROLES },
);
