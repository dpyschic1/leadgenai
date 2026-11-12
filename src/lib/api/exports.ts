import type { StatusGroup } from "@/lib/domain/opportunities";
import type { OpportunityFilters, OpportunitySort } from "@/lib/validation/opportunities";
import { apiDownload } from "./client";
import { setFilterParams } from "./opportunities";

/** What to export: one saved list, or the feed exactly as filtered on screen. */
export type ExportRequest = { listId: string } | { group: StatusGroup; filters: OpportunityFilters; sort?: OpportunitySort };

export const exportsApi = {
  opportunities: (request: ExportRequest) => {
    const params =
      "listId" in request
        ? new URLSearchParams({ listId: request.listId })
        : setFilterParams(new URLSearchParams(request.sort && request.sort !== "best" ? { group: request.group, sort: request.sort } : { group: request.group }), request.filters);
    return apiDownload(`/exports/opportunities?${params}`, "opportunities.csv");
  },
};
