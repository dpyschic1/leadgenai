"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { servicesApi } from "@/lib/api/services";
import type { ServiceInput } from "@/lib/validation/services";
import { queryKeys } from "./query-keys";

export function useServices() {
  return useQuery({ queryKey: queryKeys.services, queryFn: ({ signal }) => servicesApi.list(signal) });
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
