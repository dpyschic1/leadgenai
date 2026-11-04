import type { LeadTab, StatusGroup } from "@/lib/domain/opportunities";
import type { FeedbackInput } from "@/lib/validation/feedback";
import type { InterpretSearchInput, OpportunityFilters, UpdateOpportunityValues } from "@/lib/validation/opportunities";
import { setPageParams, type Pagination } from "@/lib/validation/pagination";
import { apiRequest } from "./client";
import type { InterpretedSearch, LeadList, OpportunityDetail, OpportunityList } from "./types";

/** Adds the active filters to `params` (lists comma-separated); empty filters are left out. */
export function setFilterParams(params: URLSearchParams, filters: OpportunityFilters): URLSearchParams {
  for (const [key, value] of Object.entries(filters)) {
    if (Array.isArray(value) ? value.length > 0 : value !== null && value !== "") {
      params.set(key, Array.isArray(value) ? value.join(",") : String(value));
    }
  }
  return params;
}

export const opportunitiesApi = {
  list: (group: StatusGroup, filters: OpportunityFilters, page: Pagination, signal?: AbortSignal) =>
    apiRequest<OpportunityList>(`/opportunities?${setPageParams(setFilterParams(new URLSearchParams({ group }), filters), page)}`, { signal }),
  get: (id: string, signal?: AbortSignal) => apiRequest<OpportunityDetail>(`/opportunities/${id}`, { signal }),
  /** The Leads page: one tab and page of active leads, with every tab's count. */
  leads: (tab: LeadTab, q: string, page: Pagination, signal?: AbortSignal) => {
    const params = new URLSearchParams(tab === "all" ? {} : { tab });
    if (q) params.set("q", q);
    return apiRequest<LeadList>(`/leads?${setPageParams(params, page)}`, { signal });
  },
  update: (id: string, input: UpdateOpportunityValues) =>
    apiRequest<OpportunityDetail>(`/opportunities/${id}`, { method: "PATCH", body: input }),
  /** Gives the signed-in user's verdict; resolves with the opportunity, re-matched if it corrects it. */
  giveFeedback: (id: string, input: FeedbackInput) =>
    apiRequest<OpportunityDetail>(`/opportunities/${id}/feedback`, { method: "POST", body: input }),
  removeFeedback: (id: string, feedbackId: string) =>
    apiRequest<OpportunityDetail>(`/opportunities/${id}/feedback/${feedbackId}`, { method: "DELETE" }),
  /** AI search: turns a plain-language request into filters. */
  interpret: (input: InterpretSearchInput) =>
    apiRequest<InterpretedSearch>("/opportunities/interpret", { method: "POST", body: input }),
};
