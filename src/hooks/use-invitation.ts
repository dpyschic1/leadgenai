"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { invitationsApi } from "@/lib/api/invitations";
import type { AcceptInvitationInput } from "@/lib/validation/members";
import { queryKeys } from "./query-keys";

export function useInvitationPreview(token: string) {
  return useQuery({
    queryKey: queryKeys.invitation(token),
    queryFn: ({ signal }) => invitationsApi.preview(token, signal),
    retry: false,
  });
}

/** Navigation is left to the caller, like the other auth mutations. */
export function useAcceptInvitation(token: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: AcceptInvitationInput) => invitationsApi.accept(token, input),
    onSuccess: (me) => queryClient.setQueryData(queryKeys.me, me),
  });
}
