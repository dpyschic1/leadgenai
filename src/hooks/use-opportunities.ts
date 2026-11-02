"use client";

import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { opportunitiesApi } from "@/lib/api/opportunities";
import type { StatusGroup } from "@/lib/domain/opportunities";
import { EMPTY_FILTERS, type OpportunityFilters, type UpdateOpportunityValues } from "@/lib/validation/opportunities";
import { queryKeys } from "./query-keys";

export function useOpportunities(group: StatusGroup, filters: OpportunityFilters = EMPTY_FILTERS) {
  return useQuery({
    queryKey: queryKeys.opportunityList(group, filters),
    queryFn: ({ signal }) => opportunitiesApi.list(group, filters, signal),
    placeholderData: keepPreviousData,
  });
}

/** AI search: resolves with the filters it understood, for the caller to apply. */
export function useInterpretSearch() {
  return useMutation({ mutationFn: opportunitiesApi.interpret });
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
