import { CAPABILITIES, type Capability } from "@/lib/domain/engine";
import { CONFIG_ROLES } from "@/lib/permissions";
import { runCapability } from "@/server/engine/runner";
import { AppError } from "@/server/http/errors";
import { authedRoute } from "@/server/http/handler";
import { getEngine } from "@/server/services/engine.service";

/** A run reads several public sources one after another. */
export const maxDuration = 60;

type Context = RouteContext<"/api/v1/engine/capabilities/[capability]/run">;

/** "Run now": runs one capability immediately and returns what it found plus the refreshed settings. */
export const POST = authedRoute<Context>(
  async ({ context, auth }) => {
    const { capability } = await context.params;
    if (!(CAPABILITIES as readonly string[]).includes(capability)) throw new AppError("NOT_FOUND", "Capability not found.");
    const summary = await runCapability(auth.workspaceId, capability as Capability, "manual");
    return Response.json({ summary, engine: await getEngine(auth) });
  },
  { roles: CONFIG_ROLES },
);
