import "server-only";
import type { users, workspaceMembers, workspaces } from "@/db/schema";
import type { Me } from "@/lib/api/types";

type UserRow = typeof users.$inferSelect;
type MemberRow = typeof workspaceMembers.$inferSelect;
type WorkspaceRow = typeof workspaces.$inferSelect;

/** Maps DB rows to the public DTO. Picks fields explicitly so secrets (passwordHash) never leak. */
export function toMe(user: UserRow, member: MemberRow, workspace: WorkspaceRow): Me {
  return {
    user: { id: user.id, email: user.email, name: user.name, role: member.role },
    workspace: {
      id: workspace.id,
      name: workspace.name,
      plan: workspace.plan,
      timezone: workspace.timezone,
    },
  };
}
