import type { AnalyzeSignalValues, SignalValues } from "@/lib/validation/signals";
import { apiRequest } from "./client";
import type { Signal, SignalAnalysis } from "./types";

export const signalsApi = {
  listForCompany: (companyId: string, signal?: AbortSignal) =>
    apiRequest<Signal[]>(`/companies/${companyId}/signals`, { signal }),
  listRecent: (limit: number, signal?: AbortSignal) => apiRequest<Signal[]>(`/signals?limit=${limit}`, { signal }),
  analyze: (input: AnalyzeSignalValues) =>
    apiRequest<SignalAnalysis>("/signals/analyze", { method: "POST", body: input }),
  create: (companyId: string, input: SignalValues) =>
    apiRequest<Signal>(`/companies/${companyId}/signals`, { method: "POST", body: input }),
  update: (id: string, input: SignalValues) => apiRequest<Signal>(`/signals/${id}`, { method: "PATCH", body: input }),
  remove: (id: string) => apiRequest<void>(`/signals/${id}`, { method: "DELETE" }),
};
