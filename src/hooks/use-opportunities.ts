"use client";

import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { opportunitiesApi } from "@/lib/api/opportunities";
import type { StatusGroup } from "@/lib/domain/opportunities";
import type { UpdateOpportunityValues } from "@/lib/validation/opportunities";
import { queryKeys } from "./query-keys";

export function useOpportunities(group: StatusGroup, search = "") {
  return useQuery({
    queryKey: queryKeys.opportunityList(group, search),
    queryFn: ({ signal }) => opportunitiesApi.list(group, search, signal),
    placeholderData: keepPreviousData,
  });
}

export function useOpportunity(id: string) {
  return useQuery({ queryKey: queryKeys.opportunity(id), queryFn: ({ signal }) => opportunitiesApi.get(id, signal) });
}

export function useUpdateOpportunity(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateOpportunityValues) => opportunitiesApi.update(id, input),
    onSuccess: (opportunity) => {
      queryClient.setQueryData(queryKeys.opportunity(id), opportunity);
      return queryClient.invalidateQueries({ queryKey: ["opportunities", "list"] });
    },
  });
}
