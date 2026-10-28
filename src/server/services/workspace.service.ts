import "server-only";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { auditLogs, users, workspaceMembers, workspaces } from "@/db/schema";
import type { Me } from "@/lib/api/types";
import type { UpdateWorkspaceInput } from "@/lib/validation/auth";
import type { AuthContext } from "@/server/auth/session";
import { AppError } from "@/server/http/errors";
import { toMe } from "./dto";

export async function getMe(auth: AuthContext): Promise<Me> {
  const [row] = await db
    .select({ user: users, member: workspaceMembers, workspace: workspaces })
    .from(workspaceMembers)
    .innerJoin(users, eq(users.id, workspaceMembers.userId))
    .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
    .where(
      and(
        eq(workspaceMembers.userId, auth.userId),
        eq(workspaceMembers.workspaceId, auth.workspaceId),
      ),
    )
    .limit(1);

  if (!row) throw new AppError("NOT_FOUND", "Account not found.");
  return toMe(row.user, row.member, row.workspace);
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
