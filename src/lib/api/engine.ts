import type { Capability, EngineWeights } from "@/lib/domain/engine";
import type { CapabilityUpdateInput } from "@/lib/validation/engine";
import { apiRequest } from "./client";
import type { EngineState } from "./types";

export type RunResult = {
  summary: {
    status: "success" | "partial" | "failed";
    found: number;
    created: number;
    updated: number;
    skipped: number;
    sources: { source: string; ok: boolean; found: number; error?: string; note?: string }[];
  };
  engine: EngineState;
};

export const engineApi = {
  get: (signal?: AbortSignal) => apiRequest<EngineState>("/engine", { signal }),
  setEnabled: (enabled: boolean) => apiRequest<EngineState>("/engine", { method: "PUT", body: { enabled } }),
  updateCapability: (capability: Capability, input: CapabilityUpdateInput) =>
    apiRequest<EngineState>(`/engine/capabilities/${capability}`, { method: "PATCH", body: input }),
  saveWeights: (weights: EngineWeights | null) => apiRequest<EngineState>("/engine/scoring", { method: "PUT", body: { weights } }),
  run: (capability: Capability) => apiRequest<RunResult>(`/engine/capabilities/${capability}/run`, { method: "POST" }),
};
