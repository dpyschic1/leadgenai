"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { dataSourcesApi } from "@/lib/api/sources";
import type { SourceSlug } from "@/lib/domain/sources";
import { queryKeys } from "./query-keys";

export function useDataSources() {
  return useQuery({ queryKey: queryKeys.dataSources, queryFn: ({ signal }) => dataSourcesApi.list(signal) });
}

export function useSetDataSourceEnabled() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ slug, enabled }: { slug: SourceSlug; enabled: boolean }) => dataSourcesApi.setEnabled(slug, enabled),
    onSuccess: (sources) => queryClient.setQueryData(queryKeys.dataSources, sources),
  });
}

/** "Run now": found companies and signals change the companies list, signals and opportunities. */
export function useRunSourcesNow() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: dataSourcesApi.runNow,
    onSettled: () =>
      Promise.all(
        [queryKeys.dataSources, queryKeys.companyLists, queryKeys.signals, queryKeys.opportunities].map((queryKey) =>
          queryClient.invalidateQueries({ queryKey }),
        ),
      ),
  });
}

/** Where a company's information came from; refreshes while checks are still queued. */
export function useCompanySources(companyId: string) {
  return useQuery({
    queryKey: queryKeys.companySources(companyId),
    queryFn: ({ signal }) => dataSourcesApi.forCompany(companyId, signal),
    refetchInterval: (query) => ((query.state.data?.pendingJobs ?? 0) > 0 ? 10_000 : false),
  });
}

/** "Refresh from sources": re-checks the register, website and job board now. */
export function useRefreshCompany(companyId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => dataSourcesApi.refreshCompany(companyId),
    onSuccess: (sources) => queryClient.setQueryData(queryKeys.companySources(companyId), sources),
    onSettled: () =>
      Promise.all(
        [queryKeys.company(companyId), queryKeys.signals, queryKeys.opportunities].map((queryKey) =>
          queryClient.invalidateQueries({ queryKey }),
        ),
      ),
  });
}
