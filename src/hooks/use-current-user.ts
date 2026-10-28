"use client";

import { useQuery } from "@tanstack/react-query";
import { workspacesApi } from "@/lib/api/workspaces";
import { queryKeys } from "./query-keys";

/** The signed-in user and their workspace. A 401 is handled globally by the QueryProvider. */
export function useCurrentUser() {
  return useQuery({
    queryKey: queryKeys.me,
    queryFn: ({ signal }) => workspacesApi.me(signal),
    staleTime: 5 * 60 * 1000,
  });
}
