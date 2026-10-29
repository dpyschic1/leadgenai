import type { OpportunityExportQuery } from "@/lib/validation/opportunities";
import { apiDownload } from "./client";

export const exportsApi = {
  /** CSV of one saved list, or of the feed filtered by status group and search. */
  opportunities: (query: OpportunityExportQuery) => {
    const params = new URLSearchParams();
    if (query.listId) params.set("listId", query.listId);
    else {
      if (query.group) params.set("group", query.group);
      if (query.q) params.set("q", query.q);
    }
    return apiDownload(`/exports/opportunities?${params}`, "opportunities.csv");
  },
};
