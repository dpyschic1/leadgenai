"use client";

import { useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import {
  ArrowLeftIcon,
  ExternalLinkIcon,
  MoreHorizontalIcon,
  PencilIcon,
  SparklesIcon,
  Trash2Icon,
  UserPlusIcon,
  UsersRoundIcon,
} from "lucide-react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/forms/confirm-dialog";
import { EditorSheet } from "@/components/forms/editor-sheet";
import { CompanySignals } from "@/components/signals/company-signals";
import { SignalForm } from "@/components/signals/signal-form";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { useCompany, useDeleteCompany, useRemovePerson } from "@/hooks/use-companies";
import { usePermission } from "@/hooks/use-permission";
import { useLookupNames } from "@/hooks/use-reference-data";
import { ApiError } from "@/lib/api/client";
import type { CompanyDetail, CompanyPerson, Signal } from "@/lib/api/types";
import { countryName } from "@/lib/countries";
import { formatEmployees, formatPlace } from "@/lib/format";
import { EDITOR_ROLES } from "@/lib/permissions";
import { CompanyAvatar } from "./company-avatar";
import { CompanyForm } from "./company-form";
import { PersonForm } from "./person-form";
import { PersonRow } from "./person-row";

/** `null` = closed, `"new"` = adding, a person = editing them. */
type PersonEditing = CompanyPerson | "new" | null;
type SignalEditing = Signal | "new" | null;

export function CompanyDetailView() {
  const { id } = useParams<{ id: string }>();
  const { data: company, error } = useCompany(id);

  if (error instanceof ApiError && error.status === 404) return <CompanyNotFound />;
  if (!company) return <CompanyDetailSkeleton />;
  return <CompanyDetailContent company={company} />;
}

function CompanyDetailContent({ company }: { company: CompanyDetail }) {
  const router = useRouter();
  const canEdit = usePermission(EDITOR_ROLES);
  const names = useLookupNames();
  const [editingCompany, setEditingCompany] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [editingPerson, setEditingPerson] = useState<PersonEditing>(null);
  const [removing, setRemoving] = useState<CompanyPerson | null>(null);
  const [editingSignal, setEditingSignal] = useState<SignalEditing>(null);
  const deleteCompany = useDeleteCompany();
  const removePerson = useRemovePerson(company.id);

  const hq = company.locations.find((location) => location.type === "headquarters");
  const hqText = hq && formatPlace([hq.city, hq.region, hq.country && countryName(hq.country)]);

  return (
    <div className="space-y-6">
      <Link
        href="/companies"
        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
      >
        <ArrowLeftIcon className="size-4" />
        Companies
      </Link>

      <header className="flex flex-col gap-4 rounded-2xl border bg-card p-6 sm:flex-row sm:items-center">
        <CompanyAvatar name={company.name} className="size-14 rounded-xl text-base" />
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-2xl font-semibold">{company.name}</h1>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-sm text-muted-foreground">
            {company.domain && (
              <a
                href={`https://${company.domain}`}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 font-medium text-primary hover:underline underline-offset-4"
              >
                {company.domain}
                <ExternalLinkIcon className="size-3.5" />
              </a>
            )}
            {company.industry && (
              <span className="rounded-full bg-signal-tint px-2.5 py-0.5 text-xs font-medium text-[var(--signal-deep)]">
                {names.industry(company.industry)}
              </span>
            )}
            {hqText && <span>{hqText}</span>}
          </div>
        </div>
        {canEdit && (
          <div className="flex items-center gap-2">
            <Button onClick={() => setEditingSignal("new")}>
              <SparklesIcon />
              Record signal
            </Button>
            <Button variant="outline" onClick={() => setEditingCompany(true)}>
              <PencilIcon />
              Edit
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="icon" aria-label="More actions">
                  <MoreHorizontalIcon />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem variant="destructive" onSelect={() => setConfirmDelete(true)}>
                  <Trash2Icon />
                  Delete company
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        )}
      </header>

      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="min-w-0 space-y-6">
          <CompanySignals
            companyId={company.id}
            people={company.people}
            canEdit={canEdit}
            onRecord={() => setEditingSignal("new")}
            onEdit={setEditingSignal}
          />
          <section aria-labelledby="people-heading" className="rounded-xl border bg-card">
            <div className="flex items-center justify-between gap-3 border-b px-5 py-4">
              <div>
                <h2 id="people-heading" className="font-semibold">
                  People
                </h2>
                <p className="text-sm text-muted-foreground">
                  {company.people.length === 0
                    ? "No one added yet"
                    : `${company.people.length} ${company.people.length === 1 ? "person" : "people"} at ${company.name}`}
                </p>
              </div>
              {canEdit && company.people.length > 0 && (
                <Button variant="outline" onClick={() => setEditingPerson("new")}>
                  <UserPlusIcon />
                  Add person
                </Button>
              )}
            </div>
            {company.people.length > 0 ? (
              <ul className="divide-y">
                {company.people.map((person) => (
                  <PersonRow
                    key={person.id}
                    person={person}
                    canEdit={canEdit}
                    onEdit={() => setEditingPerson(person)}
                    onRemove={() => setRemoving(person)}
                  />
                ))}
              </ul>
            ) : (
              <div className="flex flex-col items-center px-6 py-12 text-center">
                <span className="grid size-10 place-items-center rounded-full bg-signal-tint text-primary">
                  <UsersRoundIcon className="size-5" />
                </span>
                <p className="mt-3 font-medium">Who would you talk to here?</p>
                <p className="mt-1 max-w-sm text-sm text-muted-foreground">
                  Add the decision makers. They become the suggested contacts on this company&apos;s opportunities.
                </p>
                {canEdit && (
                  <Button className="mt-4" onClick={() => setEditingPerson("new")}>
                    <UserPlusIcon />
                    Add person
                  </Button>
                )}
              </div>
            )}
          </section>
        </div>

        <aside aria-labelledby="about-heading" className="rounded-xl border bg-card p-5">
          <h2 id="about-heading" className="font-semibold">
            About
          </h2>
          <dl className="mt-4 space-y-3 text-sm">
            <AboutRow label="Industry" value={company.industry && names.industry(company.industry)} />
            <AboutRow label="Employees" value={formatEmployees(company.employeeCount)} />
            <AboutRow label="Headquarters" value={hqText} />
            <AboutRow label="Website" value={company.domain} />
          </dl>
          {company.description && (
            <p className="mt-5 border-t pt-4 text-sm leading-relaxed text-muted-foreground">{company.description}</p>
          )}
        </aside>
      </div>

      <EditorSheet
        open={editingCompany}
        onClose={() => setEditingCompany(false)}
        title="Edit company"
        description="Changes apply everywhere this company appears."
      >
        <CompanyForm company={company} onDone={() => setEditingCompany(false)} onCancel={() => setEditingCompany(false)} />
      </EditorSheet>

      <EditorSheet
        open={editingSignal !== null}
        onClose={() => setEditingSignal(null)}
        title={editingSignal === "new" ? `Record a signal for ${company.name}` : "Edit signal"}
        description="A sign that this company may need what you sell, with the evidence behind it."
      >
        {editingSignal !== null && (
          <SignalForm
            key={editingSignal === "new" ? "new" : editingSignal.id}
            companyId={company.id}
            companyName={company.name}
            people={company.people}
            signal={editingSignal === "new" ? undefined : editingSignal}
            onDone={() => setEditingSignal(null)}
            onCancel={() => setEditingSignal(null)}
          />
        )}
      </EditorSheet>

      <EditorSheet
        open={editingPerson !== null}
        onClose={() => setEditingPerson(null)}
        title={editingPerson === "new" ? `Add a person to ${company.name}` : "Edit person"}
        description="Only business contact details. They're shown to everyone in your workspace."
      >
        {editingPerson !== null && (
          <PersonForm
            key={editingPerson === "new" ? "new" : editingPerson.id}
            companyId={company.id}
            companyName={company.name}
            person={editingPerson === "new" ? undefined : editingPerson}
            onDone={() => setEditingPerson(null)}
            onCancel={() => setEditingPerson(null)}
          />
        )}
      </EditorSheet>

      <ConfirmDialog
        open={confirmDelete}
        title={`Delete ${company.name}?`}
        description="This also deletes its locations, signals and opportunities, and anyone who works only here. It can't be undone."
        confirmLabel="Delete company"
        pending={deleteCompany.isPending}
        onClose={() => setConfirmDelete(false)}
        onConfirm={() =>
          deleteCompany.mutate(company.id, {
            onSuccess: () => {
              toast.success(`Deleted ${company.name}.`);
              router.replace("/companies");
            },
            onError: (error) => toast.error(error.message),
          })
        }
      />

      <ConfirmDialog
        open={removing !== null}
        title={`Remove ${removing?.name}?`}
        description={`They'll no longer be listed at ${company.name}.`}
        confirmLabel="Remove person"
        pending={removePerson.isPending}
        onClose={() => setRemoving(null)}
        onConfirm={() =>
          removing &&
          removePerson.mutate(removing.id, {
            onSuccess: () => {
              toast.success(`Removed ${removing.name}.`);
              setRemoving(null);
            },
            onError: (error) => toast.error(error.message),
          })
        }
      />
    </div>
  );
}

function AboutRow({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div className="grid grid-cols-[6.5rem_minmax(0,1fr)] gap-3">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={value ? "break-words" : "text-muted-foreground"}>{value || "Unknown"}</dd>
    </div>
  );
}

function CompanyNotFound() {
  return (
    <div className="flex flex-col items-center rounded-xl border border-dashed bg-card px-6 py-16 text-center">
      <h1 className="font-semibold">Company not found</h1>
      <p className="mt-1.5 text-sm text-muted-foreground">It may have been deleted, or it belongs to another workspace.</p>
      <Button asChild variant="outline" className="mt-5">
        <Link href="/companies">
          <ArrowLeftIcon />
          Back to companies
        </Link>
      </Button>
    </div>
  );
}

export function CompanyDetailSkeleton() {
  return (
    <div className="space-y-6" aria-label="Loading company">
      <Skeleton className="h-5 w-28" />
      <div className="flex items-center gap-4 rounded-2xl border bg-card p-6">
        <Skeleton className="size-14 rounded-xl" />
        <div className="flex-1 space-y-2">
          <Skeleton className="h-7 w-64" />
          <Skeleton className="h-4 w-80 max-w-full" />
        </div>
      </div>
      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="rounded-xl border bg-card">
          <div className="space-y-2 border-b px-5 py-4">
            <Skeleton className="h-5 w-20" />
            <Skeleton className="h-4 w-40" />
          </div>
          {[0, 1, 2].map((row) => (
            <div key={row} className="flex items-center gap-3 border-b px-5 py-4 last:border-b-0">
              <Skeleton className="size-10 rounded-full" />
              <div className="flex-1 space-y-1.5">
                <Skeleton className="h-4 w-36" />
                <Skeleton className="h-3 w-24" />
              </div>
            </div>
          ))}
        </div>
        <div className="space-y-3 rounded-xl border bg-card p-5">
          <Skeleton className="h-5 w-16" />
          {[0, 1, 2, 3].map((row) => (
            <Skeleton key={row} className="h-4 w-full" />
          ))}
        </div>
      </div>
    </div>
  );
}
