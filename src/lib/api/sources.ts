import type { SourceSlug } from "@/lib/domain/sources";
import { apiRequest } from "./client";
import type { CompanySources, DataSource, SourcesRunResult } from "./types";

export const dataSourcesApi = {
  list: (signal?: AbortSignal) => apiRequest<DataSource[]>("/sources", { signal }),
  setEnabled: (slug: SourceSlug, enabled: boolean) => apiRequest<DataSource[]>(`/sources/${slug}`, { method: "PATCH", body: { enabled } }),
  /** "Run now": finds companies for the ICP and checks tenders, ~30 s. */
  runNow: () => apiRequest<SourcesRunResult>("/sources", { method: "POST" }),
  forCompany: (companyId: string, signal?: AbortSignal) => apiRequest<CompanySources>(`/companies/${companyId}/sources`, { signal }),
  refreshCompany: (companyId: string) => apiRequest<CompanySources>(`/companies/${companyId}/sources`, { method: "POST" }),
};
