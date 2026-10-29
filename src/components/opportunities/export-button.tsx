"use client";

import { DownloadIcon, Loader2Icon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useExportOpportunities } from "@/hooks/use-export-opportunities";
import { usePermission } from "@/hooks/use-permission";
import type { OpportunityExportQuery } from "@/lib/validation/opportunities";
import { EDITOR_ROLES } from "@/lib/permissions";

/** Downloads what's on screen as CSV. Hidden for viewers, who can't export. */
export function ExportButton({ query, disabled }: { query: OpportunityExportQuery; disabled?: boolean }) {
  const canExport = usePermission(EDITOR_ROLES);
  const exportCsv = useExportOpportunities();
  if (!canExport) return null;

  return (
    <Button
      variant="outline"
      disabled={disabled || exportCsv.isPending}
      aria-busy={exportCsv.isPending}
      onClick={() =>
        exportCsv.mutate(query, {
          onSuccess: (filename) => toast.success(`Downloaded ${filename}`),
          onError: (error) => toast.error(error.message),
        })
      }
    >
      {exportCsv.isPending ? <Loader2Icon className="animate-spin" /> : <DownloadIcon />}
      Export CSV
    </Button>
  );
}
