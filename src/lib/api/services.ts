import { setPageParams, type Pagination } from "@/lib/validation/pagination";
import type { ServiceInput } from "@/lib/validation/services";
import { apiRequest } from "./client";
import type { Service, ServiceList } from "./types";

export const servicesApi = {
  list: (page: Pagination, signal?: AbortSignal) => {
    const params = setPageParams(new URLSearchParams(), page);
    return apiRequest<ServiceList>(params.size ? `/services?${params}` : "/services", { signal });
  },
  create: (input: ServiceInput) => apiRequest<Service>("/services", { method: "POST", body: input }),
  update: (id: string, input: ServiceInput) =>
    apiRequest<Service>(`/services/${id}`, { method: "PATCH", body: input }),
  remove: (id: string) => apiRequest<void>(`/services/${id}`, { method: "DELETE" }),
};
