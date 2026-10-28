import "server-only";
import { and, asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { isUniqueViolation } from "@/db/errors";
import { auditLogs, users, workspaceMembers, workspaces } from "@/db/schema";
import type { Me } from "@/lib/api/types";
import type { LoginInput, RegisterInput } from "@/lib/validation/auth";
import { hashPassword, verifyDummyPassword, verifyPassword } from "@/server/auth/password";
import { AppError } from "@/server/http/errors";
import { toMe } from "./dto";

/** Creates a user and a new workspace, with the user as its owner. */
export async function registerOwner(input: RegisterInput): Promise<Me> {
  const passwordHash = await hashPassword(input.password);

  try {
    return await db.transaction(async (tx) => {
      const [user] = await tx
        .insert(users)
        .values({ email: input.email, name: input.name, passwordHash, lastLoginAt: new Date() })
        .returning();
      const [workspace] = await tx
        .insert(workspaces)
        .values({ name: input.workspaceName })
        .returning();
      const [member] = await tx
        .insert(workspaceMembers)
        .values({ workspaceId: workspace.id, userId: user.id, role: "owner", status: "active" })
        .returning();
      await tx.insert(auditLogs).values({
        workspaceId: workspace.id,
        actorId: user.id,
        action: "workspace.created",
        entityType: "workspace",
        entityId: workspace.id,
      });
      return toMe(user, member, workspace);
    });
  } catch (error) {
    if (isUniqueViolation(error, "users_email_idx")) {
      const message = "An account with this email already exists.";
      throw new AppError("EMAIL_TAKEN", message, { email: [message] });
    }
    throw error;
  }
}

/**
 * Checks email + password and picks the workspace to sign into: the user's oldest active
 * membership (a workspace switcher can change it later). Every failure gives the same error
 * so accounts can't be probed.
 */
export async function verifyCredentials(input: LoginInput): Promise<Me> {
  const [user] = await db.select().from(users).where(eq(users.email, input.email)).limit(1);

  if (!user?.passwordHash) {
    await verifyDummyPassword(input.password);
    throw invalidCredentials();
  }
  if (!(await verifyPassword(user.passwordHash, input.password))) {
    throw invalidCredentials();
  }

  const [membership] = await db
    .select({ member: workspaceMembers, workspace: workspaces })
    .from(workspaceMembers)
    .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
    .where(and(eq(workspaceMembers.userId, user.id), eq(workspaceMembers.status, "active")))
    .orderBy(asc(workspaceMembers.createdAt))
    .limit(1);
  if (!membership) throw invalidCredentials();

  await db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, user.id));
  return toMe(user, membership.member, membership.workspace);
}

function invalidCredentials(): AppError {
  return new AppError("INVALID_CREDENTIALS", "Incorrect email or password.");
}
