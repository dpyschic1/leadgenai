import type { CompanyValues, PersonValues } from "@/lib/validation/companies";
import { apiRequest } from "./client";
import type { CompanyDetail, CompanySummary } from "./types";

export const companiesApi = {
  list: (search: string, signal?: AbortSignal) =>
    apiRequest<CompanySummary[]>(search ? `/companies?q=${encodeURIComponent(search)}` : "/companies", { signal }),
  get: (id: string, signal?: AbortSignal) => apiRequest<CompanyDetail>(`/companies/${id}`, { signal }),
  create: (input: CompanyValues) => apiRequest<CompanyDetail>("/companies", { method: "POST", body: input }),
  update: (id: string, input: CompanyValues) =>
    apiRequest<CompanyDetail>(`/companies/${id}`, { method: "PATCH", body: input }),
  remove: (id: string) => apiRequest<void>(`/companies/${id}`, { method: "DELETE" }),

  addPerson: (companyId: string, input: PersonValues) =>
    apiRequest<CompanyDetail>(`/companies/${companyId}/people`, { method: "POST", body: input }),
  updatePerson: (companyId: string, personId: string, input: PersonValues) =>
    apiRequest<CompanyDetail>(`/companies/${companyId}/people/${personId}`, { method: "PATCH", body: input }),
  removePerson: (companyId: string, personId: string) =>
    apiRequest<CompanyDetail>(`/companies/${companyId}/people/${personId}`, { method: "DELETE" }),
};
