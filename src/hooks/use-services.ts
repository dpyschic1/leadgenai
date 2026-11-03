"use client";

import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { servicesApi } from "@/lib/api/services";
import { MAX_PAGE_SIZE, type Pagination } from "@/lib/validation/pagination";
import type { ServiceInput } from "@/lib/validation/services";
import { queryKeys } from "./query-keys";

/** For pickers and checks that need every service: a workspace has far fewer than one full page. */
const ALL_SERVICES: Pagination = { page: 1, pageSize: MAX_PAGE_SIZE };

/** One page of services (the Services page), or all of them by default. */
export function useServices(page: Pagination = ALL_SERVICES) {
  return useQuery({
    queryKey: queryKeys.servicePage(page),
    queryFn: ({ signal }) => servicesApi.list(page, signal),
    placeholderData: keepPreviousData,
  });
}

export function useCreateService() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: servicesApi.create,
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.services }),
        queryClient.invalidateQueries({ queryKey: queryKeys.opportunities }),
      ]),
  });
}

export function useUpdateService() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: ServiceInput }) => servicesApi.update(id, input),
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.services }),
        queryClient.invalidateQueries({ queryKey: queryKeys.opportunities }),
      ]),
  });
}

export function useDeleteService() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: servicesApi.remove,
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.services }),
        queryClient.invalidateQueries({ queryKey: queryKeys.opportunities }),
      ]),
  });
}
