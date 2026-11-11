import type { PipelineReport, PipelineStage, StageKind } from "@/lib/domain/pipeline";
import { apiRequest } from "./client";

export const pipelineApi = {
  report: (signal?: AbortSignal) => apiRequest<PipelineReport>("/pipeline/report", { signal }),
  list: (signal?: AbortSignal) => apiRequest<PipelineStage[]>("/pipeline", { signal }),
  create: (input: { name: string; kind: StageKind }) => apiRequest<PipelineStage[]>("/pipeline", { method: "POST", body: input }),
  rename: (id: string, name: string) => apiRequest<PipelineStage[]>(`/pipeline/${id}`, { method: "PATCH", body: { name } }),
  /** `moveTo` is where the stage's opportunities go; required when it has any. */
  remove: (id: string, moveTo: string | null) => apiRequest<PipelineStage[]>(`/pipeline/${id}`, { method: "DELETE", body: { moveTo } }),
  reorder: (stageIds: string[]) => apiRequest<PipelineStage[]>("/pipeline/order", { method: "PUT", body: { stageIds } }),
};
