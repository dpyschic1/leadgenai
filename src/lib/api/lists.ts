import type { ListInput } from "@/lib/validation/lists";
import { apiRequest } from "./client";
import type { SavedList, SavedListDetail } from "./types";

export const listsApi = {
  list: (signal?: AbortSignal) => apiRequest<SavedList[]>("/lists", { signal }),
  get: (id: string, signal?: AbortSignal) => apiRequest<SavedListDetail>(`/lists/${id}`, { signal }),
  create: (input: ListInput) => apiRequest<SavedList>("/lists", { method: "POST", body: input }),
  rename: (id: string, input: ListInput) => apiRequest<SavedList>(`/lists/${id}`, { method: "PATCH", body: input }),
  remove: (id: string) => apiRequest<void>(`/lists/${id}`, { method: "DELETE" }),
  addOpportunity: (listId: string, opportunityId: string) =>
    apiRequest<void>(`/lists/${listId}/opportunities/${opportunityId}`, { method: "PUT" }),
  removeOpportunity: (listId: string, opportunityId: string) =>
    apiRequest<void>(`/lists/${listId}/opportunities/${opportunityId}`, { method: "DELETE" }),
};
