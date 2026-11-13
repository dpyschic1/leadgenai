"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import {
  CheckIcon,
  CopyIcon,
  ContactRoundIcon,
  GlobeIcon,
  ListChecksIcon,
  MailIcon,
  PhoneIcon,
  RadioTowerIcon,
  SearchIcon,
  SendIcon,
  TableIcon,
  XIcon,
} from "lucide-react";
import { toast } from "sonner";
import { CompanyAvatar } from "@/components/companies/company-avatar";
import { PageHeader } from "@/components/layout/page-header";
import { Pagination, usePage } from "@/components/layout/pagination";
import { TickBox } from "@/components/opportunities/opportunity-card";
import { ScoreRing } from "@/components/opportunities/score-ring";
import { StatusBadge } from "@/components/opportunities/status-badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { useLists } from "@/hooks/use-lists";
import { useBulkOpportunities, useLeads } from "@/hooks/use-opportunities";
import { usePermission } from "@/hooks/use-permission";
import { usePipeline } from "@/hooks/use-pipeline";
import { opportunitiesApi, type LeadFilter } from "@/lib/api/opportunities";
import type { LeadContacts, LeadSummary } from "@/lib/api/types";
import { OSM_COPYRIGHT_URL } from "@/lib/domain/sources";
import { ROLE_FAMILIES, ROLE_FAMILY_LABELS, type LeadTab, type RoleFamily } from "@/lib/domain/opportunities";
import { EDITOR_ROLES } from "@/lib/permissions";
import { cn } from "@/lib/utils";
import { opportunityName } from "@/lib/opportunity-display";

const TABS: { tab: LeadTab; label: string; hint: string }[] = [
  { tab: "all", label: "All leads", hint: "Every lead still being worked: companies, buyers and projects, new or in progress." },
  { tab: "email", label: "Has email", hint: "Leads with an email to write to: the person's own, or the company's inbox." },
  { tab: "phone", label: "Has phone", hint: "Leads with a number to call: the person's own, or the company's line." },
  { tab: "person", label: "Named contact", hint: "A named person with their own phone or email: call or write to them directly." },
  { tab: "company", label: "Company line", hint: "No named person reachable yet, but the company's own phone or email works as a way in." },
  { tab: "none", label: "No contact yet", hint: "Nothing to call or write to yet. Open the lead to research it, or wait for its website to be read." },
];

const EMPTY: Record<LeadTab, string> = {
  all: "No active leads yet. Opportunities you're working appear here with their contacts.",
  email: "No lead has an email yet.",
  phone: "No lead has a phone number yet.",
  person: "No lead has a named contact with a phone or email yet.",
  company: "No lead is reachable only through its company line.",
  none: "Every lead has a way in.",
};

const COLUMNS = "grid-cols-[minmax(0,2.2fr)_minmax(0,1.3fr)_minmax(0,1.1fr)_minmax(0,1.5fr)_minmax(0,1.2fr)_7.5rem_3rem]";
const COLUMNS_SELECTING = "grid-cols-[minmax(0,2.2fr)_minmax(0,1.3fr)_minmax(0,1.1fr)_minmax(0,1.5fr)_minmax(0,1.2fr)_7.5rem_3rem_1.5rem]";

/** A selection belongs to one view: switching tab, role type or search starts a new one. */
type Selection = { view: string; ids: Set<string>; allMatching: boolean };

/**
 * The sales team's list: every active lead with who to talk to and how. Tabs by how it can be
 * reached, chips by the kind of role it is hiring for. Select leads (or everything in the view)
 * to copy their emails or phones, write to them all, or move them on together.
 */
export function LeadsView() {
  const [tab, setTab] = useState<LeadTab>("all");
  const [role, setRole] = useState<RoleFamily | null>(null);
  const [search, setSearch] = useState("");
  const q = useDebouncedValue(search.trim());
  const filter = useMemo<LeadFilter>(() => ({ tab, role, q }), [tab, role, q]);
  const view = JSON.stringify(filter);
  const [page, setPage] = usePage(view);
  const { data, isPending, isFetching } = useLeads(filter, page);
  const hint = TABS.find((t) => t.tab === tab)!.hint;
  const canEdit = usePermission(EDITOR_ROLES);

  const [selecting, setSelecting] = useState(false);
  const [stored, setSelection] = useState<Selection>({ view, ids: new Set(), allMatching: false });
  const selection = stored.view === view ? stored : { view, ids: new Set<string>(), allMatching: false };
  const items = data?.items ?? [];
  // Only rows on screen can be ticked one by one; "all in this view" covers the rest.
  const picked = selection.allMatching ? items : items.filter((lead) => selection.ids.has(lead.id));
  const allOnPage = items.length > 0 && picked.length === items.length;
  const toggle = (id: string) => {
    const ids = new Set(selection.allMatching ? items.map((lead) => lead.id) : selection.ids);
    if (ids.has(id)) ids.delete(id);
    else ids.add(id);
    setSelection({ view, ids, allMatching: false });
  };
  const toggleAll = () => setSelection({ view, ids: allOnPage ? new Set() : new Set(items.map((lead) => lead.id)), allMatching: false });
  const stopSelecting = () => {
    setSelecting(false);
    setSelection({ view, ids: new Set(), allMatching: false });
  };
  const columns = selecting ? COLUMNS_SELECTING : COLUMNS;

  const roleChips = ROLE_FAMILIES.filter((family) => family === role || (data?.roleCounts[family] ?? 0) > 0);

  return (
    <div className="space-y-6">
      <PageHeader title="Leads" description="Who to contact at every lead you're working, and how: named people first, then the company's own line." />

      <div className="space-y-3">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div role="tablist" aria-label="How the lead can be reached" className="flex max-w-full overflow-x-auto rounded-lg border bg-card p-1 lg:inline-flex lg:self-start">
            {TABS.map((item) => {
              const selected = item.tab === tab;
              return (
                <button
                  key={item.tab}
                  role="tab"
                  aria-selected={selected}
                  onClick={() => setTab(item.tab)}
                  className={cn(
                    "inline-flex shrink-0 items-center gap-2 rounded-md px-3 py-1.5 text-sm whitespace-nowrap transition-colors outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
                    selected ? "bg-signal-tint font-medium text-[var(--signal-deep)]" : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {item.label}
                  <span className={cn("rounded-full px-1.5 text-xs tabular-nums", selected ? "bg-background" : "bg-secondary")}>{data?.counts[item.tab] ?? "·"}</span>
                </button>
              );
            })}
          </div>
          <div className="flex gap-2">
            <div className="relative w-full lg:w-64">
              <SearchIcon className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                type="search"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search companies"
                aria-label="Search leads"
                className="h-9 bg-card pl-9"
              />
            </div>
            <Button
              variant="outline"
              aria-pressed={selecting}
              disabled={items.length === 0}
              onClick={() => (selecting ? stopSelecting() : setSelecting(true))}
              className={cn("h-9 shrink-0 bg-card", selecting && "border-primary/40 bg-signal-tint text-[var(--signal-deep)]")}
            >
              <ListChecksIcon />
              Select
            </Button>
          </div>
        </div>

        {/* The kind of role each lead is hiring for, read from its job titles. */}
        {roleChips.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Hiring for">
            {/* <span className="mr-1 text-xs font-medium text-muted-foreground">Hiring for</span> */}
            <RoleChip label="Any role" selected={role === null} onClick={() => setRole(null)} />
            {roleChips.map((family) => (
              <RoleChip
                key={family}
                label={ROLE_FAMILY_LABELS[family]}
                count={data?.roleCounts[family]}
                selected={role === family}
                onClick={() => setRole(role === family ? null : family)}
              />
            ))}
          </div>
        )}
        <p className="text-sm text-muted-foreground">{hint}</p>
      </div>

      {selecting && data && items.length > 0 && (
        <BulkBar
          filter={filter}
          picked={picked}
          allOnPage={allOnPage}
          allMatching={selection.allMatching}
          total={data.total}
          canEdit={canEdit}
          onToggleAll={toggleAll}
          onSelectAllMatching={() => setSelection({ view, ids: new Set(), allMatching: true })}
          onClear={() => setSelection({ view, ids: new Set(), allMatching: false })}
          onDone={stopSelecting}
        />
      )}

      <section className="overflow-hidden rounded-xl border bg-card">
        <div className="overflow-x-auto">
          <div className="min-w-[1080px]">
            <div className={cn("grid gap-4 border-b bg-canvas px-4 py-2.5 text-xs font-medium text-muted-foreground", columns)}>
              <span>Lead · hiring for</span>
              <span>Contact</span>
              <span>Phone</span>
              <span>Email</span>
              <span>Links</span>
              <span>Status</span>
              <span className="text-right">Score</span>
              {selecting && <span />}
            </div>
            {isPending && !data ? (
              <SkeletonRows />
            ) : data && items.length > 0 ? (
              <ul className={cn("divide-y transition-opacity", isFetching && "opacity-60")} aria-label="Leads">
                {items.map((lead) => (
                  <LeadRow
                    key={lead.id}
                    lead={lead}
                    columns={columns}
                    selection={selecting ? { selected: selection.allMatching || selection.ids.has(lead.id), onToggle: () => toggle(lead.id) } : undefined}
                  />
                ))}
              </ul>
            ) : (
              <p className="px-4 py-12 text-center text-sm text-muted-foreground">
                {q ? `No leads match “${q}”.` : role ? `No ${ROLE_FAMILY_LABELS[role]} leads here.` : EMPTY[tab]}
              </p>
            )}
          </div>
        </div>
        {data && <Pagination page={data.page} pageSize={data.pageSize} total={data.total} noun="leads" onChange={setPage} className="border-t px-4 py-3" />}
      </section>
    </div>
  );
}

function RoleChip({ label, count, selected, onClick }: { label: string; count?: number; selected: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onClick}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
        selected ? "border-primary/40 bg-signal-tint font-medium text-[var(--signal-deep)]" : "bg-card text-muted-foreground hover:text-foreground",
      )}
    >
      {label}
      {count !== undefined && <span className="tabular-nums opacity-70">{count}</span>}
    </button>
  );
}

/** The email and phone to use for a lead: the person's own, else the company's. */
const reachOf = (lead: LeadSummary) => ({
  id: lead.id,
  name: opportunityName(lead),
  contact: lead.contact?.name ?? null,
  email: lead.contact?.email ?? lead.companyContact.email,
  phone: lead.contact?.phone ?? lead.companyContact.phone,
});

/** A mailto link longer than this is cut off by some mail apps. */
const MAX_MAILTO = 1900;

/**
 * Tick all on the page, or everything in the view; then copy the emails, phones or a table to
 * paste into a sheet, write to them all at once (BCC), or move them to a stage or list.
 */
function BulkBar({
  filter,
  picked,
  allOnPage,
  allMatching,
  total,
  canEdit,
  onToggleAll,
  onSelectAllMatching,
  onClear,
  onDone,
}: {
  filter: LeadFilter;
  picked: LeadSummary[];
  allOnPage: boolean;
  allMatching: boolean;
  total: number;
  canEdit: boolean;
  onToggleAll: () => void;
  onSelectAllMatching: () => void;
  onClear: () => void;
  onDone: () => void;
}) {
  const { data: stages } = usePipeline();
  const { data: lists } = useLists();
  const bulk = useBulkOpportunities();
  const [loading, setLoading] = useState(false);
  const count = allMatching ? total : picked.length;
  const plural = (n: number, word = "lead") => `${n} ${n === 1 ? word : `${word}s`}`;

  /** The selected leads' contacts: from the page, or every lead in the view from the server. */
  const contacts = async (): Promise<LeadContacts["items"] | null> => {
    if (!allMatching) return picked.map(reachOf);
    setLoading(true);
    try {
      const result = await opportunitiesApi.leadContacts(filter);
      if (result.truncated) toast.info(`Only the first ${result.total} leads are included.`);
      return result.items;
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Couldn't load the contacts.");
      return null;
    } finally {
      setLoading(false);
    }
  };

  const copy = async (text: string, done: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast.success(done);
    } catch {
      toast.error("Couldn't copy to the clipboard.");
    }
  };

  const unique = (values: (string | null)[]) => [...new Map(values.filter((v): v is string => Boolean(v)).map((v) => [v.toLowerCase(), v])).values()];
  const missing = (n: number, of: number, what: string) => (n < of ? ` ${plural(of - n)} had no ${what}.` : "");

  const copyEmails = async () => {
    const rows = await contacts();
    if (!rows) return;
    const emails = unique(rows.map((r) => r.email));
    if (emails.length === 0) return toast.error("None of the selected leads has an email.");
    await copy(emails.join(", "), `Copied ${plural(emails.length, "email")}.${missing(rows.filter((r) => r.email).length, rows.length, "email")}`);
  };
  const copyPhones = async () => {
    const rows = await contacts();
    if (!rows) return;
    const phones = unique(rows.map((r) => r.phone));
    if (phones.length === 0) return toast.error("None of the selected leads has a phone number.");
    await copy(phones.join("\n"), `Copied ${plural(phones.length, "phone number")}.${missing(rows.filter((r) => r.phone).length, rows.length, "phone")}`);
  };
  // Tab-separated: pastes straight into Google Sheets or Excel as columns.
  const copyTable = async () => {
    const rows = await contacts();
    if (!rows) return;
    const clean = (value: string | null) => (value ?? "").replace(/[\t\r\n]+/g, " ");
    const lines = ["Lead\tContact\tEmail\tPhone", ...rows.map((r) => [r.name, r.contact, r.email, r.phone].map(clean).join("\t"))];
    await copy(lines.join("\n"), `Copied ${plural(rows.length)} as a table. Paste it into a spreadsheet.`);
  };
  // Everyone in BCC, so no one sees the others' addresses.
  const emailAll = async () => {
    const rows = await contacts();
    if (!rows) return;
    const emails = unique(rows.map((r) => r.email));
    if (emails.length === 0) return toast.error("None of the selected leads has an email.");
    const href = `mailto:?bcc=${emails.map(encodeURIComponent).join(",")}`;
    if (href.length > MAX_MAILTO) {
      return copy(emails.join(", "), `Too many addresses for one email link, so ${plural(emails.length, "email")} were copied instead. Paste them into BCC.`);
    }
    window.location.href = href;
  };

  const ids = picked.map((lead) => lead.id);
  const run = (action: { stageId: string } | { listId: string }, done: (changed: number) => string) =>
    bulk.mutate(
      { ids, ...action },
      {
        onSuccess: ({ changed }) => {
          toast.success(done(changed));
          onDone();
        },
        onError: (error) => toast.error(error.message),
      },
    );
  const busy = loading || bulk.isPending;
  // Moving works on what's on screen; "everything in the view" is for contacting.
  const canMove = canEdit && !allMatching && count > 0;

  return (
    <div className="sticky top-2 z-20 space-y-2 rounded-lg border border-primary/30 bg-card px-3 py-2 text-sm shadow-[0_8px_24px_-12px_rgba(27,36,51,0.25)]">
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          role="checkbox"
          aria-checked={allOnPage ? true : count > 0 ? "mixed" : false}
          onClick={onToggleAll}
          className="inline-flex items-center gap-2 rounded-md px-1 py-0.5 outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          <TickBox checked={allOnPage} partly={count > 0} />
          {count > 0 ? <span className="font-medium">{plural(count)} selected</span> : <span className="text-muted-foreground">Select all on this page</span>}
        </button>
        {count === 0 && <span className="text-xs text-muted-foreground">or click the leads you want</span>}
        {allOnPage && !allMatching && total > picked.length && (
          <button type="button" onClick={onSelectAllMatching} className="text-xs font-medium text-primary hover:underline underline-offset-4">
            Select all {total} in this view
          </button>
        )}
        {allMatching && (
          <button type="button" onClick={onClear} className="text-xs text-muted-foreground hover:text-foreground hover:underline underline-offset-4">
            Clear selection
          </button>
        )}
        <Button variant="ghost" size="sm" className="ml-auto h-8" onClick={onDone}>
          <XIcon />
          Done
        </Button>
      </div>

      {count > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" size="sm" className="h-8" disabled={busy} onClick={copyEmails}>
            <MailIcon />
            Copy emails
          </Button>
          <Button variant="outline" size="sm" className="h-8" disabled={busy} onClick={copyPhones}>
            <PhoneIcon />
            Copy phones
          </Button>
          <Button variant="outline" size="sm" className="h-8" disabled={busy} onClick={copyTable}>
            <TableIcon />
            Copy as table
          </Button>
          <Button variant="outline" size="sm" className="h-8" disabled={busy} onClick={emailAll}>
            <SendIcon />
            Email all (BCC)
          </Button>
          {canMove && (
            <>
              <Select
                value=""
                disabled={busy}
                onValueChange={(stageId) => {
                  const stage = stages?.find((s) => s.id === stageId);
                  run({ stageId }, (n) => `Moved ${plural(n)} to ${stage?.name ?? "the stage"}.`);
                }}
              >
                <SelectTrigger aria-label="Move selected to a stage" className="h-8! w-40">
                  <SelectValue placeholder="Move to stage…" />
                </SelectTrigger>
                <SelectContent>
                  {stages?.map((stage) => (
                    <SelectItem key={stage.id} value={stage.id}>
                      {stage.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select
                value=""
                disabled={busy || !lists?.length}
                onValueChange={(listId) => {
                  const list = lists?.find((l) => l.id === listId);
                  run({ listId }, (n) => (n === 0 ? `Already in ${list?.name ?? "the list"}.` : `Added ${plural(n)} to ${list?.name ?? "the list"}.`));
                }}
              >
                <SelectTrigger aria-label="Add selected to a list" className="h-8! w-40">
                  <SelectValue placeholder={lists?.length ? "Add to list…" : "No lists yet"} />
                </SelectTrigger>
                <SelectContent>
                  {lists?.map((list) => (
                    <SelectItem key={list.id} value={list.id}>
                      {list.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function LeadRow({
  lead,
  columns,
  selection,
}: {
  lead: LeadSummary;
  columns: string;
  /** While selecting, a click anywhere on the row ticks it instead of opening the lead. */
  selection?: { selected: boolean; onToggle: () => void };
}) {
  const person = lead.contact;
  // The person's own line first; the company's when they have none.
  const phone = person?.phone ?? lead.companyContact.phone;
  const email = person?.email ?? lead.companyContact.email;
  const phoneIsCompany = !person?.phone && Boolean(lead.companyContact.phone);
  const emailIsCompany = !person?.email && Boolean(lead.companyContact.email);
  const fromOsm = lead.companyContact.fromOpenStreetMap && (phoneIsCompany || emailIsCompany);
  const more = lead.roleCount - lead.roles.length;

  return (
    <li
      className={cn(
        "relative grid items-center gap-4 px-4 py-3 text-sm transition-colors hover:bg-accent/60",
        columns,
        selection?.selected && "bg-signal-tint/50 hover:bg-signal-tint/70",
      )}
    >
      {selection && (
        <button
          type="button"
          role="checkbox"
          aria-checked={selection.selected}
          aria-label={`Select ${opportunityName(lead)}`}
          onClick={selection.onToggle}
          className="absolute inset-0 z-[5] cursor-pointer outline-none focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:ring-inset"
        />
      )}
      <span className="flex min-w-0 items-center gap-3">
        <CompanyAvatar name={opportunityName(lead)} />
        <span className="min-w-0">
          {/* The whole row opens the lead; the contact links sit above this link. */}
          <Link href={`/opportunities/${lead.id}`} className="block truncate font-medium outline-none after:absolute after:inset-0 focus-visible:underline">
            {opportunityName(lead)}
          </Link>
          {lead.roles.length > 0 ? (
            <span className="block truncate text-xs text-muted-foreground" title={lead.roles.join("\n") + (more > 0 ? `\n+${more} more` : "")}>
              <span className="font-medium text-foreground/80">Hiring:</span> {lead.roles.slice(0, 2).join(" · ")}
              {lead.roleCount > 2 && <span className="text-primary"> +{lead.roleCount - 2} more</span>}
            </span>
          ) : (
            <span className="block truncate text-xs text-muted-foreground">{lead.service?.name ?? "No service matched"}</span>
          )}
        </span>
      </span>

      <span className="min-w-0">
        {person ? (
          <>
            <span className="block truncate font-medium">{person.name}</span>
            <span className="block truncate text-xs text-muted-foreground">{person.title ?? "Title unknown"}</span>
          </>
        ) : phone || email ? (
          <span className="inline-flex items-center gap-1.5 text-muted-foreground">
            <ContactRoundIcon className="size-3.5" />
            Company line
          </span>
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </span>

      <ContactValue kind="phone" value={phone} note={phoneIsCompany ? "Company line" : null} />
      <span className="min-w-0">
        <ContactValue kind="email" value={email} note={emailIsCompany ? "Company inbox" : null} />
        {fromOsm && (
          <a
            href={OSM_COPYRIGHT_URL}
            target="_blank"
            rel="noopener noreferrer"
            title="Published on OpenStreetMap, not verified by us"
            className="relative z-10 block text-[11px] text-muted-foreground hover:text-foreground hover:underline"
          >
            © OpenStreetMap
          </a>
        )}
      </span>

      <LeadLinks lead={lead} />

      <span>
        <StatusBadge stage={lead.stage} archived={lead.archived} />
      </span>
      <span className="flex justify-end">
        <ScoreRing score={lead.score} size="sm" />
      </span>
      {selection && (
        <span className="flex justify-end">
          <TickBox checked={selection.selected} />
        </span>
      )}
    </li>
  );
}

/**
 * Where to find out more, especially when there is no contact yet: the company's website (its
 * contact page is usually one click away) and the page the signal was found on (the job posting,
 * tender, register entry or news item), whose summary shows on hover.
 */
function LeadLinks({ lead }: { lead: LeadSummary }) {
  const domain = lead.company?.domain ?? null;
  // A discovered post, project or filing links to its source; a company lead to its signal's page.
  const evidence = lead.evidence ?? (lead.engine?.sourceUrl ? { url: lead.engine.sourceUrl, summary: lead.engine.title } : null);
  if (!domain && !evidence) return <span className="text-muted-foreground">—</span>;
  return (
    <span className="relative z-10 flex min-w-0 flex-col gap-0.5">
      {domain && (
        <a
          href={`https://${domain}`}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex min-w-0 items-center gap-1.5 hover:text-primary hover:underline underline-offset-4"
        >
          <GlobeIcon className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="truncate">{domain}</span>
        </a>
      )}
      {evidence && (
        <a
          href={evidence.url}
          target="_blank"
          rel="noopener noreferrer"
          title={evidence.summary}
          className="inline-flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground hover:text-primary hover:underline underline-offset-4"
        >
          <RadioTowerIcon className="size-3.5 shrink-0" />
          <span className="truncate">{lead.engine ? `${lead.engine.platform ?? "Source"} · ` : "Signal source · "}{hostOf(evidence.url)}</span>
        </a>
      )}
    </span>
  );
}

const hostOf = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www./, "");
  } catch {
    return "link";
  }
};

/** A phone or email you can call/write to from the list, and copy. */
function ContactValue({ kind, value, note }: { kind: "phone" | "email"; value: string | null; note: string | null }) {
  const [copied, setCopied] = useState(false);
  if (!value) return <span className="text-muted-foreground">—</span>;
  const Icon = kind === "phone" ? PhoneIcon : MailIcon;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error("Couldn't copy. Select the text instead.");
    }
  };

  return (
    <span className="relative z-10 flex min-w-0 items-center gap-1">
      <a
        href={kind === "phone" ? `tel:${value.replace(/[^\d+]/g, "")}` : `mailto:${value}`}
        className="inline-flex min-w-0 items-center gap-1.5 hover:text-primary hover:underline underline-offset-4"
        title={note ?? undefined}
      >
        <Icon className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="truncate">{value}</span>
      </a>
      <button
        type="button"
        onClick={copy}
        aria-label={`Copy ${kind === "phone" ? "phone number" : "email address"}`}
        className="grid size-6 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-background hover:text-foreground"
      >
        {copied ? <CheckIcon className="size-3.5" /> : <CopyIcon className="size-3.5" />}
      </button>
    </span>
  );
}

function SkeletonRows() {
  return (
    <ul className="divide-y" aria-label="Loading leads">
      {Array.from({ length: 6 }, (_, row) => (
        <li key={row} className={cn("grid items-center gap-4 px-4 py-3", COLUMNS)}>
          <span className="flex items-center gap-3">
            <Skeleton className="size-9 rounded-lg" />
            <Skeleton className="h-4 w-36" />
          </span>
          <Skeleton className="h-4 w-28" />
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-4 w-40" />
          <Skeleton className="h-4 w-28" />
          <Skeleton className="h-5 w-16 rounded-full" />
          <Skeleton className="ml-auto size-8 rounded-full" />
        </li>
      ))}
    </ul>
  );
}
