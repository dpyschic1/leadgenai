import "server-only";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { auditLogs, users, workspaces } from "@/db/schema";
import type { Me } from "@/lib/api/types";
import type { UpdateWorkspaceInput } from "@/lib/validation/auth";
import type { AuthContext } from "@/server/auth/session";
import { AppError } from "@/server/http/errors";
import { toMe } from "./dto";

export async function getMe(auth: AuthContext): Promise<Me> {
  const [row] = await db
    .select({ user: users, workspace: workspaces })
    .from(users)
    .innerJoin(workspaces, eq(workspaces.id, users.workspaceId))
    .where(and(eq(users.id, auth.userId), eq(users.workspaceId, auth.workspaceId)))
    .limit(1);

  if (!row) throw new AppError("NOT_FOUND", "Account not found.");
  return toMe(row.user, row.workspace);
}

/** Renames the caller's own workspace; the target is always taken from the session. */
export async function updateWorkspace(auth: AuthContext, input: UpdateWorkspaceInput): Promise<Me> {
  await db.transaction(async (tx) => {
    await tx
      .update(workspaces)
      .set({ name: input.name })
      .where(eq(workspaces.id, auth.workspaceId));
    await tx.insert(auditLogs).values({
      workspaceId: auth.workspaceId,
      actorId: auth.userId,
      action: "workspace.updated",
      entityType: "workspace",
      entityId: auth.workspaceId,
      metadata: { name: input.name },
    });
  });
  return getMe(auth);
}
