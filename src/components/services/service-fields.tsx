"use client";

import { useId, useMemo } from "react";
import { Controller, useFormState, type Control } from "react-hook-form";
import { ChipSelect, type Option } from "@/components/forms/chip-select";
import { ControlledField } from "@/components/forms/controlled-field";
import { MultiCombobox } from "@/components/forms/multi-combobox";
import { TextField } from "@/components/forms/text-field";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { useReferenceData } from "@/hooks/use-reference-data";
import type { LookupOption } from "@/lib/api/types";
import { COUNTRY_CODES, countryName } from "@/lib/countries";
import type { ServiceInput } from "@/lib/validation/services";

/** Form sections for a service, used by the add/edit service panel. */

type Props = { control: Control<ServiceInput> };

const toOptions = (rows: LookupOption[]): Option[] => rows.map((row) => ({ value: row.slug, label: row.name }));

function ChipsSkeleton({ count }: { count: number }) {
  return (
    <div className="flex flex-wrap gap-2" aria-label="Loading options">
      {Array.from({ length: count }, (_, index) => (
        <Skeleton key={index} className="h-8 rounded-full" style={{ width: `${70 + ((index * 37) % 70)}px` }} />
      ))}
    </div>
  );
}

/** What the service is: name, description and categories. */
export function ServiceBasicsFields({ control }: Props) {
  const { data } = useReferenceData();
  const categories = useMemo(() => (data ? toOptions(data.serviceCategories) : []), [data]);

  return (
    <FieldGroup>
      <TextField
        control={control}
        name="name"
        label="Service name"
        placeholder="e.g. Website redesign"
        autoComplete="off"
      />
      <ControlledField
        control={control}
        name="description"
        label="What does it include?"
        optional
        description="A sentence or two. It helps match signals to this service."
      >
        {({ field, id, invalid, describedBy }) => (
          <Textarea
            {...field}
            id={id}
            rows={3}
            aria-invalid={invalid}
            aria-describedby={describedBy}
            placeholder="e.g. Conversion-focused websites for professional-services firms, from design to launch."
          />
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
            <ChipsSkeleton count={14} />
          )
        }
      </ControlledField>
    </FieldGroup>
  );
}

/** Who the service is sold to. Every list is optional: empty means "any". */
export function ServiceTargetingFields({ control }: Props) {
  const { data } = useReferenceData();
  const industries = useMemo(() => (data ? toOptions(data.industries) : []), [data]);
  const jobFunctions = useMemo(() => (data ? toOptions(data.jobFunctions) : []), [data]);
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
        name="targetJobFunctions"
        label="Buyer roles"
        optional
        description="The people who usually decide to buy this."
      >
        {({ field, id, invalid, describedBy }) =>
          data ? (
            <ChipSelect
              id={id}
              options={jobFunctions}
              value={field.value}
              onChange={field.onChange}
              invalid={invalid}
              describedBy={describedBy}
            />
          ) : (
            <ChipsSkeleton count={10} />
          )
        }
      </ControlledField>

      <div className="grid gap-6 sm:grid-cols-2">
        <ControlledField control={control} name="targetIndustries" label="Industries" optional>
          {({ field, id, invalid, describedBy }) =>
            data ? (
              <MultiCombobox
                id={id}
                options={industries}
                value={field.value}
                onChange={field.onChange}
                invalid={invalid}
                describedBy={describedBy}
                placeholder="Any industry"
                searchPlaceholder="Search industries"
                emptyText="No industry matches."
              />
            ) : (
              <Skeleton className="h-10 rounded-lg" />
            )
          }
        </ControlledField>
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
      </div>

      <CompanySizeRange control={control} />
    </FieldGroup>
  );
}

/** Min and max employee count as one field: one label, two inputs, errors for either below. */
function CompanySizeRange({ control }: Props) {
  const id = useId();
  const { errors } = useFormState({ control, name: ["companySizeMin", "companySizeMax"] });
  const fieldErrors = [errors.companySizeMin, errors.companySizeMax].filter(Boolean);

  return (
    <Field data-invalid={fieldErrors.length > 0}>
      <FieldLabel htmlFor={`${id}-min`}>
        Company size
        <span className="font-normal text-muted-foreground">Optional</span>
      </FieldLabel>
      <FieldDescription id={`${id}-hint`}>Number of employees.</FieldDescription>
      <div className="flex items-center gap-3">
        <SizeInput control={control} name="companySizeMin" id={`${id}-min`} label="Minimum employees" placeholder="Min, e.g. 10" hintId={`${id}-hint`} />
        <span className="text-sm text-muted-foreground">to</span>
        <SizeInput control={control} name="companySizeMax" id={`${id}-max`} label="Maximum employees" placeholder="Max, e.g. 500" hintId={`${id}-hint`} />
      </div>
      {fieldErrors.length > 0 && <FieldError errors={fieldErrors} />}
    </Field>
  );
}

function SizeInput({
  control,
  name,
  id,
  label,
  placeholder,
  hintId,
}: Props & { name: "companySizeMin" | "companySizeMax"; id: string; label: string; placeholder: string; hintId: string }) {
  return (
    <Controller
      control={control}
      name={name}
      render={({ field, fieldState }) => (
        <Input
          id={id}
          name={field.name}
          ref={field.ref}
          onBlur={field.onBlur}
          type="number"
          inputMode="numeric"
          min={1}
          className="h-10"
          placeholder={placeholder}
          aria-label={label}
          aria-invalid={fieldState.invalid}
          aria-describedby={hintId}
          value={field.value ?? ""}
          onChange={(event) => field.onChange(event.target.value === "" ? null : event.target.valueAsNumber)}
        />
      )}
    />
  );
}
