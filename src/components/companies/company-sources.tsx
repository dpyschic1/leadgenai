"use client";

import { ExternalLinkIcon, Loader2Icon, MailIcon, PhoneIcon, RadarIcon, RefreshCwIcon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { OsmCredit } from "./contact-status";
import { useCompanySources, useRefreshCompany } from "@/hooks/use-data-sources";
import { COMPANY_IDENTITY_LABELS, SOURCE_LABELS, type CompanyIdentity, type SourceSlug } from "@/lib/domain/sources";
import { cn } from "@/lib/utils";

const day = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", year: "numeric" });

const RECORD_LABELS: Record<string, string> = {
  company_profile: "Register entry",
  cqc_provider: "CQC register entry",
  cqc_locations: "CQC practices",
  job_board: "Job board",
  officer_list: "Directors",
  tender: "Public tender",
  "web_page:home": "Website: home page",
  "web_page:about": "Website: about",
  "web_page:team": "Website: team",
  "web_page:contact": "Website: contact",
  "web_page:careers": "Website: careers",
  "web_page:news": "Website: news",
};

/** Why the website was accepted as the company's (the evidence recorded with it). */
const WEBSITE_MATCH: Record<string, string> = {
  company_number: "Shows the company number",
  registered_address: "Shows the name and registered-office postcode",
  name: "Shows the company name and town",
  job_board_link: "Links to the company's job board",
  regulator_listing: "Listed for its practices on the CQC register",
};

/** How an OpenStreetMap place was tied to the company. */
const OSM_MATCH: Record<string, string> = {
  cqc_ref: "Carries the practice's CQC location id",
  website: "Same postcode, name and website",
  postcode_name: "Same postcode and name",
};

/** Where the company's information came from, when it was last checked, and its published contacts. */
export function CompanySourcesCard({ companyId, canEdit }: { companyId: string; canEdit: boolean }) {
  const { data } = useCompanySources(companyId);
  const refresh = useRefreshCompany(companyId);

  return (
    <aside aria-labelledby="sources-heading" className="rounded-xl border bg-card p-5">
      <div className="flex items-center justify-between gap-2">
        <h2 id="sources-heading" className="font-semibold">
          Sources
        </h2>
        {canEdit && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() =>
              refresh.mutate(undefined, {
                onSuccess: (result) => toast.success(result.pendingJobs > 0 ? "Checking now; more results will appear shortly." : "Checked all sources."),
                onError: (error) => toast.error(error.message),
              })
            }
            disabled={refresh.isPending}
            aria-busy={refresh.isPending}
          >
            {refresh.isPending ? <Loader2Icon className="animate-spin" /> : <RefreshCwIcon />}
            {refresh.isPending ? "Checking…" : "Refresh"}
          </Button>
        )}
      </div>

      {!data ? (
        <div className="mt-4 space-y-2">
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-2/3" />
        </div>
      ) : (
        <div className="mt-3 space-y-4 text-sm">
          <p className="text-muted-foreground">
            {data.discoveredBy
              ? `Found automatically on ${SOURCE_LABELS[data.discoveredBy]}${data.discoveredAt ? ` on ${day.format(new Date(data.discoveredAt))}` : ""}.`
              : "Added by hand."}
            {data.pendingJobs > 0 && (
              <span className="mt-1 flex items-center gap-1.5 text-primary">
                <Loader2Icon className="size-3.5 animate-spin" />
                Still checking…
              </span>
            )}
          </p>

          {(data.companyNumber || data.website) && (
            <dl className="space-y-2">
              {data.companyNumber && (
                <div className="grid grid-cols-[6.5rem_minmax(0,1fr)] gap-3">
                  <dt className="text-muted-foreground">Company no.</dt>
                  <dd>
                    <a
                      href={`https://find-and-update.company-information.service.gov.uk/company/${data.companyNumber}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 font-medium text-primary hover:underline underline-offset-4"
                    >
                      {data.companyNumber}
                      <ExternalLinkIcon className="size-3" />
                    </a>
                  </dd>
                </div>
              )}
              {data.website && (
                <div className="grid grid-cols-[6.5rem_minmax(0,1fr)] gap-3">
                  <dt className="text-muted-foreground">Website</dt>
                  <dd>
                    {data.website.domain}
                    <span className="block text-xs text-muted-foreground">
                      {WEBSITE_MATCH[data.website.matchedBy] ?? "Shows the company name"} ·{" "}
                      {data.website.confidence}% sure
                    </span>
                  </dd>
                </div>
              )}
            </dl>
          )}

          {data.contacts.length > 0 && (
            <div>
              <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Published contacts</p>
              <ul className="mt-2 space-y-1.5">
                {data.contacts.map((c) => (
                  <li key={`${c.type}:${c.value}`} className="flex items-center gap-2 break-all">
                    {c.type === "email" ? <MailIcon className="size-3.5 shrink-0 text-muted-foreground" /> : <PhoneIcon className="size-3.5 shrink-0 text-muted-foreground" />}
                    <a href={c.type === "email" ? `mailto:${c.value}` : `tel:${c.value}`} className="hover:text-primary">
                      {c.value}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {data.openStreetMap.length > 0 && (
            <div>
              <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">On OpenStreetMap</p>
              <ul className="mt-2 space-y-2">
                {data.openStreetMap.map((place) => (
                  <li key={place.url} className="min-w-0">
                    <a href={place.url} target="_blank" rel="noopener noreferrer" className="block truncate font-medium hover:text-primary">
                      {place.name}
                    </a>
                    <p className="truncate text-xs text-muted-foreground">
                      {[place.phone, place.email, place.website?.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "")].filter(Boolean).join(" · ")}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {OSM_MATCH[place.matchedBy] ?? "Matched by name and postcode"} · checked {day.format(new Date(place.checkedAt))}
                    </p>
                  </li>
                ))}
              </ul>
              <OsmCredit className="mt-2" />
            </div>
          )}

          {data.sites.length > 0 && (
            <div>
              <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
                {data.sites.length === 1 ? "Registered location" : `${data.sites.length} registered locations`}
              </p>
              <ul className="mt-2 space-y-2">
                {data.sites.slice(0, 6).map((site) => (
                  <li key={`${site.name}:${site.postalCode}`} className="min-w-0">
                    <p className="truncate font-medium">{site.name}</p>
                    <p className="truncate text-xs text-muted-foreground">
                      {[site.postalCode, site.phone, site.website].filter(Boolean).join(" · ") || "No contact details listed"}
                    </p>
                  </li>
                ))}
              </ul>
              {data.sites.length > 6 && <p className="mt-1 text-xs text-muted-foreground">and {data.sites.length - 6} more</p>}
            </div>
          )}

          {data.records.length > 0 && (
            <div>
              <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Last checked</p>
              <ul className="mt-2 space-y-1.5">
                {data.records.slice(0, 8).map((r) => (
                  <li key={`${r.recordType}:${r.url}`} className="flex items-baseline justify-between gap-3">
                    {r.url ? (
                      <a href={r.url} target="_blank" rel="noopener noreferrer" className="truncate hover:text-primary">
                        {RECORD_LABELS[r.recordType] ?? SOURCE_LABELS[r.source]}
                      </a>
                    ) : (
                      <span className="truncate">{RECORD_LABELS[r.recordType] ?? SOURCE_LABELS[r.source]}</span>
                    )}
                    <span className="shrink-0 text-xs text-muted-foreground">{day.format(new Date(r.observedAt))}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {data.attributions.map((line) => (
            <p key={line} className="border-t pt-3 text-xs text-muted-foreground">
              {line}
            </p>
          ))}
        </div>
      )}
    </aside>
  );
}

const IDENTITY_HINTS: Record<Exclude<CompanyIdentity, "verified">, string> = {
  provisional: "Known only from its own job board so far: not yet matched to a register or a confirmed website.",
  partial: "Its website is confirmed, but it isn't matched to a register number yet.",
};

/** Flags a company whose identity isn't fully confirmed; shows nothing for a verified one. */
export function IdentityStatusBadge({ status }: { status: CompanyIdentity }) {
  if (status === "verified") return null;
  return (
    <span
      title={IDENTITY_HINTS[status]}
      className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-800"
    >
      {COMPANY_IDENTITY_LABELS[status]}
    </span>
  );
}

/** "Found automatically · Companies House": marks a company a source found rather than a person added. */
export function FoundBadge({ source, compact = false, className }: { source: SourceSlug; compact?: boolean; className?: string }) {
  return (
    <span
      className={cn("inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground", className)}
      title={`Found automatically on ${SOURCE_LABELS[source]}`}
    >
      <RadarIcon className="size-3" />
      {compact ? "Auto" : `Found automatically · ${SOURCE_LABELS[source]}`}
    </span>
  );
}
