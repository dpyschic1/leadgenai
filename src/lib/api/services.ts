import type { ServiceInput } from "@/lib/validation/services";
import { apiRequest } from "./client";
import type { Service } from "./types";

export const servicesApi = {
  list: (signal?: AbortSignal) => apiRequest<Service[]>("/services", { signal }),
  create: (input: ServiceInput) => apiRequest<Service>("/services", { method: "POST", body: input }),
  update: (id: string, input: ServiceInput) =>
    apiRequest<Service>(`/services/${id}`, { method: "PATCH", body: input }),
  remove: (id: string) => apiRequest<void>(`/services/${id}`, { method: "DELETE" }),
};
