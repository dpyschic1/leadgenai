import { apiRequest } from "./client";
import type { ReferenceData } from "./types";

export const referenceDataApi = {
  get: (signal?: AbortSignal) => apiRequest<ReferenceData>("/reference-data", { signal }),
};
