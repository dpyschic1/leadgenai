"use client";

import { useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { ArrowLeftIcon, Building2Icon, LightbulbIcon, LinkIcon, MailIcon, PhoneIcon, UserRoundIcon } from "lucide-react";
import { toast } from "sonner";
import { IdentityBadge, VerificationMark } from "@/components/companies/contact-status";
import { SaveToListMenu } from "@/components/lists/save-to-list-menu";
import { SignalTimeline } from "@/components/signals/signal-timeline";
import { UrgencyBadge } from "@/components/signals/signal-badges";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { useOpportunity, useUpdateOpportunity } from "@/hooks/use-opportunities";
import { usePermission } from "@/hooks/use-permission";
import { useLookupNames } from "@/hooks/use-reference-data";
import { ApiError } from "@/lib/api/client";
import type { OpportunityDetail } from "@/lib/api/types";
import { OPPORTUNITY_STATUSES, STATUS_LABELS, type OpportunityStatus } from "@/lib/domain/opportunities";
import { SENIORITY_LABELS } from "@/lib/domain/people";
import { EDITOR_ROLES } from "@/lib/permissions";
import { FeedbackPanel } from "./feedback-panel";
import { ScoreBreakdown } from "./score-breakdown";
import { ScoreRing } from "./score-ring";

export function OpportunityDetailView() {
  const { id } = useParams<{ id: string }>();
  const { data: opportunity, error } = useOpportunity(id);

  if (error instanceof ApiError && error.status === 404) return <OpportunityNotFound />;
  if (!opportunity) return <OpportunityDetailSkeleton />;
  return <OpportunityDetailContent opportunity={opportunity} />;
}

function Panel({ title, description, children }: { title: string; description?: string; children: React.ReactNode }) {
  return (
    <section className="rounded-xl border bg-card">
      <div className="border-b px-5 py-4">
        <h2 className="font-semibold">{title}</h2>
        {description && <p className="text-sm text-muted-foreground">{description}</p>}
      </div>
      {children}
    </section>
  );
}

function OpportunityDetailContent({ opportunity }: { opportunity: OpportunityDetail }) {
  const names = useLookupNames();
  const canEdit = usePermission(EDITOR_ROLES);
  const update = useUpdateOpportunity(opportunity.id);
  const roles = new Map(opportunity.signals.map((s) => [s.id, s.role]));

  const changeStatus = (status: OpportunityStatus) =>
    update.mutate(
      { status },
      {
        onSuccess: () => toast.success(`Marked as ${STATUS_LABELS[status].toLowerCase()}.`),
        onError: (e) => toast.error(e.message),
      },
    );

  return (
    <div className="space-y-6">
      <Link href="/opportunities" className="inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground">
        <ArrowLeftIcon className="size-4" />
        Opportunities
      </Link>

      <header className="flex flex-col gap-5 rounded-2xl border bg-card p-6 sm:flex-row sm:items-center">
        <ScoreRing score={opportunity.score} size="lg" />
        <div className="min-w-0 flex-1">
          <p className="text-sm text-muted-foreground">{names.opportunityType(opportunity.type)}</p>
          <h1 className="truncate text-2xl font-semibold">{opportunity.company.name}</h1>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-sm">
            {opportunity.service ? (
              <span className="rounded-full border border-primary/15 bg-signal-tint px-2.5 py-0.5 text-xs font-medium text-[var(--signal-deep)]">
                Matches {opportunity.service.name}
              </span>
            ) : (
              <span className="text-xs text-muted-foreground">No matching service</span>
            )}
            {opportunity.urgency !== "unknown" && <UrgencyBadge level={opportunity.urgency} />}
            <Link
              href={`/companies/${opportunity.company.id}`}
              className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline underline-offset-4"
            >
              <Building2Icon className="size-3.5" />
              View company
            </Link>
          </div>
        </div>
        <div className="flex flex-wrap items-end gap-2">
          {canEdit && <SaveToListMenu opportunity={opportunity} />}
          <div className="w-full sm:w-52">
            <label htmlFor="status" className="mb-1.5 block text-xs text-muted-foreground">
              Status
            </label>
            <Select value={opportunity.status} onValueChange={(value) => changeStatus(value as OpportunityStatus)} disabled={!canEdit || update.isPending}>
              <SelectTrigger id="status" className="h-10! w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {OPPORTUNITY_STATUSES.map((status) => (
                  <SelectItem key={status} value={status}>
                    {STATUS_LABELS[status]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
      </header>

      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="min-w-0 space-y-6">
          <Panel title="Why it's an opportunity">
            <div className="space-y-4 p-5">
              {opportunity.problem && <p className="leading-relaxed">{opportunity.problem}</p>}
              {opportunity.suggestedAction && (
                <div className="flex gap-3 rounded-lg border border-primary/20 bg-signal-tint/60 p-4">
                  <LightbulbIcon className="mt-0.5 size-4 shrink-0 text-primary" />
                  <div>
                    <p className="text-sm font-medium text-[var(--signal-deep)]">Suggested next step</p>
                    <p className="mt-0.5 text-sm text-[var(--signal-deep)]">{opportunity.suggestedAction}</p>
                  </div>
                </div>
              )}
            </div>
          </Panel>

          <Panel title="How the score is built" description="A priority for who to look at first, not a chance of winning.">
            <div className="p-5">
              {opportunity.factors && opportunity.score !== null ? (
                <ScoreBreakdown factors={opportunity.factors} total={opportunity.score} />
              ) : (
                <p className="text-sm text-muted-foreground">
                  Not scored: this company has no positive signal any more. Its history is kept because it&apos;s been worked on.
                </p>
              )}
            </div>
          </Panel>

          <Panel title="Evidence" description="The signals behind this opportunity, strongest first.">
            {opportunity.signals.length > 0 ? (
              <SignalTimeline signals={opportunity.signals} people={opportunity.contactDetails ? [opportunity.contactDetails] : []} canEdit={false} onEdit={() => {}} roles={roles} />
            ) : (
              <p className="p-5 text-sm text-muted-foreground">No signals linked.</p>
            )}
          </Panel>
        </div>

        <aside className="space-y-6">
          <ContactCard opportunity={opportunity} />
          <FeedbackPanel opportunity={opportunity} canEdit={canEdit} />
          <NotesCard key={opportunity.notes ?? ""} opportunity={opportunity} canEdit={canEdit} />
        </aside>
      </div>
    </div>
  );
}

function ContactLink({ href, label, icon: Icon, external }: { href: string; label: string; icon: typeof MailIcon; external?: boolean }) {
  return (
    <a
      href={href}
      {...(external && { target: "_blank", rel: "noopener noreferrer" })}
      className="flex min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors hover:bg-accent"
    >
      <Icon className="size-4 text-muted-foreground" />
      <span className="truncate">{label}</span>
    </a>
  );
}

function ContactCard({ opportunity }: { opportunity: OpportunityDetail }) {
  const person = opportunity.contactDetails;
  return (
    <section className="rounded-xl border bg-card p-5">
      <h2 className="font-semibold">Suggested contact</h2>
      {person ? (
        <div className="mt-4">
          <div className="flex items-center gap-3">
            <span className="grid size-10 place-items-center rounded-full bg-foreground text-background">
              <UserRoundIcon className="size-4" />
            </span>
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <p className="truncate font-medium">{person.name}</p>
                <IdentityBadge level={person.identity} confidence={person.identityConfidence} />
              </div>
              <p className="truncate text-sm text-muted-foreground">
                {[person.title, person.seniority !== "unknown" ? SENIORITY_LABELS[person.seniority] : null].filter(Boolean).join(", ") || "Title unknown"}
              </p>
            </div>
          </div>
          <div className="mt-3 space-y-0.5">
            {person.email && (
              <div className="flex items-center justify-between gap-2">
                <ContactLink href={`mailto:${person.email}`} label={person.email} icon={MailIcon} />
                {person.emailVerification && <VerificationMark kind="Email" check={person.emailVerification} inline />}
              </div>
            )}
            {person.phone && (
              <div className="flex items-center justify-between gap-2">
                <ContactLink href={`tel:${person.phone.replace(/[^\d+]/g, "")}`} label={person.phone} icon={PhoneIcon} />
                {person.phoneVerification && <VerificationMark kind="Phone" check={person.phoneVerification} inline />}
              </div>
            )}
            {person.professionalUrl && <ContactLink href={person.professionalUrl} label="Profile" icon={LinkIcon} external />}
          </div>
        </div>
      ) : (
        <p className="mt-2 text-sm text-muted-foreground">
          No one identified yet.{" "}
          <Link href={`/companies/${opportunity.company.id}`} className="font-medium text-primary hover:underline underline-offset-4">
            Add people at {opportunity.company.name}
          </Link>
        </p>
      )}
    </section>
  );
}

function NotesCard({ opportunity, canEdit }: { opportunity: OpportunityDetail; canEdit: boolean }) {
  const [notes, setNotes] = useState(opportunity.notes ?? "");
  const update = useUpdateOpportunity(opportunity.id);
  const dirty = notes.trim() !== (opportunity.notes ?? "");

  return (
    <section className="rounded-xl border bg-card p-5">
      <label htmlFor="notes" className="font-semibold">
        Notes
      </label>
      <Textarea
        id="notes"
        rows={5}
        value={notes}
        onChange={(event) => setNotes(event.target.value)}
        disabled={!canEdit}
        placeholder="Call outcomes, objections, next steps…"
        className="mt-3"
      />
      {canEdit && (
        <div className="mt-3 flex justify-end">
          <Button
            size="sm"
            disabled={!dirty || update.isPending}
            onClick={() =>
              update.mutate(
                { notes },
                { onSuccess: () => toast.success("Notes saved."), onError: (e) => toast.error(e.message) },
              )
            }
          >
            Save notes
          </Button>
        </div>
      )}
    </section>
  );
}

function OpportunityNotFound() {
  return (
    <div className="flex flex-col items-center rounded-xl border border-dashed bg-card px-6 py-16 text-center">
      <h1 className="font-semibold">Opportunity not found</h1>
      <p className="mt-1.5 text-sm text-muted-foreground">
        It may have been removed because its company no longer has a buying signal.
      </p>
      <Button asChild variant="outline" className="mt-5">
        <Link href="/opportunities">
          <ArrowLeftIcon />
          Back to opportunities
        </Link>
      </Button>
    </div>
  );
}

export function OpportunityDetailSkeleton() {
  return (
    <div className="space-y-6" aria-label="Loading opportunity">
      <Skeleton className="h-5 w-32" />
      <div className="flex items-center gap-5 rounded-2xl border bg-card p-6">
        <Skeleton className="size-24 rounded-full" />
        <div className="flex-1 space-y-2">
          <Skeleton className="h-4 w-28" />
          <Skeleton className="h-7 w-64" />
          <Skeleton className="h-5 w-48" />
        </div>
      </div>
      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="space-y-6">
          <Skeleton className="h-40 w-full rounded-xl" />
          <Skeleton className="h-80 w-full rounded-xl" />
        </div>
        <Skeleton className="h-48 w-full rounded-xl" />
      </div>
    </div>
  );
}
