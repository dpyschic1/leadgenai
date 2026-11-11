"use client";

import { useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { ArrowLeftIcon, GlobeIcon, LightbulbIcon, LinkIcon, MailIcon, PhoneIcon, UserRoundIcon } from "lucide-react";
import { toast } from "sonner";
import { IdentityBadge, OsmCredit, OvertureCredit, VerificationMark } from "@/components/companies/contact-status";
import { SaveToListMenu } from "@/components/lists/save-to-list-menu";
import { SignalTimeline } from "@/components/signals/signal-timeline";
import { UrgencyBadge } from "@/components/signals/signal-badges";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { useOpportunity, useUpdateOpportunity } from "@/hooks/use-opportunities";
import { usePipeline } from "@/hooks/use-pipeline";
import { usePermission } from "@/hooks/use-permission";
import { useLookupNames } from "@/hooks/use-reference-data";
import { ApiError } from "@/lib/api/client";
import type { CompanyContact, CompanyPerson, OpportunityDetail } from "@/lib/api/types";
import { SENIORITY_LABELS } from "@/lib/domain/people";
import { SOURCE_LABELS } from "@/lib/domain/sources";
import { EDITOR_ROLES } from "@/lib/permissions";
import { opportunityName } from "@/lib/opportunity-display";
import { cn } from "@/lib/utils";
import { EngineEvidencePanel, EngineScoreBreakdown } from "./engine-parts";
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
    <div className="space-y-6">
      <Link href="/opportunities" className="inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground">
        <ArrowLeftIcon className="size-4" />
        Opportunities
      </Link>

      <header className="flex flex-col gap-5 rounded-2xl border bg-card p-6 sm:flex-row sm:items-center">
        <ScoreRing score={opportunity.score} size="lg" />
        <div className="min-w-0 flex-1">
          <p className="text-sm text-muted-foreground">
            {names.opportunityType(opportunity.type)}
          </p>
          <h1 className="truncate text-2xl font-semibold">{opportunityName(opportunity)}</h1>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-sm">
            {opportunity.service ? (
              <span className="rounded-full border border-primary/15 bg-signal-tint px-2.5 py-0.5 text-xs font-medium text-[var(--signal-deep)]">
                Matches {opportunity.service.name}
              </span>
            ) : (
              <span className="text-xs text-muted-foreground">No matching service</span>
            )}
            {opportunity.urgency !== "unknown" && <UrgencyBadge level={opportunity.urgency} />}
          </div>
        </div>
        <div className="flex flex-wrap items-end gap-2">
          {canEdit && <SaveToListMenu opportunity={opportunity} />}
          <div className="w-full sm:w-52">
            <label htmlFor="stage" className="mb-1.5 block text-xs text-muted-foreground">
              Stage {opportunity.archived && "(archived)"}
            </label>
            <Select value={opportunity.stage.id} onValueChange={moveTo} disabled={!canEdit || update.isPending}>
              <SelectTrigger id="stage" className="h-10! w-full">
                <SelectValue>{opportunity.stage.name}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {(stages ?? [{ id: opportunity.stage.id, name: opportunity.stage.name }]).map((stage) => (
                  <SelectItem key={stage.id} value={stage.id}>
                    {stage.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {canEdit && (
            <Button variant="outline" className="h-10" disabled={update.isPending} onClick={() => setArchived(!opportunity.archived)}>
              {opportunity.archived ? "Restore" : "Archive"}
            </Button>
          )}
        </div>
      </header>

      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="min-w-0 space-y-6">
          <Panel title="Why it's an opportunity">
            <div className="space-y-4 p-5">
              {/* One sentence from the lead signal, for every opportunity; the full post is under Evidence. */}
              {opportunity.problem && <p className="line-clamp-3 leading-relaxed">{opportunity.problem}</p>}
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
              {opportunity.engineFactors && opportunity.score !== null ? (
                <EngineScoreBreakdown factors={opportunity.engineFactors} total={opportunity.score} />
              ) : opportunity.factors && opportunity.score !== null ? (
                <ScoreBreakdown factors={opportunity.factors} total={opportunity.score} />
              ) : (
                <p className="text-sm text-muted-foreground">
                  Not scored: this company has no positive signal any more. Its history is kept because it&apos;s been worked on.
                </p>
              )}
            </div>
          </Panel>

          <Panel
            title="Evidence"
            description={opportunity.engine ? "Where this came from, and how well it is confirmed." : "The signals behind this opportunity, strongest first."}
          >
            {opportunity.engine ? (
              <EngineEvidencePanel opportunity={opportunity} />
            ) : opportunity.signals.length > 0 ? (
              <SignalTimeline signals={opportunity.signals} people={opportunity.contactDetails ? [opportunity.contactDetails] : []} canEdit={false} onEdit={() => {}} roles={roles} />
            ) : (
              <p className="p-5 text-sm text-muted-foreground">No signals linked.</p>
            )}
          </Panel>
        </div>

        <aside className="space-y-6">
          {opportunity.company ? <ContactCard opportunity={opportunity} /> : <DiscoveredContactCard opportunity={opportunity} />}
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
  const company = opportunity.company;
  const others = opportunity.otherPeople;
  return (
    <section className="rounded-xl border bg-card p-5">
      <h2 className="font-semibold">Suggested contact</h2>
      {person ? (
        <PersonContact person={person} className="mt-4" />
      ) : (
        <p className="mt-2 text-sm text-muted-foreground">
          {others.length > 0 || opportunity.companyContacts.length > 0
            ? "No one suggested yet: see the people and contacts below."
            : "No one identified yet. Contacts are looked up automatically and appear here when found."}
        </p>
      )}
      {others.length > 0 && (
        <div className="mt-4 border-t pt-4">
          <h3 className="text-sm font-medium">{person ? "Other people" : "People"}{company ? ` at ${company.name}` : ""}</h3>
          <ul className="mt-3 space-y-4">
            {others.map((other) => (
              <li key={other.id}>
                <PersonContact person={other} compact />
              </li>
            ))}
          </ul>
        </div>
      )}
      {opportunity.companyContacts.length > 0 && <CompanyContacts contacts={opportunity.companyContacts} />}
      {company?.domain && (
        <div className="mt-4 border-t pt-3">
          <p className="mb-1 text-xs text-muted-foreground">Website</p>
          <ContactLink href={`https://${company.domain}`} label={company.domain} icon={GlobeIcon} external />
        </div>
      )}
      {opportunity.type === "rfp" && <TenderNote tender={opportunity.tender} />}
    </section>
  );
}

/**
 * The "Suggested contact" card for a discovered opportunity (no company record): the buyer the
 * source names, with their profile or website, and the people a filing names. Same card, same layout
 * as a company opportunity's; nothing is guessed when the source names no one.
 */
function DiscoveredContactCard({ opportunity }: { opportunity: OpportunityDetail }) {
  const engine = opportunity.engine;
  const named = opportunity.engineEvidence.flatMap((e) => ((e.metadata as { people?: { name: string; roles: string[] }[] }).people ?? []));
  const funded = engine?.category === "funded_company";
  return (
    <section className="rounded-xl border bg-card p-5">
      <h2 className="font-semibold">Suggested contact</h2>
      {engine?.buyerName ? (
        <div className="mt-4">
          <div className="flex items-center gap-3">
            <span className="grid size-10 shrink-0 place-items-center rounded-full bg-foreground text-background">
              <UserRoundIcon className="size-4" />
            </span>
            <div className="min-w-0">
              <p className="truncate font-medium">{engine.buyerName}</p>
              <p className="truncate text-sm text-muted-foreground">{funded ? "The company" : "Posted this request"}</p>
            </div>
          </div>
          {engine.buyerProfileUrl && (
            <div className="mt-2 space-y-0.5">
              <ContactLink
                href={engine.buyerProfileUrl}
                label={engine.buyerProfileUrl.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "")}
                icon={funded ? GlobeIcon : LinkIcon}
                external
              />
            </div>
          )}
        </div>
      ) : (
        <p className="mt-2 text-sm text-muted-foreground">No one identified yet. The source doesn&apos;t say who posted this, and we don&apos;t guess.</p>
      )}
      {named.length > 0 && (
        <div className="mt-4 border-t pt-4">
          <h3 className="text-sm font-medium">Named in the filing</h3>
          <ul className="mt-3 space-y-3">
            {named.slice(0, 6).map((p) => (
              <li key={p.name} className="flex items-center gap-3">
                <span className="grid size-8 shrink-0 place-items-center rounded-full bg-muted text-muted-foreground">
                  <UserRoundIcon className="size-3.5" />
                </span>
                <div className="min-w-0">
                  <p className="truncate font-medium">{p.name}</p>
                  <p className="truncate text-sm text-muted-foreground">{p.roles.join(", ") || "Title unknown"}</p>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
      {engine && engine.investors.length > 0 && (
        <div className="mt-4 border-t pt-3">
          <p className="mb-1 text-xs text-muted-foreground">Investors</p>
          <p className="text-sm">{engine.investors.join(", ")}</p>
        </div>
      )}
    </section>
  );
}

/**
 * Procurement rules: while a tender is open, the buyer's contact is for questions only, and
 * canvassing them can disqualify a bid. The bid itself goes through the notice's portal.
 */
function TenderNote({ tender }: { tender: OpportunityDetail["tender"] }) {
  const closes = tender?.closesAt ? new Date(tender.closesAt) : null;
  const closesText =
    closes && !Number.isNaN(closes.getTime())
      ? closes.toLocaleString("en-GB", { day: "numeric", month: "long", year: "numeric", hour: "numeric", minute: "2-digit", timeZone: "Europe/London" })
      : null;
  if (tender?.closed && closesText) {
    return (
      <div className="mt-4 rounded-lg border p-3 text-sm">
        <p className="font-medium">Public tender: closed on {closesText}</p>
        <p className="mt-1 text-muted-foreground">Bids are no longer accepted. The contact is still useful for the buyer&apos;s future work.</p>
      </div>
    );
  }
  return (
    <div className="mt-4 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm">
      <p className="font-medium">Public tender: contact for questions only</p>
      <p className="mt-1 text-muted-foreground">
        Submit your bid through the{" "}
        {tender?.url ? (
          <a href={tender.url} target="_blank" rel="noopener noreferrer" className="font-medium text-primary hover:underline underline-offset-4">
            tender notice
          </a>
        ) : (
          "tender notice"
        )}
        {closesText ? ` by ${closesText}` : " before it closes"}. Don&apos;t pitch the buyer while it&apos;s open: canvassing can disqualify a bid.
      </p>
    </div>
  );
}

/** One person: name, title, how sure we are it's them, and their email, phone and profile. */
function PersonContact({ person, compact = false, className }: { person: CompanyPerson; compact?: boolean; className?: string }) {
  const role = [person.title, person.seniority !== "unknown" ? SENIORITY_LABELS[person.seniority] : null].filter(Boolean).join(", ") || "Title unknown";
  return (
    <div className={className}>
      <div className="flex items-center gap-3">
        <span className={cn("grid shrink-0 place-items-center rounded-full", compact ? "size-8 bg-muted text-muted-foreground" : "size-10 bg-foreground text-background")}>
          <UserRoundIcon className={compact ? "size-3.5" : "size-4"} />
        </span>
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <p className="truncate font-medium">{person.name}</p>
            <IdentityBadge level={person.identity} confidence={person.identityConfidence} />
          </div>
          <p className="truncate text-sm text-muted-foreground">{role}</p>
        </div>
      </div>
      {(person.email || person.phone || person.professionalUrl) && (
        <div className="mt-2 space-y-0.5">
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
      )}
    </div>
  );
}

/** The company's published lines (switchboard, info@, each practice's phone), with where each came from. */
function CompanyContacts({ contacts }: { contacts: CompanyContact[] }) {
  return (
    <div className="mt-4 border-t pt-4">
      <h3 className="text-sm font-medium">Company contact</h3>
      <ul className="mt-2 space-y-0.5">
        {contacts.map((contact) => {
          const shown = contact.type === "website" ? contact.value.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "") : contact.value;
          return (
            <li key={`${contact.type}:${contact.value}`}>
              <ContactLink
                href={contact.type === "email" ? `mailto:${contact.value}` : contact.type === "website" ? contact.value : `tel:${contact.value.replace(/[^\d+]/g, "")}`}
                label={contact.label ? `${shown} · ${contact.label}` : shown}
                icon={contact.type === "email" ? MailIcon : contact.type === "website" ? LinkIcon : PhoneIcon}
                external={contact.type === "website"}
              />
              {contact.source === "openstreetmap" ? (
                <p className="pl-8 text-xs text-muted-foreground">Published on OpenStreetMap, not verified by us</p>
              ) : (
                contact.source && <p className="pl-8 text-xs text-muted-foreground">Published, from {SOURCE_LABELS[contact.source]}</p>
              )}
            </li>
          );
        })}
      </ul>
      {contacts.some((c) => c.source === "openstreetmap") && <OsmCredit className="mt-2 pl-2" />}
      {contacts.some((c) => c.source === "overture") && <OvertureCredit className="mt-2 pl-2" />}
    </div>
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
