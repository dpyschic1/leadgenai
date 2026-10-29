import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "@/db";
import { users, workspaceInvitations, workspaceMembers, workspaces } from "@/db/schema";
import type { AuthContext } from "@/server/auth/session";
import { AppError } from "@/server/http/errors";
import { registerOwner, verifyCredentials } from "@/server/services/auth.service";
import {
  acceptInvitation,
  getInvitationPreview,
  getTeam,
  inviteMember,
  removeMember,
  revokeInvitation,
  updateMemberRole,
} from "@/server/services/members.service";

/**
 * Team invitations (SRS §21: "invite a member and enforce roles"), end to end against the
 * real database (`npm run test:integration`). Removes everything it creates.
 */

const run = randomUUID().slice(0, 8);
const emailFor = (who: string) => `${who}-${run}@members.test`;

let owner: AuthContext;
let other: AuthContext;
const createdUserEmails: string[] = [];

async function signUp(who: string): Promise<AuthContext> {
  const me = await registerOwner({
    name: `Owner ${who}`,
    email: emailFor(who),
    password: "Members-test-1",
    workspaceName: `Members ${who} ${run}`,
  });
  return { userId: me.user.id, workspaceId: me.workspace.id, role: "owner" };
}

const asMember = (userId: string, role: AuthContext["role"]): AuthContext => ({ userId, workspaceId: owner.workspaceId, role });

async function expectCode(promise: Promise<unknown>, code: AppError["code"]): Promise<void> {
  await expect(promise).rejects.toSatisfy((error) => error instanceof AppError && error.code === code);
}

beforeAll(async () => {
  owner = await signUp("owner");
  other = await signUp("other");
});

afterAll(async () => {
  const contexts = [owner, other].filter(Boolean);
  await db.delete(workspaces).where(inArray(workspaces.id, contexts.map((c) => c.workspaceId)));
  await db.delete(users).where(inArray(users.email, [emailFor("owner"), emailFor("other"), ...createdUserEmails]));
});

describe("inviting someone new", () => {
  let token: string;
  let newUserId: string;

  it("creates an invitation that only owners and admins can see", async () => {
    const created = await inviteMember(owner, { email: emailFor("sales1"), role: "member" });
    token = created.token;
    expect(created.invitation).toMatchObject({ email: emailFor("sales1"), role: "member", expired: false });
    expect((await getTeam(owner)).invitations.map((i) => i.email)).toEqual([emailFor("sales1")]);
  });

  it("shows the invitation page, telling them they need a new account", async () => {
    expect(await getInvitationPreview(token)).toMatchObject({
      workspaceName: `Members owner ${run}`,
      email: emailFor("sales1"),
      role: "member",
      invitedBy: "Owner owner",
      accountExists: false,
    });
  });

  it("asks for a name and a proper password", async () => {
    await expectCode(acceptInvitation(token, { password: "short" }), "VALIDATION_FAILED");
  });

  it("joins the same workspace with their own account, then signs in normally", async () => {
    createdUserEmails.push(emailFor("sales1"));
    const me = await acceptInvitation(token, { name: "Ali Sales", password: "Sales-pass-1" });
    newUserId = me.user.id;
    expect(me.user).toMatchObject({ name: "Ali Sales", email: emailFor("sales1"), role: "member" });
    expect(me.workspace.id).toBe(owner.workspaceId);

    const signIn = await verifyCredentials({ email: emailFor("sales1"), password: "Sales-pass-1" });
    expect(signIn.workspace.id).toBe(owner.workspaceId);

    const team = await getTeam(owner);
    expect(team.members.map((m) => [m.name, m.role])).toEqual([
      ["Owner owner", "owner"],
      ["Ali Sales", "member"],
    ]);
    expect(team.invitations).toEqual([]);
  });

  it("can't use the same link twice", async () => {
    await expectCode(getInvitationPreview(token), "NOT_FOUND");
    await expectCode(acceptInvitation(token, { name: "Again", password: "Sales-pass-1" }), "NOT_FOUND");
  });

  it("can't invite someone who's already in the team", async () => {
    await expectCode(inviteMember(owner, { email: emailFor("sales1"), role: "viewer" }), "ALREADY_EXISTS");
  });

  it("hides invitations from members", async () => {
    await inviteMember(owner, { email: emailFor("hidden"), role: "viewer" });
    expect((await getTeam(asMember(newUserId, "member"))).invitations).toEqual([]);
  });

  describe("managing the new teammate", () => {
    it("lets the owner change their role", async () => {
      const team = await updateMemberRole(owner, newUserId, { role: "manager" });
      expect(team.members.find((m) => m.userId === newUserId)?.role).toBe("manager");
    });

    it("never lets anyone change their own role or the owner's", async () => {
      await expectCode(updateMemberRole(owner, owner.userId, { role: "admin" }), "FORBIDDEN");
      const admin = asMember(newUserId, "admin");
      await expectCode(updateMemberRole(admin, owner.userId, { role: "viewer" }), "FORBIDDEN");
      await expectCode(removeMember(admin, owner.userId), "FORBIDDEN");
    });

    it("doesn't let another workspace touch them", async () => {
      await expectCode(updateMemberRole(other, newUserId, { role: "viewer" }), "NOT_FOUND");
      await expectCode(removeMember(other, newUserId), "NOT_FOUND");
    });

    it("removes them, and they can no longer sign in to this workspace", async () => {
      await removeMember(owner, newUserId);
      const left = await db
        .select()
        .from(workspaceMembers)
        .where(and(eq(workspaceMembers.workspaceId, owner.workspaceId), eq(workspaceMembers.userId, newUserId)));
      expect(left).toEqual([]);
      await expectCode(verifyCredentials({ email: emailFor("sales1"), password: "Sales-pass-1" }), "INVALID_CREDENTIALS");
    });
  });
});

describe("inviting someone who already has an account", () => {
  it("adds this workspace to their account once they give their password", async () => {
    const { token } = await inviteMember(owner, { email: emailFor("other"), role: "viewer" });
    expect((await getInvitationPreview(token)).accountExists).toBe(true);

    await expectCode(acceptInvitation(token, { password: "wrong-password" }), "INVALID_CREDENTIALS");
    const me = await acceptInvitation(token, { password: "Members-test-1" });
    expect(me.workspace.id).toBe(owner.workspaceId);
    expect(me.user).toMatchObject({ id: other.userId, role: "viewer" });
  });
});

describe("invitation links", () => {
  it("are replaced by a new link for the same person", async () => {
    const first = await inviteMember(owner, { email: emailFor("resend"), role: "member" });
    const second = await inviteMember(owner, { email: emailFor("resend"), role: "admin" });
    await expectCode(getInvitationPreview(first.token), "NOT_FOUND");
    expect((await getInvitationPreview(second.token)).role).toBe("admin");
  });

  it("stop working once revoked", async () => {
    const { token, invitation } = await inviteMember(owner, { email: emailFor("revoked"), role: "member" });
    await expectCode(revokeInvitation(other, invitation.id), "NOT_FOUND");
    await revokeInvitation(owner, invitation.id);
    await expectCode(getInvitationPreview(token), "NOT_FOUND");
  });

  it("stop working once expired", async () => {
    const { token, invitation } = await inviteMember(owner, { email: emailFor("expired"), role: "member" });
    await db
      .update(workspaceInvitations)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(workspaceInvitations.id, invitation.id));
    await expectCode(getInvitationPreview(token), "NOT_FOUND");
    expect((await getTeam(owner)).invitations.find((i) => i.id === invitation.id)?.expired).toBe(true);
  });

  it("are meaningless as made-up tokens", async () => {
    await expectCode(getInvitationPreview("not-a-real-token"), "NOT_FOUND");
  });
});
