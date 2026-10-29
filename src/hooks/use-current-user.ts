"use client";

import { useQuery } from "@tanstack/react-query";
import { workspacesApi } from "@/lib/api/workspaces";
import { useHydrated } from "./use-hydrated";
import { queryKeys } from "./query-keys";

/**
 * The signed-in user and their workspace. A 401 is handled globally by the QueryProvider.
 *
 * The sidebar fetches this as soon as the layout hydrates, so it can already be cached when a
 * slower page segment hydrates. Rendering it then would differ from the server's loading state
 * (a hydration error), so during hydration the data is reported as not loaded yet.
 */
export function useCurrentUser() {
  const query = useQuery({
    queryKey: queryKeys.me,
    queryFn: ({ signal }) => workspacesApi.me(signal),
    staleTime: 5 * 60 * 1000,
  });
  const hydrated = useHydrated();
  return { data: hydrated ? query.data : undefined };
}
