import type { InviteMemberInput, UpdateMemberInput } from "@/lib/validation/members";
import { apiRequest } from "./client";
import type { CreatedInvitation, Team } from "./types";

export const membersApi = {
  team: (signal?: AbortSignal) => apiRequest<Team>("/workspaces/me/members", { signal }),
  invite: (input: InviteMemberInput) =>
    apiRequest<CreatedInvitation>("/workspaces/me/invitations", { method: "POST", body: input }),
  revokeInvitation: (id: string) => apiRequest<void>(`/workspaces/me/invitations/${id}`, { method: "DELETE" }),
  updateRole: (userId: string, input: UpdateMemberInput) =>
    apiRequest<Team>(`/workspaces/me/members/${userId}`, { method: "PATCH", body: input }),
  remove: (userId: string) => apiRequest<void>(`/workspaces/me/members/${userId}`, { method: "DELETE" }),
};

/** The link a teammate opens to join. Built in the browser so it always matches the address in use. */
export function invitationUrl(token: string): string {
  return `${window.location.origin}/invite/${token}`;
}
