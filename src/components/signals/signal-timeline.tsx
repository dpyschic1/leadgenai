"use client";

import { useState } from "react";
import { ExternalLinkIcon, MoreHorizontalIcon, PencilIcon, RadarIcon, RadioTowerIcon, SparklesIcon, Trash2Icon, UserRoundIcon } from "lucide-react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/forms/confirm-dialog";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { useLookupNames } from "@/hooks/use-reference-data";
import { useDeleteSignal } from "@/hooks/use-signals";
import type { CompanyPerson, Signal, SignalRole } from "@/lib/api/types";
import type { IntentLevel } from "@/lib/domain/signals";
import { SOURCE_LABELS } from "@/lib/domain/sources";
import { cn } from "@/lib/utils";
import { EvidenceTag, IntentBadge, UrgencyBadge } from "./signal-badges";

const MARKER: Record<IntentLevel, string> = {
  explicit: "bg-[var(--signal-deep)] ring-[var(--signal-deep)]/20",
  high: "bg-primary ring-primary/20",
  medium: "bg-amber-400 ring-amber-400/25",
  low: "bg-slate-300 ring-slate-300/40",
  unknown: "bg-background ring-border border border-slate-300",
};

const dateFormat = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", year: "numeric" });

/** "12 Oct 2026" plus a relative hint ("3 days ago") for recent dates. */
function formatOccurred(isoDate: string, now = new Date()): { date: string; relative: string | null } {
  const date = new Date(`${isoDate}T12:00:00`);
  const days = Math.round((now.getTime() - date.getTime()) / 86_400_000);
  const relative = days <= 0 ? "Today" : days === 1 ? "Yesterday" : days < 30 ? `${days} days ago` : null;
  return { date: dateFormat.format(date), relative };
}

export function SignalTimeline({
  signals,
  people,
  canEdit,
  onEdit,
  roles,
}: {
  signals: Signal[];
  people: CompanyPerson[];
  canEdit: boolean;
  onEdit: (signal: Signal) => void;
  /** On an opportunity: how each signal counts (lead, supporting or negative). */
  roles?: Map<string, SignalRole>;
}) {
  const [deleting, setDeleting] = useState<Signal | null>(null);
  const remove = useDeleteSignal();
  const personName = new Map(people.map((p) => [p.id, p.name]));

  return (
    <>
      <ol className="relative px-5 py-2">
        {signals.map((signal, index) => (
          <SignalItem
            key={signal.id}
            signal={signal}
            personName={signal.personId ? personName.get(signal.personId) : undefined}
            role={roles?.get(signal.id)}
            isLast={index === signals.length - 1}
            canEdit={canEdit}
            onEdit={() => onEdit(signal)}
            onDelete={() => setDeleting(signal)}
          />
        ))}
      </ol>
      <ConfirmDialog
        open={deleting !== null}
        title="Delete this signal?"
        description="It will no longer count towards this company's opportunities."
        confirmLabel="Delete signal"
        pending={remove.isPending}
        onClose={() => setDeleting(null)}
        onConfirm={() =>
          deleting &&
          remove.mutate(deleting.id, {
            onSuccess: () => {
              toast.success("Signal deleted.");
              setDeleting(null);
            },
            onError: (error) => toast.error(error.message),
          })
        }
      />
    </>
  );
}

function SignalItem({
  signal,
  personName,
  role,
  isLast,
  canEdit,
  onEdit,
  onDelete,
}: {
  signal: Signal;
  personName?: string;
  role?: SignalRole;
  isLast: boolean;
  canEdit: boolean;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const names = useLookupNames();
  const category = names.signalCategoryOf(signal.signalType);
  const when = formatOccurred(signal.occurredOn);

  return (
    <li className="relative flex gap-4 py-4">
      {!isLast && <span aria-hidden="true" className="absolute top-9 bottom-0 left-[7px] w-px bg-border" />}
      <span aria-hidden="true" className={cn("relative mt-1.5 size-[15px] shrink-0 rounded-full ring-4", MARKER[signal.intentLevel])} />

      <div className="min-w-0 flex-1">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="flex flex-wrap items-center gap-2 font-medium">
              {names.signalType(signal.signalType)}
              {role && <RoleTag role={role} />}
            </p>
            <p className="text-xs text-muted-foreground">
              {category && <span>{names.signalCategory(category)}</span>}
              {category && <span aria-hidden="true"> / </span>}
              <time dateTime={signal.occurredOn}>{when.date}</time>
              {when.relative && <span>, {when.relative.toLowerCase()}</span>}
            </p>
          </div>
          {canEdit && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" className="-mt-1 -mr-2 shrink-0" aria-label="Signal actions">
                  <MoreHorizontalIcon />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onSelect={onEdit}>
                  <PencilIcon />
                  Edit
                </DropdownMenuItem>
                <DropdownMenuItem variant="destructive" onSelect={onDelete}>
                  <Trash2Icon />
                  Delete
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>

        <p className="mt-2 text-sm leading-relaxed">{signal.summary}</p>

        <div className="mt-3 flex flex-wrap items-center gap-1.5">
          <IntentBadge level={signal.intentLevel} />
          <UrgencyBadge level={signal.urgency} />
          {signal.serviceCategories.map((slug) => (
            <span key={slug} className="rounded-full border border-primary/15 bg-signal-tint px-2 py-0.5 text-xs text-[var(--signal-deep)]">
              {names.category(slug)}
            </span>
          ))}
        </div>

        {signal.evidence && (signal.evidence.excerpt || signal.evidence.sourceUrl) && (
          <figure className="mt-3 rounded-lg border-l-4 border-primary/40 bg-canvas px-4 py-3">
            {signal.evidence.excerpt && (
              <blockquote className="text-sm leading-relaxed text-foreground/85">“{signal.evidence.excerpt}”</blockquote>
            )}
            {signal.evidence.sourceUrl && (
              <figcaption className={cn(signal.evidence.excerpt && "mt-2")}>
                <a
                  href={signal.evidence.sourceUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex max-w-full items-center gap-1 text-xs font-medium text-primary hover:underline underline-offset-4"
                >
                  <span className="truncate">{new URL(signal.evidence.sourceUrl).hostname.replace(/^www\./, "")}</span>
                  <ExternalLinkIcon className="size-3 shrink-0" />
                </a>
              </figcaption>
            )}
          </figure>
        )}

        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-muted-foreground">
          <EvidenceTag label={signal.evidenceLabel} />
          {signal.source === "ai" ? (
            <span className="inline-flex items-center gap-1">
              <SparklesIcon className="size-3" />
              AI{signal.confidence !== null && `, ${signal.confidence}% confidence`}
            </span>
          ) : signal.source === "provider" ? (
            <span>Stated by the source</span>
          ) : (
            <span>Added manually</span>
          )}
          {signal.origin && (
            <span className="inline-flex items-center gap-1">
              <RadarIcon className="size-3" />
              Found on {SOURCE_LABELS[signal.origin]}
            </span>
          )}
          {personName && (
            <span className="inline-flex items-center gap-1">
              <UserRoundIcon className="size-3" />
              {personName}
            </span>
          )}
        </div>
      </div>
    </li>
  );
}

export function SignalTimelineSkeleton() {
  return (
    <div className="space-y-6 px-5 py-6" aria-label="Loading signals">
      {[0, 1].map((row) => (
        <div key={row} className="flex gap-4">
          <Skeleton className="size-[15px] rounded-full" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-4 w-48" />
            <Skeleton className="h-3 w-32" />
            <Skeleton className="h-4 w-full" />
            <div className="flex gap-1.5 pt-1">
              <Skeleton className="h-5 w-24 rounded-full" />
              <Skeleton className="h-5 w-24 rounded-full" />
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

export function EmptySignals({ canEdit, onRecord }: { canEdit: boolean; onRecord: () => void }) {
  return (
    <div className="flex flex-col items-center px-6 py-12 text-center">
      <span className="grid size-10 place-items-center rounded-full bg-signal-tint text-primary">
        <RadioTowerIcon className="size-5" />
      </span>
      <p className="mt-3 font-medium">No signals yet</p>
      <p className="mt-1 max-w-sm text-sm text-muted-foreground">
        Seen a job post, a request or some news about this company? Record it, and AI will work out what it means.
      </p>
      {canEdit && (
        <Button className="mt-4" onClick={onRecord}>
          <SparklesIcon />
          Record a signal
        </Button>
      )}
    </div>
  );
}

const ROLE_TAG: Record<SignalRole, { label: string; className: string }> = {
  primary: { label: "Lead signal", className: "border-primary/25 bg-signal-tint text-[var(--signal-deep)]" },
  corroborating: { label: "Supporting", className: "border-border bg-secondary text-muted-foreground" },
  negative: { label: "Lowers priority", className: "border-red-200 bg-red-50 text-red-700" },
};

function RoleTag({ role }: { role: SignalRole }) {
  const tag = ROLE_TAG[role];
  return <span className={cn("rounded-full border px-2 py-0.5 text-xs font-medium", tag.className)}>{tag.label}</span>;
}
