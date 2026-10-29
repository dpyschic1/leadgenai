import type { AcceptInvitationInput } from "@/lib/validation/members";
import { apiRequest } from "./client";
import type { InvitationPreview, Me } from "./types";

/** Public endpoints used by the invitation page, before the teammate has a session. */
export const invitationsApi = {
  preview: (token: string, signal?: AbortSignal) =>
    apiRequest<InvitationPreview>(`/invitations/${encodeURIComponent(token)}`, { signal }),
  accept: (token: string, input: AcceptInvitationInput) =>
    apiRequest<Me>(`/invitations/${encodeURIComponent(token)}/accept`, { method: "POST", body: input }),
};
