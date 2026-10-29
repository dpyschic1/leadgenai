/**
 * Workspace roles (SRS §3). The database enum is built from this array, so the schema, the API
 * validation and the role pickers can never drift apart.
 */

export const MEMBER_ROLES = ["owner", "admin", "manager", "member", "viewer"] as const;
export type MemberRole = (typeof MEMBER_ROLES)[number];

/** Roles that can be given to someone else. There is exactly one owner: whoever created the workspace. */
export const ASSIGNABLE_ROLES = ["admin", "manager", "member", "viewer"] as const satisfies readonly MemberRole[];
export type AssignableRole = (typeof ASSIGNABLE_ROLES)[number];

export const ROLE_LABELS: Record<MemberRole, string> = {
  owner: "Owner",
  admin: "Admin",
  manager: "Manager",
  member: "Member",
  viewer: "Viewer",
};

/** What each role can do, in the words the role picker shows. */
export const ROLE_DESCRIPTIONS: Record<MemberRole, string> = {
  owner: "Everything, including the team. Created the workspace.",
  admin: "Everything, including inviting and removing teammates.",
  manager: "Services, ICP and scoring, plus all sales work.",
  member: "Companies, signals, opportunities, lists and export.",
  viewer: "Can look at everything but change nothing.",
};

/** How long an invitation link works. */
export const INVITATION_TTL_DAYS = 7;
