"use client";

import { useMemo } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { toast } from "sonner";
import { Combobox } from "@/components/forms/combobox";
import { ControlledField } from "@/components/forms/controlled-field";
import { EditorBody, EditorFooter, FormSection } from "@/components/forms/editor-sheet";
import { NumberInput } from "@/components/forms/number-input";
import { TextField } from "@/components/forms/text-field";
import { FieldError, FieldGroup } from "@/components/ui/field";
import { Textarea } from "@/components/ui/textarea";
import { useCreateCompany, useUpdateCompany } from "@/hooks/use-companies";
import { useReferenceData } from "@/hooks/use-reference-data";
import type { CompanyDetail } from "@/lib/api/types";
import { COUNTRY_CODES, countryName } from "@/lib/countries";
import { applyApiError } from "@/lib/forms/apply-api-error";
import { companySchema, type CompanyInput, type CompanyValues } from "@/lib/validation/companies";

const FIELDS = [
  "name",
  "domain",
  "industry",
  "employeeCount",
  "description",
  "hqCity",
  "hqRegion",
  "hqCountry",
] as const;

const EMPTY: CompanyInput = {
  name: "",
  domain: "",
  industry: null,
  employeeCount: null,
  description: "",
  hqCity: "",
  hqRegion: "",
  hqCountry: null,
};

function toFormValues(company: CompanyDetail): CompanyInput {
  const hq = company.locations.find((location) => location.type === "headquarters");
  return {
    name: company.name,
    domain: company.domain ?? "",
    industry: company.industry,
    employeeCount: company.employeeCount,
    description: company.description ?? "",
    hqCity: hq?.city ?? "",
    hqRegion: hq?.region ?? "",
    hqCountry: (hq?.country as CompanyInput["hqCountry"]) ?? null,
  };
}

/** Adds a company, or edits `company` when given. `onDone` receives the saved company. */
export function CompanyForm({
  company,
  onDone,
  onCancel,
}: {
  company?: CompanyDetail;
  onDone: (saved: CompanyDetail) => void;
  onCancel: () => void;
}) {
  const { data: ref } = useReferenceData();
  const industries = useMemo(() => ref?.industries.map((i) => ({ value: i.slug, label: i.name })) ?? [], [ref]);
  const countries = useMemo(
    () =>
      COUNTRY_CODES.map((code) => ({ value: code, label: countryName(code) })).sort((a, b) =>
        a.label.localeCompare(b.label),
      ),
    [],
  );

  const form = useForm<CompanyInput, unknown, CompanyValues>({
    resolver: zodResolver(companySchema),
    defaultValues: company ? toFormValues(company) : EMPTY,
  });
  const create = useCreateCompany();
  const update = useUpdateCompany(company?.id ?? "");

  const onSubmit = form.handleSubmit((values) => {
    const options = {
      onSuccess: (saved: CompanyDetail) => {
        toast.success(company ? `Saved ${saved.name}.` : `Added ${saved.name}.`);
        onDone(saved);
      },
      onError: (error: unknown) => applyApiError(error, form.setError, FIELDS),
    };
    if (company) update.mutate(values, options);
    else create.mutate(values, options);
  });

  return (
    <form onSubmit={onSubmit} noValidate className="flex min-h-0 flex-1 flex-col">
      <EditorBody>
        <FormSection title="Company" description="The basics you'd find on their website or profile.">
          <FieldGroup>
            <TextField control={form.control} name="name" label="Company name" placeholder="e.g. Hartley & Co Accountants" autoComplete="off" />
            <div className="grid gap-6 sm:grid-cols-2">
              <TextField
                control={form.control}
                name="domain"
                label="Website"
                placeholder="hartleyco.co.uk"
                description="Optional. Paste any link to their site; we keep just the domain."
                autoComplete="off"
              />
              <ControlledField control={form.control} name="industry" label="Industry" optional>
                {({ field, id, invalid, describedBy }) => (
                  <Combobox
                    id={id}
                    options={industries}
                    value={field.value}
                    onChange={field.onChange}
                    invalid={invalid}
                    describedBy={describedBy}
                    placeholder="Select an industry"
                    searchPlaceholder="Search industries"
                    emptyText="No industry matches."
                  />
                )}
              </ControlledField>
            </div>
            <ControlledField control={form.control} name="employeeCount" label="Employees" optional description="Approximate headcount.">
              {({ field, id, invalid, describedBy }) => (
                <NumberInput
                  id={id}
                  name={field.name}
                  ref={field.ref}
                  onBlur={field.onBlur}
                  value={field.value}
                  onChange={field.onChange}
                  placeholder="e.g. 45"
                  aria-invalid={invalid}
                  aria-describedby={describedBy}
                  className="sm:max-w-48"
                />
              )}
            </ControlledField>
            <ControlledField control={form.control} name="description" label="About" optional>
              {({ field, id, invalid, describedBy }) => (
                <Textarea
                  {...field}
                  value={field.value ?? ""}
                  id={id}
                  rows={3}
                  aria-invalid={invalid}
                  aria-describedby={describedBy}
                  placeholder="What they do, who they serve, anything worth remembering."
                />
              )}
            </ControlledField>
          </FieldGroup>
        </FormSection>

        <FormSection title="Headquarters" description="Where the company is based. Leave blank if unknown.">
          <div className="grid gap-6 sm:grid-cols-3">
            <TextField control={form.control} name="hqCity" label="City" placeholder="Leeds" autoComplete="off" />
            <TextField control={form.control} name="hqRegion" label="Region" placeholder="West Yorkshire" autoComplete="off" />
            <ControlledField control={form.control} name="hqCountry" label="Country">
              {({ field, id, invalid, describedBy }) => (
                <Combobox
                  id={id}
                  options={countries}
                  value={field.value}
                  onChange={field.onChange}
                  invalid={invalid}
                  describedBy={describedBy}
                  placeholder="Select"
                  searchPlaceholder="Search countries"
                  emptyText="No country matches."
                />
              )}
            </ControlledField>
          </div>
        </FormSection>
        {form.formState.errors.root && <FieldError>{form.formState.errors.root.message}</FieldError>}
      </EditorBody>
      <EditorFooter
        submitLabel={company ? "Save changes" : "Add company"}
        pending={create.isPending || update.isPending}
        onCancel={onCancel}
      />
    </form>
  );
}
