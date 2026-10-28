import "server-only";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { isUniqueViolation } from "@/db/errors";
import { auditLogs, users, workspaces } from "@/db/schema";
import type { Me } from "@/lib/api/types";
import type { LoginInput, RegisterInput } from "@/lib/validation/auth";
import { hashPassword, verifyDummyPassword, verifyPassword } from "@/server/auth/password";
import { AppError } from "@/server/http/errors";
import { toMe } from "./dto";

/** Creates a new workspace with the registering user as its owner. */
export async function registerOwner(input: RegisterInput): Promise<Me> {
  const passwordHash = await hashPassword(input.password);

  try {
    return await db.transaction(async (tx) => {
      const [workspace] = await tx
        .insert(workspaces)
        .values({ name: input.workspaceName })
        .returning();
      const [user] = await tx
        .insert(users)
        .values({
          workspaceId: workspace.id,
          email: input.email,
          name: input.name,
          passwordHash,
          role: "owner",
          status: "active",
          lastLoginAt: new Date(),
        })
        .returning();
      await tx.insert(auditLogs).values({
        workspaceId: workspace.id,
        actorId: user.id,
        action: "workspace.created",
        entityType: "workspace",
        entityId: workspace.id,
      });
      return toMe(user, workspace);
    });
  } catch (error) {
    if (isUniqueViolation(error, "users_email_idx")) {
      const message = "An account with this email already exists.";
      throw new AppError("EMAIL_TAKEN", message, { email: [message] });
    }
    throw error;
  }
}

/** Checks email + password. Every failure gives the same error so accounts can't be probed. */
export async function verifyCredentials(input: LoginInput): Promise<Me> {
  const [row] = await db
    .select({ user: users, workspace: workspaces })
    .from(users)
    .innerJoin(workspaces, eq(workspaces.id, users.workspaceId))
    .where(eq(users.email, input.email))
    .limit(1);

  if (!row?.user.passwordHash) {
    await verifyDummyPassword(input.password);
    throw invalidCredentials();
  }
  const valid = await verifyPassword(row.user.passwordHash, input.password);
  if (!valid || row.user.status !== "active") {
    throw invalidCredentials();
  }

  await db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, row.user.id));
  return toMe(row.user, row.workspace);
}

function invalidCredentials(): AppError {
  return new AppError("INVALID_CREDENTIALS", "Incorrect email or password.");
}
