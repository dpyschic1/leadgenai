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
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.services }),
  });
}

export function useUpdateService() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: ServiceInput }) => servicesApi.update(id, input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.services }),
  });
}

export function useDeleteService() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: servicesApi.remove,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.services }),
  });
}
