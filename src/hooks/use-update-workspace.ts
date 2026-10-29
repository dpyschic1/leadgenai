"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { workspacesApi } from "@/lib/api/workspaces";
import { queryKeys } from "./query-keys";

export function useUpdateWorkspace() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: workspacesApi.update,
    onSuccess: (me) => queryClient.setQueryData(queryKeys.me, me),
  });
}
