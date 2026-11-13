import type { LeadTab, RoleFamily, StatusGroup } from "@/lib/domain/opportunities";
import type { FeedbackInput } from "@/lib/validation/feedback";
import type { BulkOpportunitiesValues, InterpretSearchInput, OpportunityFilters, OpportunitySort, UpdateOpportunityValues } from "@/lib/validation/opportunities";
import { setPageParams, type Pagination } from "@/lib/validation/pagination";
import { apiRequest } from "./client";
import type { InterpretedSearch, LeadContacts, LeadList, OpportunityDetail, OpportunityList } from "./types";

/** Adds the active filters to `params` (lists comma-separated); empty filters are left out. */
export function setFilterParams(params: URLSearchParams, filters: OpportunityFilters): URLSearchParams {
  for (const [key, value] of Object.entries(filters)) {
    if (Array.isArray(value) ? value.length > 0 : value !== null && value !== "") {
      params.set(key, Array.isArray(value) ? value.join(",") : String(value));
    }
  }
  return params;
}

/** What the Leads page shows: a contact tab, a role type (null: any) and a search. */
export type LeadFilter = { tab: LeadTab; role: RoleFamily | null; q: string };

function leadParams({ tab, role, q }: LeadFilter): URLSearchParams {
  const params = new URLSearchParams();
  if (tab !== "all") params.set("tab", tab);
  if (role) params.set("role", role);
  if (q) params.set("q", q);
  return params;
}

export const opportunitiesApi = {
  list: (group: StatusGroup, filters: OpportunityFilters, page: Pagination, sort: OpportunitySort = "best", signal?: AbortSignal) =>
    apiRequest<OpportunityList>(
      `/opportunities?${setPageParams(setFilterParams(new URLSearchParams(sort === "best" ? { group } : { group, sort }), filters), page)}`,
      { signal },
    ),
  /** One action on several opportunities: move to a stage, archive/restore, or add to a list. */
  bulk: (input: BulkOpportunitiesValues) => apiRequest<{ changed: number }>("/opportunities/bulk", { method: "POST", body: input }),
  get: (id: string, signal?: AbortSignal) => apiRequest<OpportunityDetail>(`/opportunities/${id}`, { signal }),
  /** The Leads page: one tab, role type and page of active leads, with every tab's and role type's count. */
  leads: (filter: LeadFilter, page: Pagination, signal?: AbortSignal) =>
    apiRequest<LeadList>(`/leads?${setPageParams(leadParams(filter), page)}`, { signal }),
  /** Every lead the same filter matches, with its email and phone, for copying all at once. */
  leadContacts: (filter: LeadFilter) => apiRequest<LeadContacts>(`/leads/contacts?${leadParams(filter)}`),
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
