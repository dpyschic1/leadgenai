import "server-only";
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";
import type { UserRole } from "@/lib/api/types";
import { authenticate, clearSessionCookie, type AuthContext } from "@/server/auth/session";
import { AppError, errorResponse } from "./errors";

/**
 * Wrappers for `/api/v1` Route Handlers. They give every response a request id, convert thrown
 * errors into the error contract, block cross-origin mutations and (for `authedRoute`) resolve
 * the session and enforce roles, so individual handlers only contain their own logic.
 */

type BaseArgs<Ctx> = { request: NextRequest; context: Ctx; requestId: string };
type AuthedArgs<Ctx> = BaseArgs<Ctx> & { auth: AuthContext };

type RouteOptions = {
  /** Roles allowed to call this route; omit to allow any signed-in user. */
  roles?: readonly UserRole[];
};

export function publicRoute<Ctx = unknown>(handler: (args: BaseArgs<Ctx>) => Promise<Response>) {
  return (request: NextRequest, context: Ctx) =>
    run(request, (requestId) => handler({ request, context, requestId }));
}

export function authedRoute<Ctx = unknown>(
  handler: (args: AuthedArgs<Ctx>) => Promise<Response>,
  options: RouteOptions = {},
) {
  return (request: NextRequest, context: Ctx) =>
    run(request, async (requestId) => {
      const auth = await authenticate();
      if (!auth) {
        // Drop a stale cookie so the proxy stops treating the browser as signed in.
        await clearSessionCookie();
        throw new AppError("UNAUTHENTICATED", "Sign in to continue.");
      }
      if (options.roles && !options.roles.includes(auth.role)) {
        throw new AppError("FORBIDDEN", "You don't have permission to do this.");
      }
      return handler({ request, context, requestId, auth });
    });
}

/** Parses and validates a JSON body; throws VALIDATION_FAILED with per-field messages. */
export async function parseJsonBody<S extends z.ZodType>(
  request: NextRequest,
  schema: S,
): Promise<z.output<S>> {
  if (!request.headers.get("content-type")?.includes("application/json")) {
    throw new AppError("UNSUPPORTED_MEDIA_TYPE", "Expected a JSON request body.");
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw new AppError("VALIDATION_FAILED", "Request body is not valid JSON.");
  }

  const result = schema.safeParse(body);
  if (!result.success) {
    throw new AppError(
      "VALIDATION_FAILED",
      "Some fields are invalid.",
      z.flattenError(result.error).fieldErrors,
    );
  }
  return result.data;
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

async function run(
  request: NextRequest,
  handle: (requestId: string) => Promise<Response>,
): Promise<Response> {
  const requestId = `req_${randomUUID()}`;
  let response: Response;
  try {
    assertSameOrigin(request);
    response = await handle(requestId);
  } catch (error) {
    response = errorResponse(error, requestId);
  }
  response.headers.set("x-request-id", requestId);
  return response;
}

/** CSRF defence in depth on top of SameSite=Lax cookies and JSON-only bodies. */
function assertSameOrigin(request: NextRequest): void {
  if (SAFE_METHODS.has(request.method)) return;
  const origin = request.headers.get("origin");
  if (origin && new URL(origin).host !== request.headers.get("host")) {
    throw new AppError("FORBIDDEN", "Cross-origin requests are not allowed.");
  }
}
