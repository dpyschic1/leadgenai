"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { authApi } from "@/lib/api/auth";
import { queryKeys } from "./query-keys";

/**
 * Auth mutations. They keep the query cache in sync; navigation is left to the calling
 * component via `mutate(input, { onSuccess })`.
 */

export function useRegister() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: authApi.register,
    onSuccess: (me) => queryClient.setQueryData(queryKeys.me, me),
  });
}

export function useLogin() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: authApi.login,
    onSuccess: (me) => queryClient.setQueryData(queryKeys.me, me),
  });
}

/**
 * Callers must follow up with `goToLogin()`: the full reload is what discards cached data.
 * Clearing the cache here instead would make still-mounted queries refetch and 401.
 */
export function useLogout() {
  return useMutation({ mutationFn: authApi.logout });
}
