"use client";

import { useMutation } from "@tanstack/react-query";
import { exportsApi, type ExportRequest } from "@/lib/api/exports";
import { saveFile } from "@/lib/download";

/** Downloads opportunities as CSV; resolves with the saved file's name. */
export function useExportOpportunities() {
  return useMutation({
    mutationFn: async (request: ExportRequest) => {
      const { blob, filename } = await exportsApi.opportunities(request);
      saveFile(blob, filename);
      return filename;
    },
  });
}
