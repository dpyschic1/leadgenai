import type { ScoringProfileInput } from "@/lib/validation/scoring";
import { apiRequest } from "./client";
import type { ScoringProfile } from "./types";

export const scoringApi = {
  get: (signal?: AbortSignal) => apiRequest<ScoringProfile>("/scoring-profile", { signal }),
  save: (input: ScoringProfileInput) =>
    apiRequest<ScoringProfile>("/scoring-profile", { method: "PUT", body: input }),
};
