"use client";

import { useMemo } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { toast } from "sonner";
import { Combobox } from "@/components/forms/combobox";
import { ControlledField } from "@/components/forms/controlled-field";
import { EditorBody, EditorFooter, FormSection } from "@/components/forms/editor-sheet";
import { TextField } from "@/components/forms/text-field";
import { FieldError, FieldGroup } from "@/components/ui/field";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useSavePerson } from "@/hooks/use-companies";
import { useReferenceData } from "@/hooks/use-reference-data";
import type { CompanyPerson } from "@/lib/api/types";
import {
  COMPANY_RELATIONSHIPS,
  RELATIONSHIP_LABELS,
  SENIORITY_LABELS,
  SENIORITY_LEVELS,
} from "@/lib/domain/people";
import { applyApiError } from "@/lib/forms/apply-api-error";
import { personSchema, type PersonInput, type PersonValues } from "@/lib/validation/companies";

const FIELDS = [
  "name",
  "title",
  "seniority",
  "jobFunction",
  "relationship",
  "email",
  "phone",
  "professionalUrl",
  "location",
] as const;

const EMPTY: PersonInput = {
  name: "",
  title: "",
  seniority: "unknown",
  jobFunction: null,
  relationship: "employee",
  email: "",
  phone: "",
  professionalUrl: "",
  location: "",
};

function toFormValues(person: CompanyPerson): PersonInput {
  return {
    name: person.name,
    title: person.title ?? "",
    seniority: person.seniority,
    jobFunction: person.jobFunction,
    relationship: person.relationship,
    email: person.email ?? "",
    phone: person.phone ?? "",
    professionalUrl: person.professionalUrl ?? "",
    location: person.location ?? "",
  };
}

/** Adds a person to the company, or edits `person` when given. */
export function PersonForm({
  companyId,
  companyName,
  person,
  onDone,
  onCancel,
}: {
  companyId: string;
  companyName: string;
  person?: CompanyPerson;
  onDone: () => void;
  onCancel: () => void;
}) {
  const { data: ref } = useReferenceData();
  const jobFunctions = useMemo(() => ref?.jobFunctions.map((j) => ({ value: j.slug, label: j.name })) ?? [], [ref]);
  const form = useForm<PersonInput, unknown, PersonValues>({
    resolver: zodResolver(personSchema),
    defaultValues: person ? toFormValues(person) : EMPTY,
  });
  const save = useSavePerson(companyId);

  const onSubmit = form.handleSubmit((values) =>
    save.mutate(
      { personId: person?.id, input: values },
      {
        onSuccess: () => {
          toast.success(person ? `Saved ${values.name}.` : `Added ${values.name} to ${companyName}.`);
          onDone();
        },
        onError: (error) => applyApiError(error, form.setError, FIELDS),
      },
    ),
  );

  return (
    <form onSubmit={onSubmit} noValidate className="flex min-h-0 flex-1 flex-col">
      <EditorBody>
        <FormSection title="Role" description={`Who they are at ${companyName}.`}>
          <FieldGroup>
            <div className="grid gap-6 sm:grid-cols-2">
              <TextField control={form.control} name="name" label="Full name" placeholder="e.g. Emma Hartley" autoComplete="off" />
              <TextField control={form.control} name="title" label="Job title" placeholder="e.g. Managing Partner" autoComplete="off" />
            </div>
            <div className="grid gap-6 sm:grid-cols-3">
              <ControlledField control={form.control} name="seniority" label="Seniority">
                {({ field, id, invalid }) => (
                  <Select value={field.value} onValueChange={field.onChange}>
                    <SelectTrigger id={id} aria-invalid={invalid} className="h-10! w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {SENIORITY_LEVELS.map((level) => (
                        <SelectItem key={level} value={level}>
                          {SENIORITY_LABELS[level]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              </ControlledField>
              <ControlledField control={form.control} name="jobFunction" label="Department" optional>
                {({ field, id, invalid }) => (
                  <Combobox
                    id={id}
                    options={jobFunctions}
                    value={field.value}
                    onChange={field.onChange}
                    invalid={invalid}
                    placeholder="Select"
                    searchPlaceholder="Search departments"
                    emptyText="No department matches."
                  />
                )}
              </ControlledField>
              <ControlledField control={form.control} name="relationship" label="Relationship">
                {({ field, id, invalid }) => (
                  <Select value={field.value} onValueChange={field.onChange}>
                    <SelectTrigger id={id} aria-invalid={invalid} className="h-10! w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {COMPANY_RELATIONSHIPS.map((relationship) => (
                        <SelectItem key={relationship} value={relationship}>
                          {RELATIONSHIP_LABELS[relationship]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              </ControlledField>
            </div>
          </FieldGroup>
        </FormSection>

        <FormSection title="Contact" description="Business contact details only. Leave blank if you don't have them.">
          <FieldGroup>
            <div className="grid gap-6 sm:grid-cols-2">
              <TextField control={form.control} name="email" label="Work email" type="email" placeholder="emma@hartleyco.co.uk" autoComplete="off" />
              <TextField control={form.control} name="phone" label="Phone" type="tel" placeholder="+44 113 496 0000" autoComplete="off" />
            </div>
            <div className="grid gap-6 sm:grid-cols-2">
              <TextField
                control={form.control}
                name="professionalUrl"
                label="Profile link"
                placeholder="https://www.linkedin.com/in/…"
                autoComplete="off"
              />
              <TextField control={form.control} name="location" label="Location" placeholder="Leeds, UK" autoComplete="off" />
            </div>
          </FieldGroup>
        </FormSection>
        {form.formState.errors.root && <FieldError>{form.formState.errors.root.message}</FieldError>}
      </EditorBody>
      <EditorFooter submitLabel={person ? "Save changes" : "Add person"} pending={save.isPending} onCancel={onCancel} />
    </form>
  );
}
