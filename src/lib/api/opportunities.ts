import type { StatusGroup } from "@/lib/domain/opportunities";
import type { InterpretSearchInput, OpportunityFilters, UpdateOpportunityValues } from "@/lib/validation/opportunities";
import { apiRequest } from "./client";
import type { InterpretedSearch, OpportunityDetail, OpportunityList } from "./types";

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
  list: (group: StatusGroup, filters: OpportunityFilters, signal?: AbortSignal) =>
    apiRequest<OpportunityList>(`/opportunities?${setFilterParams(new URLSearchParams({ group }), filters)}`, { signal }),
  get: (id: string, signal?: AbortSignal) => apiRequest<OpportunityDetail>(`/opportunities/${id}`, { signal }),
  update: (id: string, input: UpdateOpportunityValues) =>
    apiRequest<OpportunityDetail>(`/opportunities/${id}`, { method: "PATCH", body: input }),
  /** AI search: turns a plain-language request into filters. */
  interpret: (input: InterpretSearchInput) =>
    apiRequest<InterpretedSearch>("/opportunities/interpret", { method: "POST", body: input }),
};
