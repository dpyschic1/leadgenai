"use client";

import { keepPreviousData, useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { opportunitiesApi } from "@/lib/api/opportunities";
import type { OpportunityDetail } from "@/lib/api/types";
import type { LeadTab, StatusGroup } from "@/lib/domain/opportunities";
import type { FeedbackInput } from "@/lib/validation/feedback";
import { EMPTY_FILTERS, type BulkOpportunitiesValues, type OpportunityFilters, type OpportunitySort, type UpdateOpportunityValues } from "@/lib/validation/opportunities";
import { FIRST_PAGE, type Pagination } from "@/lib/validation/pagination";
import { queryKeys } from "./query-keys";

export function useOpportunities(group: StatusGroup, filters: OpportunityFilters = EMPTY_FILTERS, page: Pagination = FIRST_PAGE, sort: OpportunitySort = "best") {
  return useQuery({
    queryKey: queryKeys.opportunityList(group, filters, page, sort),
    queryFn: ({ signal }) => opportunitiesApi.list(group, filters, page, sort, signal),
    placeholderData: keepPreviousData,
  });
}

/** One action on the selected opportunities; every feed, list and count refreshes after it. */
export function useBulkOpportunities() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: BulkOpportunitiesValues) => opportunitiesApi.bulk(input),
    onSuccess: () => Promise.all([queryClient.invalidateQueries({ queryKey: queryKeys.opportunities }), queryClient.invalidateQueries({ queryKey: queryKeys.lists })]),
  });
}

/** One tab and page of the Leads page. */
export function useLeads(tab: LeadTab, q: string, page: Pagination) {
  return useQuery({
    queryKey: queryKeys.leads(tab, q, page),
    queryFn: ({ signal }) => opportunitiesApi.leads(tab, q, page, signal),
    placeholderData: keepPreviousData,
  });
}

/** Quality feedback. A flag can change the match, so every view of opportunities is refreshed. */
export function useGiveFeedback(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: FeedbackInput) => opportunitiesApi.giveFeedback(id, input),
    onSuccess: (opportunity) => refreshAfterFeedback(queryClient, id, opportunity),
  });
}

export function useRemoveFeedback(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (feedbackId: string) => opportunitiesApi.removeFeedback(id, feedbackId),
    onSuccess: (opportunity) => refreshAfterFeedback(queryClient, id, opportunity),
  });
}

function refreshAfterFeedback(queryClient: QueryClient, id: string, opportunity: OpportunityDetail) {
  queryClient.setQueryData(queryKeys.opportunity(id), opportunity);
  return Promise.all([
    // Feeds and lists show feedback counts and the (possibly re-matched) contact and service.
    queryClient.invalidateQueries({ queryKey: queryKeys.opportunities, predicate: (q) => q.queryKey[1] !== "detail" }),
    ...(opportunity.company ? [queryClient.invalidateQueries({ queryKey: queryKeys.company(opportunity.company.id) })] : []),
  ]);
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
