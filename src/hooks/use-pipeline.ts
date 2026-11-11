"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { pipelineApi } from "@/lib/api/pipeline";
import type { PipelineStage, StageKind } from "@/lib/domain/pipeline";
import { queryKeys } from "./query-keys";

export function usePipeline() {
  return useQuery({ queryKey: queryKeys.pipeline, queryFn: ({ signal }) => pipelineApi.list(signal), staleTime: 30_000 });
}

export function usePipelineReport() {
  return useQuery({ queryKey: [...queryKeys.pipeline, "report"], queryFn: ({ signal }) => pipelineApi.report(signal), staleTime: 30_000 });
}

/** Any pipeline change also changes what the feed's tabs and every card show. */
function usePipelineMutation<TInput>(fn: (input: TInput) => Promise<PipelineStage[]>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: (stages) => {
      queryClient.setQueryData(queryKeys.pipeline, stages);
      return queryClient.invalidateQueries({ queryKey: queryKeys.opportunities });
    },
  });
}

export const useCreateStage = () => usePipelineMutation((input: { name: string; kind: StageKind }) => pipelineApi.create(input));
export const useRenameStage = () => usePipelineMutation(({ id, name }: { id: string; name: string }) => pipelineApi.rename(id, name));
export const useDeleteStage = () => usePipelineMutation(({ id, moveTo }: { id: string; moveTo: string | null }) => pipelineApi.remove(id, moveTo));
export const useReorderStages = () => usePipelineMutation((stageIds: string[]) => pipelineApi.reorder(stageIds));
