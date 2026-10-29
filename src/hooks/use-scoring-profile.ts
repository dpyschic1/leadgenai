"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { scoringApi } from "@/lib/api/scoring";
import { queryKeys } from "./query-keys";

export function useScoringProfile() {
  return useQuery({ queryKey: queryKeys.scoringProfile, queryFn: ({ signal }) => scoringApi.get(signal) });
}

export function useSaveScoringProfile() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: scoringApi.save,
    onSuccess: (profile) => queryClient.setQueryData(queryKeys.scoringProfile, profile),
  });
}
