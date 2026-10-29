"use client";

import { useQuery } from "@tanstack/react-query";
import { referenceDataApi } from "@/lib/api/reference-data";
import { queryKeys } from "./query-keys";

/** Global lookup lists. They change only with a migration, so they never go stale in a session. */
export function useReferenceData() {
  return useQuery({
    queryKey: queryKeys.referenceData,
    queryFn: ({ signal }) => referenceDataApi.get(signal),
    staleTime: Infinity,
  });
}
