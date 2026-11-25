"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { jobspyApi } from "@/lib/api/jobspy";

/** Own key (not in query-keys.ts) so the feature stays self-contained. */
const JOBSPY_KEY = ["jobspy"] as const;

export function useJobspy() {
  return useQuery({ queryKey: JOBSPY_KEY, queryFn: ({ signal }) => jobspyApi.status(signal) });
}

export function useRunJobspy() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: jobspyApi.run,
    onSuccess: (status) => {
      queryClient.setQueryData(JOBSPY_KEY, status);
      // With "Send to Opportunities" on, new jobs are matched just after the run.
      if (status.sendToOpportunities) setTimeout(() => void queryClient.invalidateQueries({ queryKey: ["opportunities"] }), 15_000);
    },
    // A refused run (cooldown) still means the status shown may be stale.
    onError: () => queryClient.invalidateQueries({ queryKey: JOBSPY_KEY }),
  });
}

/** "Send to Opportunities": matching or removing changes companies, signals and scores. */
export function useSetJobspySendToOpportunities() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: jobspyApi.setSendToOpportunities,
    onSuccess: ({ status }) => {
      queryClient.setQueryData(JOBSPY_KEY, status);
      for (const key of [["opportunities"], ["companies"], ["signals"]]) void queryClient.invalidateQueries({ queryKey: key });
    },
  });
}
