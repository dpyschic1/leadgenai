"use client";

import { useMutation } from "@tanstack/react-query";
import { exportsApi } from "@/lib/api/exports";
import { saveFile } from "@/lib/download";
import type { OpportunityExportQuery } from "@/lib/validation/opportunities";

/** Downloads opportunities as CSV; resolves with the saved file's name. */
export function useExportOpportunities() {
  return useMutation({
    mutationFn: async (query: OpportunityExportQuery) => {
      const { blob, filename } = await exportsApi.opportunities(query);
      saveFile(blob, filename);
      return filename;
    },
  });
}
