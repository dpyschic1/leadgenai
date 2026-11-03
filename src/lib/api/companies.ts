import type { CompanyValues, PersonValues } from "@/lib/validation/companies";
import { setPageParams, type Pagination } from "@/lib/validation/pagination";
import { apiRequest } from "./client";
import type { CompanyDetail, CompanyList } from "./types";

export const companiesApi = {
  list: (search: string, page: Pagination, signal?: AbortSignal) => {
    const params = setPageParams(new URLSearchParams(search ? { q: search } : {}), page);
    return apiRequest<CompanyList>(params.size ? `/companies?${params}` : "/companies", { signal });
  },
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
