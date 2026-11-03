"use client";

import { AlertTriangleIcon, CheckCircle2Icon, CircleSlashIcon, ExternalLinkIcon, Loader2Icon, PlayIcon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useDataSources, useRunSourcesNow, useSetDataSourceEnabled } from "@/hooks/use-data-sources";
import { usePermission } from "@/hooks/use-permission";
import type { DataSource } from "@/lib/api/types";
import { ADMIN_ROLES, EDITOR_ROLES } from "@/lib/permissions";
import { cn } from "@/lib/utils";
import { SettingsSection } from "./settings-section";

const when = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

/** Data sources: what each does, whether it is healthy, the workspace's on/off switch (FR-SIG-005) and "Run now". */
export function DataSourcesSettings() {
  const { data: sources } = useDataSources();
  const canEdit = usePermission(ADMIN_ROLES);
  const canRun = usePermission(EDITOR_ROLES);
  const runNow = useRunSourcesNow();

  const run = () =>
    runNow.mutate(undefined, {
      onSuccess: (result) =>
        toast.success(`${result.companiesAdded} new ${result.companiesAdded === 1 ? "company" : "companies"} · ${result.signalsCreated} new ${result.signalsCreated === 1 ? "signal" : "signals"}`, {
          description: result.pendingJobs > 0 ? "Still checking websites and job boards; more will appear over the next few minutes." : undefined,
        }),
      onError: (error) => toast.error(error.message),
    });

  return (
    <SettingsSection
      title="Data sources"
      description="Every day the system finds UK companies matching your Services & ICP, reads their websites and job boards, and checks public tenders. All sources are free and official, or the company's own published information. Switch one off to stop using it straight away."
      footer={
        canRun && (
          <Button onClick={run} disabled={runNow.isPending} aria-busy={runNow.isPending}>
            {runNow.isPending ? <Loader2Icon className="animate-spin" /> : <PlayIcon />}
            {runNow.isPending ? "Running…" : "Run now"}
          </Button>
        )
      }
    >
      {!sources ? (
        <div className="space-y-4">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-14 w-full" />
          ))}
        </div>
      ) : (
        <ul className="divide-y">
          {sources.map((source) => (
            <SourceRow key={source.slug} source={source} canEdit={canEdit} />
          ))}
        </ul>
      )}
    </SettingsSection>
  );
}

function SourceRow({ source, canEdit }: { source: DataSource; canEdit: boolean }) {
  const toggle = useSetDataSourceEnabled();
  const available = source.authorization === "approved" && source.configured;
  const on = source.enabled && available;

  const status = !source.configured
    ? { icon: CircleSlashIcon, text: "Needs setup: its API key isn't configured on the server.", tone: "text-amber-700" }
    : source.authorization !== "approved"
      ? { icon: CircleSlashIcon, text: "Not available: paused by the platform.", tone: "text-muted-foreground" }
      : source.lastFailure
        ? { icon: AlertTriangleIcon, text: `Last check failed ${when.format(new Date(source.lastFailure.at))}: ${source.lastFailure.message}`, tone: "text-amber-700" }
        : source.lastSuccessAt
          ? { icon: CheckCircle2Icon, text: `Working · last used ${when.format(new Date(source.lastSuccessAt))}`, tone: "text-[var(--signal-deep)]" }
          : { icon: CheckCircle2Icon, text: "Ready · not used yet", tone: "text-muted-foreground" };
  const StatusIcon = status.icon;

  return (
    <li className="flex items-start gap-4 py-4 first:pt-0 last:pb-0">
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-2 font-medium">
          {source.name}
          {source.termsUrl && (
            <a href={source.termsUrl} target="_blank" rel="noopener noreferrer" aria-label={`${source.name} terms`} className="text-muted-foreground hover:text-primary">
              <ExternalLinkIcon className="size-3.5" />
            </a>
          )}
        </p>
        <p className="mt-0.5 text-sm text-muted-foreground">{source.description}</p>
        <p className={cn("mt-1.5 flex items-start gap-1.5 text-xs", status.tone)}>
          <StatusIcon className="mt-px size-3.5 shrink-0" />
          <span className="break-words">{status.text}</span>
        </p>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={on}
        aria-label={`Use ${source.name}`}
        disabled={!canEdit || !available || toggle.isPending}
        onClick={() =>
          toggle.mutate(
            { slug: source.slug, enabled: !source.enabled },
            {
              onSuccess: () => toast.success(`${source.name} ${source.enabled ? "switched off" : "switched on"}.`),
              onError: (error) => toast.error(error.message),
            },
          )
        }
        className={cn(
          "relative mt-0.5 inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors outline-none focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50",
          on ? "bg-primary" : "bg-muted-foreground/30",
        )}
      >
        <span className={cn("inline-block size-5 rounded-full bg-white shadow transition-transform", on ? "translate-x-5" : "translate-x-0.5")} />
      </button>
    </li>
  );
}
