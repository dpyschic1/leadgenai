"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { membersApi } from "@/lib/api/members";
import type { UpdateMemberInput } from "@/lib/validation/members";
import { queryKeys } from "./query-keys";

export function useTeam() {
  return useQuery({ queryKey: queryKeys.team, queryFn: ({ signal }) => membersApi.team(signal) });
}

export function useInviteMember() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: membersApi.invite,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.team }),
  });
}

export function useRevokeInvitation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: membersApi.revokeInvitation,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.team }),
  });
}

export function useUpdateMemberRole() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ userId, input }: { userId: string; input: UpdateMemberInput }) => membersApi.updateRole(userId, input),
    onSuccess: (team) => queryClient.setQueryData(queryKeys.team, team),
  });
}

export function useRemoveMember() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: membersApi.remove,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.team }),
  });
}
