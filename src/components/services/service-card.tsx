"use client";

import {
  BriefcaseBusinessIcon,
  Building2Icon,
  FactoryIcon,
  GlobeIcon,
  MoreHorizontalIcon,
  PencilIcon,
  Trash2Icon,
  UsersRoundIcon,
  type LucideIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { useReferenceData } from "@/hooks/use-reference-data";
import type { Service } from "@/lib/api/types";
import { countryName } from "@/lib/countries";
import { cn } from "@/lib/utils";

function companySize(min: number | null, max: number | null): string | null {
  const fmt = (n: number) => n.toLocaleString();
  if (min !== null && max !== null) return `${fmt(min)}–${fmt(max)} employees`;
  if (min !== null) return `${fmt(min)}+ employees`;
  if (max !== null) return `Up to ${fmt(max)} employees`;
  return null;
}

function TargetTile({
  icon: Icon,
  label,
  values,
}: {
  icon: LucideIcon;
  label: string;
  values: string[] | string | null;
}) {
  const text = Array.isArray(values) ? values.join(", ") : values;
  return (
    <div className="rounded-lg bg-canvas p-3">
      <dt className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Icon className="size-3.5" />
        {label}
      </dt>
      <dd className={cn("mt-1 line-clamp-2 text-sm", text ? "font-medium" : "text-muted-foreground")}>
        {text || "Any"}
      </dd>
    </div>
  );
}

export function ServiceCard({
  service,
  canEdit,
  onEdit,
  onDelete,
}: {
  service: Service;
  canEdit: boolean;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const { data: ref } = useReferenceData();
  const nameOf = (rows: { slug: string; name: string }[] | undefined, slugs: string[]) => {
    const names = new Map(rows?.map((row) => [row.slug, row.name]));
    return slugs.map((slug) => names.get(slug) ?? slug);
  };

  return (
    <article className="flex flex-col rounded-xl border bg-card p-5 shadow-[0_1px_2px_rgba(27,36,51,0.04)] transition-shadow hover:shadow-[0_8px_24px_-12px_rgba(27,36,51,0.18)]">
      <div className="flex items-start gap-4">
        <span className="grid size-11 shrink-0 place-items-center rounded-xl bg-signal-tint text-primary">
          <BriefcaseBusinessIcon className="size-5" />
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-base font-semibold">{service.name}</h3>
          <p className={cn("mt-0.5 line-clamp-2 text-sm", service.description ? "text-muted-foreground" : "text-muted-foreground/70 italic")}>
            {service.description || "No description yet"}
          </p>
        </div>
        {canEdit && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" className="-mt-1 -mr-2 shrink-0" aria-label={`Actions for ${service.name}`}>
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

      <ul className="mt-4 flex flex-wrap gap-1.5" aria-label="Categories">
        {ref
          ? nameOf(ref.serviceCategories, service.categories).map((name) => (
              <li
                key={name}
                className="rounded-full border border-primary/15 bg-signal-tint px-2.5 py-0.5 text-xs font-medium text-[var(--signal-deep)]"
              >
                {name}
              </li>
            ))
          : service.categories.map((slug) => <Skeleton key={slug} className="h-5 w-24 rounded-full" />)}
      </ul>

      <div className="mt-5 border-t pt-4">
        <p className="mb-2.5 text-sm font-medium">Ideal customer</p>
        <dl className="grid grid-cols-2 gap-2">
          <TargetTile icon={UsersRoundIcon} label="Buyer roles" values={nameOf(ref?.jobFunctions, service.targetJobFunctions)} />
          <TargetTile icon={FactoryIcon} label="Industries" values={nameOf(ref?.industries, service.targetIndustries)} />
          <TargetTile icon={GlobeIcon} label="Countries" values={service.targetCountries.map(countryName)} />
          <TargetTile
            icon={Building2Icon}
            label="Company size"
            values={companySize(service.companySizeMin, service.companySizeMax)}
          />
        </dl>
      </div>
    </article>
  );
}

export function ServiceCardSkeleton() {
  return (
    <div className="rounded-xl border bg-card p-5" aria-hidden="true">
      <div className="flex items-start gap-4">
        <Skeleton className="size-11 rounded-xl" />
        <div className="flex-1 space-y-2">
          <Skeleton className="h-5 w-44" />
          <Skeleton className="h-4 w-full" />
        </div>
      </div>
      <div className="mt-4 flex gap-1.5">
        <Skeleton className="h-5 w-28 rounded-full" />
        <Skeleton className="h-5 w-16 rounded-full" />
        <Skeleton className="h-5 w-20 rounded-full" />
      </div>
      <div className="mt-5 border-t pt-4">
        <Skeleton className="mb-2.5 h-4 w-28" />
        <div className="grid grid-cols-2 gap-2">
          {[0, 1, 2, 3].map((tile) => (
            <Skeleton key={tile} className="h-[68px] rounded-lg" />
          ))}
        </div>
      </div>
    </div>
  );
}
