"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Building2Icon, PlusIcon, SearchIcon, UsersRoundIcon } from "lucide-react";
import { EditorSheet } from "@/components/forms/editor-sheet";
import { PageHeader } from "@/components/layout/page-header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { useCompanies } from "@/hooks/use-companies";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { usePermission } from "@/hooks/use-permission";
import { useLookupNames } from "@/hooks/use-reference-data";
import type { CompanySummary } from "@/lib/api/types";
import { countryName } from "@/lib/countries";
import { formatPlace } from "@/lib/format";
import { EDITOR_ROLES } from "@/lib/permissions";
import { cn } from "@/lib/utils";
import { CompanyAvatar } from "./company-avatar";
import { CompanyForm } from "./company-form";

const COLUMNS = "grid-cols-[minmax(0,2.2fr)_minmax(0,1.3fr)_minmax(0,1fr)_minmax(0,1.3fr)_5rem]";

export function CompaniesView() {
  const router = useRouter();
  const [search, setSearch] = useState("");
  const query = useDebouncedValue(search.trim());
  const { data: companies, isPending, isFetching } = useCompanies(query);
  const canEdit = usePermission(EDITOR_ROLES);
  const [adding, setAdding] = useState(false);

  const isFirstLoad = isPending && !companies;
  const isEmptyWorkspace = !query && companies?.length === 0;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Companies"
        description="The companies you watch, and the people you'd talk to there."
        action={
          canEdit && (
            <Button onClick={() => setAdding(true)}>
              <PlusIcon />
              Add company
            </Button>
          )
        }
      />

      {isEmptyWorkspace ? (
        <EmptyCompanies canEdit={canEdit} onAdd={() => setAdding(true)} />
      ) : (
        <section className="overflow-hidden rounded-xl border bg-card">
          <div className="flex items-center gap-3 border-b px-4 py-3">
            <div className="relative w-full max-w-sm">
              <SearchIcon className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                type="search"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search by name or domain"
                aria-label="Search companies"
                className="h-9 pl-9"
              />
            </div>
            {companies && (
              <p className="ml-auto text-sm tabular-nums text-muted-foreground" aria-live="polite">
                {companies.length} {companies.length === 1 ? "company" : "companies"}
              </p>
            )}
          </div>

          <div className="overflow-x-auto">
            <div className="min-w-[760px]">
              <div className={cn("grid gap-4 border-b bg-canvas px-4 py-2.5 text-xs font-medium text-muted-foreground", COLUMNS)}>
                <span>Company</span>
                <span>Industry</span>
                <span>Size</span>
                <span>Headquarters</span>
                <span className="text-right">People</span>
              </div>

              {isFirstLoad ? (
                <SkeletonRows />
              ) : companies && companies.length > 0 ? (
                <ul className={cn("divide-y transition-opacity", isFetching && "opacity-60")}>
                  {companies.map((company) => (
                    <CompanyRow key={company.id} company={company} />
                  ))}
                </ul>
              ) : (
                <p className="px-4 py-12 text-center text-sm text-muted-foreground">
                  No companies match “{query}”.
                </p>
              )}
            </div>
          </div>
        </section>
      )}

      <EditorSheet
        open={adding}
        onClose={() => setAdding(false)}
        title="Add a company"
        description="Add a company you're watching. You can add its people next."
      >
        <CompanyForm
          onCancel={() => setAdding(false)}
          onDone={(company) => {
            setAdding(false);
            router.push(`/companies/${company.id}`);
          }}
        />
      </EditorSheet>
    </div>
  );
}

function CompanyRow({ company }: { company: CompanySummary }) {
  const names = useLookupNames();
  const hq = company.headquarters;
  const place = hq && formatPlace([hq.city, hq.country && countryName(hq.country)]);

  return (
    <li>
      <Link
        href={`/companies/${company.id}`}
        className={cn("grid items-center gap-4 px-4 py-3 text-sm transition-colors hover:bg-accent/60", COLUMNS)}
      >
        <span className="flex min-w-0 items-center gap-3">
          <CompanyAvatar name={company.name} />
          <span className="min-w-0">
            <span className="block truncate font-medium">{company.name}</span>
            <span className="block truncate text-xs text-muted-foreground">{company.domain ?? "No website"}</span>
          </span>
        </span>
        <Cell value={company.industry && names.industry(company.industry)} />
        <Cell value={company.employeeCount?.toLocaleString()} />
        <Cell value={place} />
        <span className="flex items-center justify-end gap-1.5 tabular-nums text-muted-foreground">
          <UsersRoundIcon className="size-3.5" />
          {company.peopleCount}
        </span>
      </Link>
    </li>
  );
}

function Cell({ value }: { value: string | null | undefined }) {
  return <span className={cn("truncate", !value && "text-muted-foreground")}>{value || "—"}</span>;
}

function SkeletonRows() {
  return (
    <ul className="divide-y" aria-label="Loading companies">
      {Array.from({ length: 6 }, (_, row) => (
        <li key={row} className={cn("grid items-center gap-4 px-4 py-3", COLUMNS)}>
          <span className="flex items-center gap-3">
            <Skeleton className="size-9 rounded-lg" />
            <span className="flex-1 space-y-1.5">
              <Skeleton className="h-4 w-40" />
              <Skeleton className="h-3 w-24" />
            </span>
          </span>
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-4 w-12" />
          <Skeleton className="h-4 w-28" />
          <Skeleton className="ml-auto h-4 w-8" />
        </li>
      ))}
    </ul>
  );
}

function EmptyCompanies({ canEdit, onAdd }: { canEdit: boolean; onAdd: () => void }) {
  return (
    <section className="flex flex-col items-center rounded-xl border border-dashed bg-card px-6 py-14 text-center">
      <span className="grid size-11 place-items-center rounded-full bg-signal-tint text-primary">
        <Building2Icon className="size-5" />
      </span>
      <h2 className="mt-4 font-semibold">Add the first company you&apos;re watching</h2>
      <p className="mt-1.5 max-w-md text-sm text-muted-foreground">
        {canEdit
          ? "Companies hold the signals and people behind every opportunity. Start with one you already know."
          : "Viewers can browse companies but not add them. Ask a workspace admin for edit access."}
      </p>
      {canEdit && (
        <Button className="mt-5" onClick={onAdd}>
          <PlusIcon />
          Add company
        </Button>
      )}
    </section>
  );
}
