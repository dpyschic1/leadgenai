"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import {
  ArrowLeftIcon,
  ArrowUpRightIcon,
  BotIcon,
  CircleCheckIcon,
  GaugeIcon,
  GlobeIcon,
  MailIcon,
  PhoneIcon,
  QuoteIcon,
  RadioTowerIcon,
  UserRoundIcon,
  UsersRoundIcon,
} from "lucide-react";
import { toast } from "sonner";
import { CompanyAvatar } from "@/components/companies/company-avatar";
import { SaveToListMenu } from "@/components/lists/save-to-list-menu";
import { EngineEvidencePanel, EngineScoreBreakdown } from "@/components/opportunities/engine-parts";
import { ContactCard, DiscoveredContactCard, NotesCard, Panel, RoleBreakdown } from "@/components/opportunities/opportunity-detail-view";
import { KindLabel } from "@/components/opportunities/opportunity-card";
import { ScoreBreakdown } from "@/components/opportunities/score-breakdown";
import { ScoreRing, scoreTone } from "@/components/opportunities/score-ring";
import { LeadBadge, StatusBadge } from "@/components/opportunities/status-badge";
import { WEIGHT_TONES } from "@/components/scoring/score-weights-editor";
import { SignalTimeline } from "@/components/signals/signal-timeline";
import { UrgencyBadge } from "@/components/signals/signal-badges";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { useOpportunity, useUpdateOpportunity } from "@/hooks/use-opportunities";
import { usePermission } from "@/hooks/use-permission";
import { usePipeline } from "@/hooks/use-pipeline";
import { ApiError } from "@/lib/api/client";
import type { OpportunityDetail } from "@/lib/api/types";
import { QUALIFICATION_LABELS, QUALIFICATIONS, type Qualification } from "@/lib/domain/opportunities";
import { EDITOR_ROLES } from "@/lib/permissions";
import { opportunityName } from "@/lib/opportunity-display";
import { cn } from "@/lib/utils";
import { SCORE_FACTORS } from "@/lib/validation/scoring";

/**
 * A lead's own page, built for the person about to reach out: who they are and how to reach them
 * up top, the AI's verdict and the scorecard (why it ranked where it did) in the middle, the
 * evidence below, and the pipeline, contacts and notes alongside.
 */
export function LeadDetailView() {
  const { id } = useParams<{ id: string }>();
  const { data: lead, error } = useOpportunity(id);

  if (error instanceof ApiError && error.status === 404) return <LeadNotFound />;
  if (!lead) return <LeadDetailSkeleton />;
  return <LeadDetailContent lead={lead} />;
}

function LeadDetailContent({ lead }: { lead: OpportunityDetail }) {
  const canEdit = usePermission(EDITOR_ROLES);
  const name = opportunityName(lead);
  const headline = lead.lead.reason ?? lead.problem ?? lead.engine?.title ?? null;
  const roles = new Map(lead.signals.map((s) => [s.id, s.role]));

  return (
    <div className="space-y-6">
      <Link href="/leads" className="inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground">
        <ArrowLeftIcon className="size-4" />
        Leads
      </Link>

      <header className="overflow-hidden rounded-2xl border bg-card">
        {/* The lead's temperature as a band across the top: solid for hot, light for warm. */}
        <div
          aria-hidden="true"
          className={cn("h-1.5", lead.lead.status === "hot" ? "bg-primary" : lead.lead.status === "warm" ? "bg-primary/40" : "bg-border")}
        />
        <div className="flex flex-col gap-6 p-6 md:flex-row md:items-start">
          <CompanyAvatar name={name} className="size-16 rounded-2xl text-lg" />
          <div className="min-w-0 flex-1">
            <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Lead</p>
            <h1 className="mt-0.5 truncate text-3xl leading-tight font-semibold tracking-tight">{name}</h1>
            {headline && <p className="mt-2 line-clamp-2 max-w-[70ch] text-base leading-relaxed text-pretty text-foreground/80">{headline}</p>}
            <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2">
              <LeadBadge lead={lead.lead} showScore={false} className="text-sm" />
              <StatusBadge stage={lead.stage} archived={lead.archived} />
              <KindLabel opportunity={lead} />
              {lead.service && (
                <span className="inline-flex items-center gap-1 rounded-full border border-primary/25 bg-signal-tint px-2.5 py-0.5 text-xs font-medium text-[var(--signal-deep)]">
                  <CircleCheckIcon className="size-3.5 text-primary" />
                  {lead.service.name}
                </span>
              )}
              {lead.urgency !== "unknown" && <UrgencyBadge level={lead.urgency} />}
            </div>
          </div>
          <ScoreSummary lead={lead} />
        </div>
        <ReachOutBar lead={lead} />
      </header>

      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="min-w-0 space-y-6">
          <VerdictPanel lead={lead} canEdit={canEdit} />
          <ScorecardPanel lead={lead} />
          <Panel title="Evidence" description={lead.engine ? "Where this came from, and how well it is confirmed." : "The signals behind this lead, strongest first."}>
            {lead.engine ? (
              <EngineEvidencePanel opportunity={lead} />
            ) : lead.signals.length > 0 ? (
              <SignalTimeline signals={lead.signals} people={lead.contactDetails ? [lead.contactDetails] : []} canEdit={false} onEdit={() => {}} roles={roles} />
            ) : (
              <p className="p-5 text-sm text-muted-foreground">No signals linked.</p>
            )}
          </Panel>
        </div>

        <aside className="space-y-6">
          <PipelineCard lead={lead} canEdit={canEdit} />
          {lead.company ? <ContactCard opportunity={lead} /> : <DiscoveredContactCard opportunity={lead} />}
          <NotesCard key={lead.notes ?? ""} opportunity={lead} canEdit={canEdit} />
        </aside>
      </div>
    </div>
  );
}

/** The two numbers that matter, side by side: the AI's fit and the rules' priority. */
function ScoreSummary({ lead }: { lead: OpportunityDetail }) {
  return (
    <div className="flex shrink-0 items-center gap-5 rounded-xl border bg-canvas px-5 py-4">
      <div className="flex flex-col items-center gap-1.5">
        <ScoreRing score={lead.lead.score} size="lg" />
        <span className="text-xs font-medium text-muted-foreground">AI fit</span>
      </div>
      <div className="h-20 w-px bg-border" aria-hidden="true" />
      <div className="flex flex-col items-center gap-1.5">
        <ScoreRing score={lead.score} size="lg" />
        <span className="text-xs font-medium text-muted-foreground">Priority</span>
      </div>
    </div>
  );
}

/** One row of quick actions: who to talk to, and buttons to write, call, or open their site and the source. */
function ReachOutBar({ lead }: { lead: OpportunityDetail }) {
  const person = lead.contact;
  const email = person?.email ?? lead.companyContact.email;
  const phone = person?.phone ?? lead.companyContact.phone;
  const domain = lead.company?.domain ?? null;
  const source = lead.evidence?.url ?? lead.engine?.sourceUrl ?? null;

  return (
    <div className="flex flex-col gap-3 border-t bg-canvas/60 px-6 py-4 sm:flex-row sm:items-center">
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <span className="grid size-9 shrink-0 place-items-center rounded-full bg-foreground text-background">
          {person ? <UserRoundIcon className="size-4" /> : <UsersRoundIcon className="size-4" />}
        </span>
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">{person ? person.name : email || phone ? "Company line" : "No contact yet"}</p>
          <p className="truncate text-xs text-muted-foreground">
            {person ? (person.title ?? "Title unknown") : email || phone ? "No named person yet: reach the company directly" : "Contacts appear here as soon as they're found"}
          </p>
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        {email && (
          <Button asChild size="sm" className="h-9">
            <a href={`mailto:${email}`} title={email}>
              <MailIcon />
              Email
            </a>
          </Button>
        )}
        {phone && (
          <Button asChild size="sm" variant={email ? "outline" : "default"} className="h-9 bg-card">
            <a href={`tel:${phone.replace(/[^\d+]/g, "")}`} title={phone}>
              <PhoneIcon />
              Call
            </a>
          </Button>
        )}
        {domain && (
          <Button asChild size="sm" variant="outline" className="h-9 bg-card">
            <a href={`https://${domain}`} target="_blank" rel="noopener noreferrer">
              <GlobeIcon />
              Website
            </a>
          </Button>
        )}
        {source && (
          <Button asChild size="sm" variant="outline" className="h-9 bg-card">
            <a href={source} target="_blank" rel="noopener noreferrer">
              <RadioTowerIcon />
              Source
            </a>
          </Button>
        )}
      </div>
    </div>
  );
}

/** The AI's read of the evidence, the roles it can fill, and the team's own call on top. */
function VerdictPanel({ lead, canEdit }: { lead: OpportunityDetail; canEdit: boolean }) {
  const update = useUpdateOpportunity(lead.id);
  const verdict = lead.lead;
  const decide = (qualification: Qualification | null) =>
    update.mutate(
      { qualification },
      {
        onSuccess: () => toast.success(qualification === null ? "Handed back to the AI to check." : `Marked ${QUALIFICATION_LABELS[qualification].toLowerCase()}.`),
        onError: (e) => toast.error(e.message),
      },
    );

  return (
    <section className="rounded-xl border bg-card">
      <div className="flex items-start justify-between gap-3 border-b px-5 py-4">
        <div className="flex items-start gap-3">
          <span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-lg bg-signal-tint text-[var(--signal-deep)]">
            <BotIcon className="size-4" />
          </span>
          <div>
            <h2 className="text-[17px] font-semibold tracking-tight">AI verdict</h2>
            <p className="mt-0.5 text-[13px] text-muted-foreground">
              {verdict.by === "team" ? "Your team made this call." : "What the AI read in the evidence, and why it's worth reaching out."}
            </p>
          </div>
        </div>
        <LeadBadge lead={verdict} showScore={false} />
      </div>
      <div className="space-y-5 p-5">
        {(verdict.summary ?? verdict.reason) && <p className="max-w-[75ch] text-[15px] leading-relaxed text-pretty">{verdict.summary ?? verdict.reason}</p>}
        {verdict.quote && (
          <figure className="flex gap-3 rounded-lg bg-canvas p-4">
            <QuoteIcon className="size-4 shrink-0 text-primary" />
            <blockquote className="text-sm leading-relaxed italic text-foreground/80">{verdict.quote}</blockquote>
          </figure>
        )}
        {(verdict.budget || verdict.timeline) && (
          <dl className="grid gap-3 sm:grid-cols-2">
            {verdict.budget && <Fact label="Budget" value={verdict.budget} />}
            {verdict.timeline && <Fact label="Timeline" value={verdict.timeline} />}
          </dl>
        )}
        {verdict.roles.length > 0 ? (
          <RoleBreakdown roles={verdict.roles} jobLinks={lead.jobLinks} />
        ) : (
          verdict.fittingRoles.length > 0 && (
            <p className="text-sm">
              <span className="font-medium">Roles you can fill: </span>
              <span className="text-muted-foreground">{verdict.fittingRoles.join(", ")}</span>
            </p>
          )
        )}
        {lead.suggestedAction && (
          <div className="rounded-lg border border-primary/20 bg-signal-tint/60 p-4">
            <p className="text-sm font-medium text-[var(--signal-deep)]">Suggested next step</p>
            <p className="mt-0.5 text-sm text-[var(--signal-deep)]">{lead.suggestedAction}</p>
          </div>
        )}
        {canEdit && (
          <div className="flex flex-wrap items-center gap-2 border-t pt-4">
            <span className="mr-1 text-xs text-muted-foreground">Your call:</span>
            {QUALIFICATIONS.map((q) => (
              <Button
                key={q}
                size="sm"
                variant={verdict.status === q && verdict.by === "team" ? "default" : "outline"}
                disabled={update.isPending}
                onClick={() => decide(q)}
              >
                {q === "not_fit" ? "Not a lead" : `Mark ${QUALIFICATION_LABELS[q].toLowerCase()}`}
              </Button>
            ))}
            {verdict.by === "team" && (
              <Button size="sm" variant="ghost" disabled={update.isPending} onClick={() => decide(null)}>
                Let the AI decide
              </Button>
            )}
          </div>
        )}
      </div>
    </section>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border px-4 py-3">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 text-sm font-medium">{value}</dd>
    </div>
  );
}

/**
 * The rules score behind the lead: one tile per factor at a glance (intent, ICP fit, recency,
 * identity, service fit), then each factor's reasons. It decided what the AI read first.
 */
function ScorecardPanel({ lead }: { lead: OpportunityDetail }) {
  const tiles = lead.factors
    ? SCORE_FACTORS.map(({ key, label }) => ({ key, label, score: lead.factors![key].score, weight: lead.factors![key].weight, tone: WEIGHT_TONES[key] }))
    : (lead.engineFactors ?? []).map((f) => ({ key: f.key, label: f.label, score: f.score, weight: f.weight, tone: "var(--signal)" }));

  return (
    <section className="rounded-xl border bg-card">
      <div className="flex items-start justify-between gap-3 border-b px-5 py-4">
        <div className="flex items-start gap-3">
          <span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-lg bg-signal-tint text-[var(--signal-deep)]">
            <GaugeIcon className="size-4" />
          </span>
          <div>
            <h2 className="text-[17px] font-semibold tracking-tight">Lead scorecard</h2>
            <p className="mt-0.5 text-[13px] text-muted-foreground">A rules check of fit and timing. It decided what the AI read first.</p>
          </div>
        </div>
        {lead.score !== null && (
          <p className="shrink-0 text-right">
            <span className={cn("text-2xl font-semibold tabular-nums", scoreTone(lead.score).text)}>{lead.score}</span>
            <span className="text-sm text-muted-foreground">/100</span>
          </p>
        )}
      </div>
      {lead.score === null || tiles.length === 0 ? (
        <p className="p-5 text-sm text-muted-foreground">Not scored: this company has no positive signal any more. Its history is kept because it&apos;s been worked on.</p>
      ) : (
        <div className="space-y-5 p-5">
          <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-5">
            {tiles.map((tile) => (
              <li key={tile.key} className="rounded-lg border bg-canvas/60 p-3">
                <p className="flex items-center gap-1.5 truncate text-xs text-muted-foreground">
                  <span className="size-2 shrink-0 rounded-sm" style={{ background: tile.tone }} aria-hidden="true" />
                  {tile.label}
                </p>
                <p className="mt-1.5 text-xl font-semibold tabular-nums">{tile.score}</p>
                <div className="mt-2 h-1 overflow-hidden rounded-full bg-muted">
                  <div className="h-full rounded-full" style={{ width: `${tile.score}%`, background: tile.tone }} />
                </div>
                <p className="mt-1.5 text-[11px] text-muted-foreground">Weight {tile.weight}%</p>
              </li>
            ))}
          </ul>
          {lead.factors ? (
            <ScoreBreakdown factors={lead.factors} total={lead.score} />
          ) : (
            lead.engineFactors && <EngineScoreBreakdown factors={lead.engineFactors} total={lead.score} />
          )}
        </div>
      )}
    </section>
  );
}

/** Where the lead is in the pipeline, with the actions on it and a link to its full opportunity. */
function PipelineCard({ lead, canEdit }: { lead: OpportunityDetail; canEdit: boolean }) {
  const update = useUpdateOpportunity(lead.id);
  const { data: stages } = usePipeline();
  const moveTo = (stageId: string) =>
    update.mutate(
      { stageId },
      {
        onSuccess: () => toast.success(`Moved to ${stages?.find((s) => s.id === stageId)?.name ?? "the new stage"}.`),
        onError: (e) => toast.error(e.message),
      },
    );
  const setArchived = (archived: boolean) =>
    update.mutate({ archived }, { onSuccess: () => toast.success(archived ? "Archived." : "Restored."), onError: (e) => toast.error(e.message) });

  return (
    <section className="space-y-3 rounded-xl border bg-card p-4">
      <h2 className="text-[15px] font-semibold tracking-tight">Pipeline</h2>
      <div>
        <label htmlFor="lead-stage" className="mb-1.5 block text-xs text-muted-foreground">
          Stage {lead.archived && "(archived)"}
        </label>
        <Select value={lead.stage.id} onValueChange={moveTo} disabled={!canEdit || update.isPending}>
          <SelectTrigger id="lead-stage" className="h-10! w-full">
            <SelectValue>{lead.stage.name}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {(stages ?? [{ id: lead.stage.id, name: lead.stage.name }]).map((stage) => (
              <SelectItem key={stage.id} value={stage.id}>
                {stage.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {canEdit && (
        <div className="flex flex-wrap gap-2">
          <SaveToListMenu opportunity={lead} />
          <Button variant="outline" disabled={update.isPending} onClick={() => setArchived(!lead.archived)}>
            {lead.archived ? "Restore" : "Archive"}
          </Button>
        </div>
      )}
      <Link
        href={`/opportunities/${lead.id}`}
        className="flex items-center justify-between border-t pt-3 text-[13px] text-muted-foreground transition-colors hover:text-foreground"
      >
        View as opportunity
        <ArrowUpRightIcon className="size-3.5" />
      </Link>
    </section>
  );
}

function LeadNotFound() {
  return (
    <div className="flex flex-col items-center rounded-xl border border-dashed bg-card px-6 py-16 text-center">
      <h1 className="font-semibold">Lead not found</h1>
      <p className="mt-1.5 text-sm text-muted-foreground">It may have been removed because its company no longer has a buying signal.</p>
      <Button asChild variant="outline" className="mt-5">
        <Link href="/leads">
          <ArrowLeftIcon />
          Back to leads
        </Link>
      </Button>
    </div>
  );
}

export function LeadDetailSkeleton() {
  return (
    <div className="space-y-6" aria-label="Loading lead">
      <Skeleton className="h-5 w-24" />
      <div className="rounded-2xl border bg-card p-6">
        <div className="flex items-center gap-6">
          <Skeleton className="size-16 rounded-2xl" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-3 w-12" />
            <Skeleton className="h-7 w-64" />
            <Skeleton className="h-5 w-96 max-w-full" />
          </div>
          <Skeleton className="hidden h-28 w-60 rounded-xl md:block" />
        </div>
      </div>
      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="space-y-6">
          <Skeleton className="h-56 w-full rounded-xl" />
          <Skeleton className="h-80 w-full rounded-xl" />
        </div>
        <Skeleton className="h-48 w-full rounded-xl" />
      </div>
    </div>
  );
}
