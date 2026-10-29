"use client";

import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { listsApi } from "@/lib/api/lists";
import type { ListInput } from "@/lib/validation/lists";
import { queryKeys } from "./query-keys";

/** Lists and their contents show up on the lists pages and on each opportunity (its `listIds`). */
const refreshLists = (queryClient: QueryClient) =>
  Promise.all([
    queryClient.invalidateQueries({ queryKey: queryKeys.lists }),
    queryClient.invalidateQueries({ queryKey: queryKeys.opportunities }),
  ]);

export function useLists() {
  return useQuery({ queryKey: queryKeys.lists, queryFn: ({ signal }) => listsApi.list(signal) });
}

export function useList(id: string) {
  return useQuery({ queryKey: queryKeys.list(id), queryFn: ({ signal }) => listsApi.get(id, signal) });
}

export function useCreateList() {
  const queryClient = useQueryClient();
  return useMutation({ mutationFn: listsApi.create, onSuccess: () => refreshLists(queryClient) });
}

export function useRenameList() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: ListInput }) => listsApi.rename(id, input),
    onSuccess: () => refreshLists(queryClient),
  });
}

export function useDeleteList() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: listsApi.remove,
    // Opportunity queries are only marked stale: refetching the open (deleted) list's page
    // would flash "not found" before the caller navigates away.
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.lists }),
        queryClient.invalidateQueries({ queryKey: queryKeys.opportunities, refetchType: "none" }),
      ]),
  });
}

/** Adds an opportunity to a list (`saved: true`) or takes it off (`saved: false`). */
export function useToggleSaved() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ listId, opportunityId, saved }: { listId: string; opportunityId: string; saved: boolean }) =>
      saved ? listsApi.addOpportunity(listId, opportunityId) : listsApi.removeOpportunity(listId, opportunityId),
    onSuccess: () => refreshLists(queryClient),
  });
}
