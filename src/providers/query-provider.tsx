"use client";

import { useState, type ReactNode } from "react";
import { QueryCache, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ApiError } from "@/lib/api/client";
import { goToLogin } from "@/lib/navigation";

function isClientError(error: unknown): boolean {
  return error instanceof ApiError && error.status < 500;
}

function createQueryClient(): QueryClient {
  return new QueryClient({
    queryCache: new QueryCache({
      onError: (error) => {
        // Session expired or revoked: one place handles it for every query.
        // Never clear the cache here: mounted queries would refetch, 401 again and loop.
        if (error instanceof ApiError && error.status === 401) goToLogin();
      },
    }),
    defaultOptions: {
      queries: {
        // 4xx responses won't change on retry; only retry server/network failures.
        retry: (failureCount, error) => !isClientError(error) && failureCount < 2,
        refetchOnWindowFocus: false,
      },
    },
  });
}

export function QueryProvider({ children }: { children: ReactNode }) {
  const [queryClient] = useState(createQueryClient);
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}
