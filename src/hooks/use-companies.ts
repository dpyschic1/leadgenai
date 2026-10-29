"use client";

import { keepPreviousData, useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { companiesApi } from "@/lib/api/companies";
import type { CompanyDetail } from "@/lib/api/types";
import type { CompanyValues, PersonValues } from "@/lib/validation/companies";
import { queryKeys } from "./query-keys";

/** After any company or people change: cache the fresh detail and refetch lists (counts change). */
function syncCompany(queryClient: QueryClient, company: CompanyDetail) {
  queryClient.setQueryData(queryKeys.company(company.id), company);
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: queryKeys.companyLists }),
    queryClient.invalidateQueries({ queryKey: queryKeys.opportunities }),
  ]);
}

export function useCompanies(search = "") {
  return useQuery({
    queryKey: queryKeys.companies(search),
    queryFn: ({ signal }) => companiesApi.list(search, signal),
    // Keep the current rows on screen while a new search loads.
    placeholderData: keepPreviousData,
  });
}

export function useCompany(id: string) {
  return useQuery({ queryKey: queryKeys.company(id), queryFn: ({ signal }) => companiesApi.get(id, signal) });
}

export function useCreateCompany() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: companiesApi.create,
    onSuccess: (company) => syncCompany(queryClient, company),
  });
}

export function useUpdateCompany(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CompanyValues) => companiesApi.update(id, input),
    onSuccess: (company) => syncCompany(queryClient, company),
  });
}

export function useDeleteCompany() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: companiesApi.remove,
    onSuccess: (_, id) => {
      queryClient.removeQueries({ queryKey: queryKeys.company(id) });
      return Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.companyLists }),
        queryClient.invalidateQueries({ queryKey: queryKeys.opportunities }),
      ]);
    },
  });
}

export function useSavePerson(companyId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ personId, input }: { personId?: string; input: PersonValues }) =>
      personId
        ? companiesApi.updatePerson(companyId, personId, input)
        : companiesApi.addPerson(companyId, input),
    onSuccess: (company) => syncCompany(queryClient, company),
  });
}

export function useRemovePerson(companyId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (personId: string) => companiesApi.removePerson(companyId, personId),
    onSuccess: (company) => syncCompany(queryClient, company),
  });
}
