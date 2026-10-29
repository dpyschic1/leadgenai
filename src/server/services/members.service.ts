import "server-only";
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { isUniqueViolation } from "@/db/errors";
import { auditLogs, users, workspaceInvitations, workspaceMembers, workspaces } from "@/db/schema";
import type { CreatedInvitation, InvitationPreview, Me, PendingInvitation, Team, TeamMember } from "@/lib/api/types";
import { INVITATION_TTL_DAYS, MEMBER_ROLES } from "@/lib/domain/members";
import { ADMIN_ROLES, hasRole } from "@/lib/permissions";
import {
  acceptAsExistingUserSchema,
  acceptAsNewUserSchema,
  type AcceptInvitationInput,
  type InviteMemberInput,
  type UpdateMemberInput,
} from "@/lib/validation/members";
import { hashPassword, verifyPassword } from "@/server/auth/password";
import type { AuthContext } from "@/server/auth/session";
import { generateSessionToken as generateToken, hashSessionToken as hashToken } from "@/server/auth/session-token";
import { AppError } from "@/server/http/errors";
import { toMe } from "./dto";

/**
 * The workspace team (SRS FR-AUTH, §3 roles): members, invitations and accepting them.
 * Invitations work without email delivery: the inviter copies a one-time link to the teammate.
 */

const roleRank = (role: string) => MEMBER_ROLES.indexOf(role as (typeof MEMBER_ROLES)[number]);

export async function getTeam(auth: AuthContext): Promise<Team> {
  const [memberRows, invitations] = await Promise.all([
    db
      .select({ member: workspaceMembers, user: users })
      .from(workspaceMembers)
      .innerJoin(users, eq(users.id, workspaceMembers.userId))
      .where(and(eq(workspaceMembers.workspaceId, auth.workspaceId), eq(workspaceMembers.status, "active"))),
    hasRole(auth.role, ADMIN_ROLES) ? listInvitations(auth.workspaceId) : Promise.resolve([]),
  ]);

  const members: TeamMember[] = memberRows
    .map(({ member, user }) => ({
      userId: user.id,
      name: user.name,
      email: user.email,
      role: member.role,
      joinedAt: member.createdAt.toISOString(),
      lastLoginAt: user.lastLoginAt?.toISOString() ?? null,
    }))
    .sort((a, b) => roleRank(a.role) - roleRank(b.role) || (a.name ?? a.email).localeCompare(b.name ?? b.email));

  return { members, invitations };
}

/**
 * Invites `email` with `role` and returns the one-time token for the link. Inviting someone who
 * already has an open invitation replaces it, so "send a new link" is the same call.
 */
export async function inviteMember(auth: AuthContext, input: InviteMemberInput): Promise<CreatedInvitation> {
  const [existing] = await db
    .select({ userId: users.id })
    .from(users)
    .innerJoin(workspaceMembers, eq(workspaceMembers.userId, users.id))
    .where(and(eq(users.email, input.email), eq(workspaceMembers.workspaceId, auth.workspaceId)))
    .limit(1);
  if (existing) {
    const message = "This person is already in your workspace.";
    throw new AppError("ALREADY_EXISTS", message, { email: [message] });
  }

  const token = generateToken();
  const expiresAt = new Date(Date.now() + INVITATION_TTL_DAYS * 24 * 60 * 60 * 1000);
  const id = await db.transaction(async (tx) => {
    await tx
      .delete(workspaceInvitations)
      .where(
        and(
          eq(workspaceInvitations.workspaceId, auth.workspaceId),
          eq(workspaceInvitations.email, input.email),
          isNull(workspaceInvitations.acceptedAt),
        ),
      );
    const [row] = await tx
      .insert(workspaceInvitations)
      .values({
        workspaceId: auth.workspaceId,
        email: input.email,
        role: input.role,
        tokenHash: hashToken(token),
        invitedById: auth.userId,
        expiresAt,
      })
      .returning({ id: workspaceInvitations.id });
    await tx.insert(auditLogs).values(audit(auth, "member.invited", "invitation", row.id, { email: input.email, role: input.role }));
    return row.id;
  });

  const invitation = (await listInvitations(auth.workspaceId)).find((i) => i.id === id)!;
  return { invitation, token };
}

export async function revokeInvitation(auth: AuthContext, invitationId: string): Promise<void> {
  await db.transaction(async (tx) => {
    const [deleted] = await tx
      .delete(workspaceInvitations)
      .where(
        and(
          eq(workspaceInvitations.id, invitationId),
          eq(workspaceInvitations.workspaceId, auth.workspaceId),
          isNull(workspaceInvitations.acceptedAt),
        ),
      )
      .returning({ email: workspaceInvitations.email });
    if (!deleted) throw new AppError("NOT_FOUND", "Invitation not found.");
    await tx.insert(auditLogs).values(audit(auth, "member.invitation_revoked", "invitation", invitationId, { email: deleted.email }));
  });
}

/** Changes a teammate's role. Takes effect on their next request, since roles are read per request. */
export async function updateMemberRole(auth: AuthContext, userId: string, input: UpdateMemberInput): Promise<Team> {
  const target = await findManageableMember(auth, userId, "change your own role");
  await db.transaction(async (tx) => {
    await tx
      .update(workspaceMembers)
      .set({ role: input.role })
      .where(and(eq(workspaceMembers.workspaceId, auth.workspaceId), eq(workspaceMembers.userId, userId)));
    if (target.role !== input.role) {
      await tx.insert(auditLogs).values(audit(auth, "member.role_changed", "user", userId, { from: target.role, to: input.role }));
    }
  });
  return getTeam(auth);
}

/** Removes a teammate. Deleting the membership also ends their sessions (sessions_member_fk cascades). */
export async function removeMember(auth: AuthContext, userId: string): Promise<void> {
  const target = await findManageableMember(auth, userId, "remove yourself");
  await db.transaction(async (tx) => {
    await tx
      .delete(workspaceMembers)
      .where(and(eq(workspaceMembers.workspaceId, auth.workspaceId), eq(workspaceMembers.userId, userId)));
    await tx.insert(auditLogs).values(audit(auth, "member.removed", "user", userId, { role: target.role }));
  });
}

/** Public: what the invitation page shows. Unknown, used and expired links all look the same. */
export async function getInvitationPreview(token: string): Promise<InvitationPreview> {
  const invitation = await findOpenInvitation(token);
  const [account] = await db.select({ id: users.id }).from(users).where(eq(users.email, invitation.email)).limit(1);
  return {
    workspaceName: invitation.workspaceName,
    email: invitation.email,
    role: invitation.role,
    invitedBy: invitation.invitedBy,
    accountExists: account !== undefined,
  };
}

/**
 * Public: joins the workspace. Someone new chooses a name and password; someone who already has
 * an account (in another workspace) proves it with their password. Returns who to sign in as.
 */
export async function acceptInvitation(token: string, input: AcceptInvitationInput): Promise<Me> {
  const invitation = await findOpenInvitation(token);
  const [account] = await db.select().from(users).where(eq(users.email, invitation.email)).limit(1);

  // Password hashing/verification is slow, so it happens before the transaction opens.
  let newUser: { name: string; passwordHash: string } | null = null;
  if (account) {
    const { password } = validate(acceptAsExistingUserSchema, input);
    if (!account.passwordHash || !(await verifyPassword(account.passwordHash, password))) {
      const message = "Incorrect password for this account.";
      throw new AppError("INVALID_CREDENTIALS", message, { password: [message] });
    }
  } else {
    const { name, password } = validate(acceptAsNewUserSchema, input);
    newUser = { name, passwordHash: await hashPassword(password) };
  }

  try {
    return await db.transaction(async (tx) => {
      // Lock the invitation so two tabs can't both accept it.
      const [open] = await tx
        .select({ id: workspaceInvitations.id })
        .from(workspaceInvitations)
        .where(and(eq(workspaceInvitations.id, invitation.id), isNull(workspaceInvitations.acceptedAt)))
        .for("update");
      if (!open) throw invalidInvitation();

      const userId = newUser
        ? (
            await tx
              .insert(users)
              .values({ email: invitation.email, name: newUser.name, passwordHash: newUser.passwordHash })
              .returning({ id: users.id })
          )[0].id
        : account!.id;
      await tx
        .insert(workspaceMembers)
        .values({ workspaceId: invitation.workspaceId, userId, role: invitation.role, status: "active" })
        .onConflictDoNothing();
      await tx
        .update(workspaceInvitations)
        .set({ acceptedAt: new Date() })
        .where(eq(workspaceInvitations.id, invitation.id));
      await tx.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, userId));
      await tx.insert(auditLogs).values({
        workspaceId: invitation.workspaceId,
        actorId: userId,
        action: "member.joined",
        entityType: "user",
        entityId: userId,
        metadata: { role: invitation.role, invitationId: invitation.id },
      });

      const [row] = await tx
        .select({ user: users, member: workspaceMembers, workspace: workspaces })
        .from(workspaceMembers)
        .innerJoin(users, eq(users.id, workspaceMembers.userId))
        .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
        .where(and(eq(workspaceMembers.workspaceId, invitation.workspaceId), eq(workspaceMembers.userId, userId)));
      return toMe(row.user, row.member, row.workspace);
    });
  } catch (error) {
    // Someone signed up with this email between loading the page and accepting.
    if (isUniqueViolation(error, "users_email_idx")) {
      throw new AppError("ALREADY_EXISTS", "An account with this email was just created. Reload the page and sign in with it.");
    }
    throw error;
  }
}

async function listInvitations(workspaceId: string): Promise<PendingInvitation[]> {
  const rows = await db
    .select({ invitation: workspaceInvitations, invitedBy: users.name })
    .from(workspaceInvitations)
    .leftJoin(users, eq(users.id, workspaceInvitations.invitedById))
    .where(and(eq(workspaceInvitations.workspaceId, workspaceId), isNull(workspaceInvitations.acceptedAt)))
    .orderBy(sql`${workspaceInvitations.createdAt} desc`);
  const now = Date.now();
  return rows.map(({ invitation, invitedBy }) => ({
    id: invitation.id,
    email: invitation.email,
    role: invitation.role,
    invitedBy,
    createdAt: invitation.createdAt.toISOString(),
    expiresAt: invitation.expiresAt.toISOString(),
    expired: invitation.expiresAt.getTime() <= now,
  }));
}

/** The owner is fixed and nobody manages their own membership, so a workspace always keeps its owner. */
async function findManageableMember(auth: AuthContext, userId: string, selfAction: string) {
  if (userId === auth.userId) throw new AppError("FORBIDDEN", `You can't ${selfAction}.`);
  const [target] = await db
    .select({ role: workspaceMembers.role })
    .from(workspaceMembers)
    .where(and(eq(workspaceMembers.workspaceId, auth.workspaceId), eq(workspaceMembers.userId, userId)))
    .limit(1);
  if (!target) throw new AppError("NOT_FOUND", "Team member not found.");
  if (target.role === "owner") throw new AppError("FORBIDDEN", "The workspace owner can't be changed or removed.");
  return target;
}

async function findOpenInvitation(token: string) {
  const [row] = await db
    .select({
      id: workspaceInvitations.id,
      workspaceId: workspaceInvitations.workspaceId,
      email: workspaceInvitations.email,
      role: workspaceInvitations.role,
      workspaceName: workspaces.name,
      invitedBy: users.name,
    })
    .from(workspaceInvitations)
    .innerJoin(workspaces, eq(workspaces.id, workspaceInvitations.workspaceId))
    .leftJoin(users, eq(users.id, workspaceInvitations.invitedById))
    .where(
      and(
        eq(workspaceInvitations.tokenHash, hashToken(token)),
        isNull(workspaceInvitations.acceptedAt),
        gt(workspaceInvitations.expiresAt, sql`now()`),
      ),
    )
    .limit(1);
  if (!row) throw invalidInvitation();
  return row;
}

function validate<S extends z.ZodType>(schema: S, input: unknown): z.output<S> {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new AppError("VALIDATION_FAILED", "Some fields are invalid.", z.flattenError(result.error).fieldErrors);
  }
  return result.data;
}

function audit(auth: AuthContext, action: string, entityType: string, entityId: string, metadata: Record<string, unknown>) {
  return { workspaceId: auth.workspaceId, actorId: auth.userId, action, entityType, entityId, metadata };
}

function invalidInvitation(): AppError {
  return new AppError("NOT_FOUND", "This invitation link is invalid, already used or expired. Ask for a new one.");
}
