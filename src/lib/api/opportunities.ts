import type { StatusGroup } from "@/lib/domain/opportunities";
import type { UpdateOpportunityValues } from "@/lib/validation/opportunities";
import { apiRequest } from "./client";
import type { OpportunityDetail, OpportunityList } from "./types";

export const opportunitiesApi = {
  list: (group: StatusGroup, search: string, signal?: AbortSignal) => {
    const params = new URLSearchParams({ group });
    if (search) params.set("q", search);
    return apiRequest<OpportunityList>(`/opportunities?${params}`, { signal });
  },
  get: (id: string, signal?: AbortSignal) => apiRequest<OpportunityDetail>(`/opportunities/${id}`, { signal }),
  update: (id: string, input: UpdateOpportunityValues) =>
    apiRequest<OpportunityDetail>(`/opportunities/${id}`, { method: "PATCH", body: input }),
};
