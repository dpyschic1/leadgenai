"use client";

import { LinkIcon, MailIcon, MoreHorizontalIcon, PencilIcon, PhoneIcon, UserMinusIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useLookupNames } from "@/hooks/use-reference-data";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { CompanyPerson, ContactCheck } from "@/lib/api/types";
import { RELATIONSHIP_LABELS, SENIORITY_LABELS } from "@/lib/domain/people";
import { SOURCE_LABELS, type SourceSlug } from "@/lib/domain/sources";
import { initials } from "@/lib/format";
import { cn } from "@/lib/utils";
import { IdentityBadge, verificationText } from "./contact-status";

/** Where a found person came from, in words. */
const PERSON_SOURCE_LABELS: Partial<Record<SourceSlug, string>> = {
  companies_house: "Companies House director",
  company_website: "Named on company website",
};

function Tag({ children }: { children: React.ReactNode }) {
  return <span className="rounded-md bg-secondary px-2 py-0.5 text-xs text-muted-foreground">{children}</span>;
}

/** Dot on a contact button: green verified, red invalid, amber doubtful; none while unchecked. */
const CHECK_DOT: Partial<Record<ContactCheck["state"], string>> = {
  valid: "bg-primary",
  invalid: "bg-destructive",
  disposable: "bg-destructive",
  accept_all: "bg-amber-500",
  webmail: "bg-amber-500",
};

function ContactLink({
  href,
  label,
  icon: Icon,
  external,
  check,
}: {
  href: string;
  label: string;
  icon: typeof MailIcon;
  external?: boolean;
  /** Verification state, shown as a dot and spelled out on hover. */
  check?: ContactCheck | null;
}) {
  const full = check ? `${label} · ${verificationText(check)}` : label;
  const dot = check && CHECK_DOT[check.state];
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <a
          href={href}
          aria-label={full}
          {...(external && { target: "_blank", rel: "noopener noreferrer" })}
          className="relative grid size-8 place-items-center rounded-md border text-muted-foreground transition-colors hover:border-primary/40 hover:bg-signal-tint hover:text-primary"
        >
          <Icon className="size-3.5" />
          {dot && <span className={cn("absolute -top-1 -right-1 size-2.5 rounded-full ring-2 ring-card", dot)} />}
        </a>
      </TooltipTrigger>
      <TooltipContent side="top">{full}</TooltipContent>
    </Tooltip>
  );
}

export function PersonRow({
  person,
  canEdit,
  onEdit,
  onRemove,
}: {
  person: CompanyPerson;
  canEdit: boolean;
  onEdit: () => void;
  onRemove: () => void;
}) {
  const names = useLookupNames();

  return (
    <li className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-center">
      <div className="flex min-w-0 flex-1 items-start gap-3">
        <span className="grid size-10 shrink-0 place-items-center rounded-full bg-foreground text-xs font-semibold text-background">
          {initials(person.name)}
        </span>
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <p className="truncate font-medium">{person.name}</p>
            <IdentityBadge level={person.identity} confidence={person.identityConfidence} />
          </div>
          <p className="truncate text-sm text-muted-foreground">{person.title ?? "Title unknown"}</p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {person.seniority !== "unknown" && <Tag>{SENIORITY_LABELS[person.seniority]}</Tag>}
            {person.jobFunction && <Tag>{names.jobFunction(person.jobFunction)}</Tag>}
            {person.relationship !== "employee" && <Tag>{RELATIONSHIP_LABELS[person.relationship]}</Tag>}
            {person.location && <Tag>{person.location}</Tag>}
            {person.source && <Tag>{PERSON_SOURCE_LABELS[person.source] ?? `From ${SOURCE_LABELS[person.source]}`}</Tag>}
          </div>
        </div>
      </div>

      <div className="flex items-center gap-1.5 pl-13 sm:pl-0">
        {person.email && (
          <ContactLink href={`mailto:${person.email}`} label={`Email ${person.email}`} icon={MailIcon} check={person.emailVerification} />
        )}
        {person.phone && (
          <ContactLink
            href={`tel:${person.phone.replace(/[^\d+]/g, "")}`}
            label={`Call ${person.phone}`}
            icon={PhoneIcon}
            check={person.phoneVerification}
          />
        )}
        {person.professionalUrl && (
          <ContactLink href={person.professionalUrl} label="Open profile" icon={LinkIcon} external />
        )}
        {canEdit && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" className="ml-1" aria-label={`Actions for ${person.name}`}>
                <MoreHorizontalIcon />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={onEdit}>
                <PencilIcon />
                Edit
              </DropdownMenuItem>
              <DropdownMenuItem variant="destructive" onSelect={onRemove}>
                <UserMinusIcon />
                Remove from company
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
    </li>
  );
}
