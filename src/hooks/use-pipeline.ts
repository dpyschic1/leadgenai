"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { opportunitiesApi } from "@/lib/api/opportunities";
import { pipelineApi } from "@/lib/api/pipeline";
import type { PipelineBoard } from "@/lib/api/types";
import type { PipelineStage, StageKind, StageRef } from "@/lib/domain/pipeline";
import { queryKeys } from "./query-keys";

export function usePipeline() {
  return useQuery({ queryKey: queryKeys.pipeline, queryFn: ({ signal }) => pipelineApi.list(signal), staleTime: 30_000 });
}

export function usePipelineReport() {
  return useQuery({ queryKey: [...queryKeys.pipeline, "report"], queryFn: ({ signal }) => pipelineApi.report(signal), staleTime: 30_000 });
}

export function usePipelineBoard() {
  return useQuery({ queryKey: queryKeys.pipelineBoard, queryFn: ({ signal }) => pipelineApi.board(signal), staleTime: 15_000 });
}

/**
 * Drops a lead into another stage. The card moves at once (it went where it was dropped), and goes
 * back if the server refuses; then the board, every list and the stage counts refresh.
 */
export function useMoveLead() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, stage }: { id: string; stage: StageRef }) => opportunitiesApi.bulk({ ids: [id], stageId: stage.id }),
    onMutate: async ({ id, stage }) => {
      await queryClient.cancelQueries({ queryKey: queryKeys.pipelineBoard });
      const before = queryClient.getQueryData<PipelineBoard>(queryKeys.pipelineBoard);
      if (before) {
        const now = new Date().toISOString();
        queryClient.setQueryData<PipelineBoard>(queryKeys.pipelineBoard, {
          ...before,
          items: before.items.map((card) => (card.id === id ? { ...card, stage, enteredStageAt: now } : card)),
        });
      }
      return { before };
    },
    onError: (_error, _input, context) => {
      if (context?.before) queryClient.setQueryData(queryKeys.pipelineBoard, context.before);
    },
    onSettled: () =>
      Promise.all([queryClient.invalidateQueries({ queryKey: queryKeys.opportunities }), queryClient.invalidateQueries({ queryKey: queryKeys.pipeline })]),
  });
}

export function useDashboardReport() {
  return useQuery({ queryKey: [...queryKeys.pipeline, "dashboard"], queryFn: ({ signal }) => pipelineApi.dashboard(signal), staleTime: 30_000 });
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
