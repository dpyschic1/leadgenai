"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { signalsApi } from "@/lib/api/signals";
import type { SignalValues } from "@/lib/validation/signals";
import { queryKeys } from "./query-keys";

export function useCompanySignals(companyId: string) {
  return useQuery({
    queryKey: queryKeys.companySignals(companyId),
    queryFn: ({ signal }) => signalsApi.listForCompany(companyId, signal),
  });
}

export function useRecentSignals(limit = 5) {
  return useQuery({ queryKey: queryKeys.recentSignals(limit), queryFn: ({ signal }) => signalsApi.listRecent(limit, signal) });
}

/** AI suggestion for pasted text. A mutation because it costs a model call and is never cached. */
export function useAnalyzeSignal() {
  return useMutation({ mutationFn: signalsApi.analyze });
}

export function useSaveSignal(companyId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ signalId, input }: { signalId?: string; input: SignalValues }) =>
      signalId ? signalsApi.update(signalId, input) : signalsApi.create(companyId, input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.signals }),
  });
}

export function useDeleteSignal() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: signalsApi.remove,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.signals }),
  });
}
