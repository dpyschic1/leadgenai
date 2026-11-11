"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { engineApi } from "@/lib/api/engine";
import type { Capability, EngineWeights } from "@/lib/domain/engine";
import type { CapabilityUpdateInput } from "@/lib/validation/engine";
import { queryKeys } from "./query-keys";

export function useEngine() {
  return useQuery({ queryKey: queryKeys.engine, queryFn: ({ signal }) => engineApi.get(signal) });
}

export function useSetEngineEnabled() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: engineApi.setEnabled,
    onSuccess: (state) => queryClient.setQueryData(queryKeys.engine, state),
  });
}

export function useUpdateCapability() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ capability, input }: { capability: Capability; input: CapabilityUpdateInput }) =>
      engineApi.updateCapability(capability, input),
    onSuccess: (state) => queryClient.setQueryData(queryKeys.engine, state),
  });
}

export function useSaveEngineWeights() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (weights: EngineWeights | null) => engineApi.saveWeights(weights),
    onSuccess: (state) => {
      queryClient.setQueryData(queryKeys.engine, state);
      return queryClient.invalidateQueries({ queryKey: queryKeys.opportunities });
    },
  });
}

export function useRunCapability() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (capability: Capability) => engineApi.run(capability),
    onSuccess: ({ engine }) => {
      queryClient.setQueryData(queryKeys.engine, engine);
      return queryClient.invalidateQueries({ queryKey: queryKeys.opportunities });
    },
  });
}
