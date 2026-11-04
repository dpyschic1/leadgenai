"use client";

import { useState } from "react";
import Link from "next/link";
import { CheckIcon, CopyIcon, ContactRoundIcon, GlobeIcon, MailIcon, PhoneIcon, RadioTowerIcon, SearchIcon } from "lucide-react";
import { toast } from "sonner";
import { CompanyAvatar } from "@/components/companies/company-avatar";
import { PageHeader } from "@/components/layout/page-header";
import { Pagination, usePage } from "@/components/layout/pagination";
import { ScoreRing } from "@/components/opportunities/score-ring";
import { StatusBadge } from "@/components/opportunities/status-badge";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { useLeads } from "@/hooks/use-opportunities";
import type { OpportunitySummary } from "@/lib/api/types";
import { OSM_COPYRIGHT_URL } from "@/lib/domain/sources";
import type { LeadTab } from "@/lib/domain/opportunities";
import { cn } from "@/lib/utils";

const TABS: { tab: LeadTab; label: string; hint: string }[] = [
  { tab: "all", label: "All leads", hint: "Every lead still being worked: new or in progress." },
  { tab: "person", label: "Named contact", hint: "A named person with their own phone or email: call or write to them directly." },
  { tab: "company", label: "Company line", hint: "No named person reachable yet, but the company's own phone or email works as a way in." },
  { tab: "none", label: "No contact yet", hint: "Nothing to call or write to yet. Open the lead to research it, or wait for its website to be read." },
];

const EMPTY: Record<LeadTab, string> = {
  all: "No active leads yet. Opportunities you're working appear here with their contacts.",
  person: "No lead has a named contact with a phone or email yet.",
  company: "No lead is reachable only through its company line.",
  none: "Every lead has a way in.",
};

const COLUMNS = "grid-cols-[minmax(0,2fr)_minmax(0,1.4fr)_minmax(0,1.1fr)_minmax(0,1.5fr)_minmax(0,1.2fr)_7.5rem_3rem]";

/**
 * The sales team's list: every active lead with who to talk to and how, by how it can be reached.
 * Rows open the opportunity; phones and emails call, write or copy straight from the list.
 */
export function LeadsView() {
  const [tab, setTab] = useState<LeadTab>("all");
  const [search, setSearch] = useState("");
  const q = useDebouncedValue(search.trim());
  const [page, setPage] = usePage(JSON.stringify([tab, q]));
  const { data, isPending, isFetching } = useLeads(tab, q, page);
  const hint = TABS.find((t) => t.tab === tab)!.hint;

  return (
    <div className="space-y-6">
      <PageHeader title="Leads" description="Who to contact at every lead you're working, and how: named people first, then the company's own line." />

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
      </div>
      <p className="-mt-3 text-sm text-muted-foreground">{hint}</p>

      <section className="overflow-hidden rounded-xl border bg-card">
        <div className="overflow-x-auto">
          <div className="min-w-[1080px]">
            <div className={cn("grid gap-4 border-b bg-canvas px-4 py-2.5 text-xs font-medium text-muted-foreground", COLUMNS)}>
              <span>Lead</span>
              <span>Contact</span>
              <span>Phone</span>
              <span>Email</span>
              <span>Links</span>
              <span>Status</span>
              <span className="text-right">Score</span>
            </div>
            {isPending && !data ? (
              <SkeletonRows />
            ) : data && data.items.length > 0 ? (
              <ul className={cn("divide-y transition-opacity", isFetching && "opacity-60")} aria-label="Leads">
                {data.items.map((lead) => (
                  <LeadRow key={lead.id} lead={lead} />
                ))}
              </ul>
            ) : (
              <p className="px-4 py-12 text-center text-sm text-muted-foreground">{q ? `No leads match “${q}”.` : EMPTY[tab]}</p>
            )}
          </div>
        </div>
        {data && <Pagination page={data.page} pageSize={data.pageSize} total={data.total} noun="leads" onChange={setPage} className="border-t px-4 py-3" />}
      </section>
    </div>
  );
}

function LeadRow({ lead }: { lead: OpportunitySummary }) {
  const person = lead.contact;
  // The person's own line first; the company's when they have none.
  const phone = person?.phone ?? lead.companyContact.phone;
  const email = person?.email ?? lead.companyContact.email;
  const phoneIsCompany = !person?.phone && Boolean(lead.companyContact.phone);
  const emailIsCompany = !person?.email && Boolean(lead.companyContact.email);
  const fromOsm = lead.companyContact.fromOpenStreetMap && (phoneIsCompany || emailIsCompany);

  return (
    <li className={cn("relative grid items-center gap-4 px-4 py-3 text-sm transition-colors hover:bg-accent/60", COLUMNS)}>
      <span className="flex min-w-0 items-center gap-3">
        <CompanyAvatar name={lead.company.name} />
        <span className="min-w-0">
          {/* The whole row opens the lead; the contact links sit above this link. */}
          <Link href={`/opportunities/${lead.id}`} className="block truncate font-medium outline-none after:absolute after:inset-0 focus-visible:underline">
            {lead.company.name}
          </Link>
          <span className="block truncate text-xs text-muted-foreground">{lead.service?.name ?? "No service matched"}</span>
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
        <StatusBadge status={lead.status} />
      </span>
      <span className="flex justify-end">
        <ScoreRing score={lead.score} size="sm" />
      </span>
    </li>
  );
}

/**
 * Where to find out more, especially when there is no contact yet: the company's website (its
 * contact page is usually one click away) and the page the signal was found on (the job posting,
 * tender, register entry or news item), whose summary shows on hover.
 */
function LeadLinks({ lead }: { lead: OpportunitySummary }) {
  const domain = lead.company.domain;
  const evidence = lead.evidence;
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
          <span className="truncate">Signal source · {hostOf(evidence.url)}</span>
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
