"use client";

import { useId, useMemo } from "react";
import { Loader2Icon, SparklesIcon } from "lucide-react";
import { useController, useFormState, useWatch, type Control } from "react-hook-form";
import { toast } from "sonner";
import { ChipSelect, type Option } from "@/components/forms/chip-select";
import { ControlledField } from "@/components/forms/controlled-field";
import { MultiCombobox } from "@/components/forms/multi-combobox";
import { TextField } from "@/components/forms/text-field";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { useReferenceData } from "@/hooks/use-reference-data";
import { useDescribeService } from "@/hooks/use-services";
import { COUNTRY_CODES, countryName } from "@/lib/countries";
import {
  CLIENT_TYPE_LABELS,
  CLIENT_TYPES,
  SERVICE_FORM_CATEGORIES,
  SIZE_PRESETS,
  WORK_TYPE_LABELS,
  WORK_TYPES,
  type ServiceInput,
  type WorkType,
} from "@/lib/validation/services";

/** Form sections for a service, used by the add/edit service panel. */

type Props = { control: Control<ServiceInput> };

const CLIENT_TYPE_OPTIONS: Option[] = CLIENT_TYPES.map((type) => ({ value: type, label: CLIENT_TYPE_LABELS[type] }));

function ChipsSkeleton({ count }: { count: number }) {
  return (
    <div className="flex flex-wrap gap-2" aria-label="Loading options">
      {Array.from({ length: count }, (_, index) => (
        <Skeleton key={index} className="h-8 rounded-full" style={{ width: `${70 + ((index * 37) % 70)}px` }} />
      ))}
    </div>
  );
}

/** What the service is: name, description (typed, or drafted by the AI from the name) and categories. */
export function ServiceBasicsFields({ control }: Props) {
  const { data } = useReferenceData();
  const chosen = useWatch({ control, name: "categories" });
  // Development and AI categories; one a service was saved with earlier still shows, so it can be removed.
  const categories = useMemo(
    () =>
      (data?.serviceCategories ?? [])
        .filter((row) => SERVICE_FORM_CATEGORIES.includes(row.slug) || chosen?.includes(row.slug))
        .map((row) => ({ value: row.slug, label: row.name })),
    [data, chosen],
  );

  return (
    <FieldGroup>
      <TextField
        control={control}
        name="name"
        label="Service name"
        placeholder="e.g. AI chatbot development"
        autoComplete="off"
      />
      <ControlledField
        control={control}
        name="description"
        label="What does it include?"
        optional
        description="Type it, or let the AI write it from the service name and edit it."
      >
        {({ field, id, invalid, describedBy }) => (
          <div className="space-y-2">
            <Textarea
              {...field}
              id={id}
              rows={4}
              aria-invalid={invalid}
              aria-describedby={describedBy}
              placeholder="e.g. We build AI chatbots and assistants for startups and SaaS companies, from design to launch."
            />
            <WriteWithAi control={control} hasText={Boolean(field.value?.trim())} onWritten={field.onChange} />
          </div>
        )}
      </ControlledField>
      <ControlledField
        control={control}
        name="categories"
        label="Categories"
        description="Pick everything this service covers."
      >
        {({ field, id, invalid, describedBy }) =>
          data ? (
            <ChipSelect
              id={id}
              options={categories}
              value={field.value}
              onChange={field.onChange}
              invalid={invalid}
              describedBy={describedBy}
            />
          ) : (
            <ChipsSkeleton count={11} />
          )
        }
      </ControlledField>
    </FieldGroup>
  );
}

/** Drafts "What does it include?" from the service name (and categories, when picked). */
function WriteWithAi({ control, hasText, onWritten }: Props & { hasText: boolean; onWritten: (text: string) => void }) {
  const [name, categories] = useWatch({ control, name: ["name", "categories"] });
  const describe = useDescribeService();
  const ready = (name ?? "").trim().length >= 2;

  return (
    <div className="flex items-center gap-3">
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={!ready || describe.isPending}
        onClick={() =>
          describe.mutate(
            { name: name.trim(), categories: categories ?? [] },
            { onSuccess: (reply) => onWritten(reply.description), onError: (error) => toast.error(error.message) },
          )
        }
      >
        {describe.isPending ? <Loader2Icon className="animate-spin" /> : <SparklesIcon />}
        {describe.isPending ? "Writing…" : hasText ? "Rewrite with AI" : "Write with AI"}
      </Button>
      {!ready && <span className="text-xs text-muted-foreground">Enter the service name first.</span>}
    </div>
  );
}

/** Who the service is sold to. */
export function ServiceTargetingFields({ control }: Props) {
  const countries = useMemo(
    () =>
      COUNTRY_CODES.map((code) => ({ value: code, label: countryName(code) })).sort((a, b) =>
        a.label.localeCompare(b.label),
      ),
    [],
  );

  return (
    <FieldGroup>
      <ControlledField
        control={control}
        name="clientTypes"
        label="Client type"
        description="Companies: hiring and funding signals. Individuals: people asking for help in a post. Project-based: freelance projects."
      >
        {({ field, id, invalid, describedBy }) => (
          <ChipSelect
            id={id}
            options={CLIENT_TYPE_OPTIONS}
            value={field.value ?? []}
            onChange={field.onChange}
            invalid={invalid}
            describedBy={describedBy}
          />
        )}
      </ControlledField>

      <div className="grid gap-6 sm:grid-cols-2">
        <ControlledField
          control={control}
          name="workType"
          label="Work type"
          description="Matching jobs rank higher."
        >
          {({ field, id, describedBy }) => (
            <Select value={field.value ?? "any"} onValueChange={(value) => field.onChange(value as WorkType)}>
              <SelectTrigger id={id} aria-describedby={describedBy} className="h-10! w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {WORK_TYPES.map((type) => (
                  <SelectItem key={type} value={type}>
                    {WORK_TYPE_LABELS[type]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </ControlledField>
        <CompanySize control={control} />
      </div>

      <ControlledField control={control} name="targetCountries" label="Countries" optional>
        {({ field, id, invalid, describedBy }) => (
          <MultiCombobox
            id={id}
            options={countries}
            value={field.value}
            onChange={field.onChange}
            invalid={invalid}
            describedBy={describedBy}
            placeholder="Any country"
            searchPlaceholder="Search countries"
            emptyText="No country matches."
          />
        )}
      </ControlledField>
    </FieldGroup>
  );
}

/** Company size as one choice, stored as its employee range. A range saved earlier that isn't a choice shows as its own. */
function CompanySize({ control }: Props) {
  const id = useId();
  const min = useController({ control, name: "companySizeMin" });
  const max = useController({ control, name: "companySizeMax" });
  const { errors } = useFormState({ control, name: ["companySizeMin", "companySizeMax"] });
  const fieldErrors = [errors.companySizeMin, errors.companySizeMax].filter(Boolean);

  const preset = SIZE_PRESETS.find((p) => p.min === (min.field.value ?? null) && p.max === (max.field.value ?? null));
  const custom = preset ? null : customLabel(min.field.value ?? null, max.field.value ?? null);

  return (
    <Field data-invalid={fieldErrors.length > 0}>
      <FieldLabel htmlFor={id}>Company size</FieldLabel>
      <FieldDescription id={`${id}-hint`}>Far bigger or smaller are hidden.</FieldDescription>
      <Select
        value={preset?.value ?? "custom"}
        onValueChange={(value) => {
          const chosen = SIZE_PRESETS.find((p) => p.value === value);
          if (!chosen) return;
          min.field.onChange(chosen.min);
          max.field.onChange(chosen.max);
        }}
      >
        <SelectTrigger id={id} aria-describedby={`${id}-hint`} className="h-10! w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {SIZE_PRESETS.map((p) => (
            <SelectItem key={p.value} value={p.value}>
              {p.label}
            </SelectItem>
          ))}
          {custom && <SelectItem value="custom">{custom}</SelectItem>}
        </SelectContent>
      </Select>
      {fieldErrors.length > 0 && <FieldError errors={fieldErrors} />}
    </Field>
  );
}

function customLabel(min: number | null, max: number | null): string {
  const fmt = (n: number) => n.toLocaleString("en");
  if (min !== null && max !== null) return `${fmt(min)}–${fmt(max)} employees`;
  if (min !== null) return `${fmt(min)}+ employees`;
  return `Up to ${fmt(max!)} employees`;
}
