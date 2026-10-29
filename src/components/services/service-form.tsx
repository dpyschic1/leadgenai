"use client";

import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { toast } from "sonner";
import { EditorBody, EditorFooter, FormSection } from "@/components/forms/editor-sheet";
import { FieldError } from "@/components/ui/field";
import { useCreateService, useUpdateService } from "@/hooks/use-services";
import type { Service } from "@/lib/api/types";
import { applyApiError } from "@/lib/forms/apply-api-error";
import { serviceSchema, type ServiceInput, type ServiceValues } from "@/lib/validation/services";
import { ServiceBasicsFields, ServiceTargetingFields } from "./service-fields";

const FIELDS = [
  "name",
  "description",
  "categories",
  "targetIndustries",
  "targetJobFunctions",
  "targetCountries",
  "companySizeMin",
  "companySizeMax",
] as const;

const EMPTY: ServiceInput = {
  name: "",
  description: "",
  categories: [],
  targetIndustries: [],
  targetJobFunctions: [],
  targetCountries: [],
  companySizeMin: null,
  companySizeMax: null,
};

function toFormValues(service: Service): ServiceInput {
  return {
    name: service.name,
    description: service.description,
    categories: service.categories,
    targetIndustries: service.targetIndustries,
    targetJobFunctions: service.targetJobFunctions,
    targetCountries: service.targetCountries,
    companySizeMin: service.companySizeMin,
    companySizeMax: service.companySizeMax,
  };
}

/** Creates a service, or edits `service` when given. Calls `onDone` after a successful save. */
export function ServiceForm({
  service,
  onDone,
  onCancel,
}: {
  service?: Service;
  onDone: () => void;
  onCancel: () => void;
}) {
  const form = useForm<ServiceInput, unknown, ServiceValues>({
    resolver: zodResolver(serviceSchema),
    defaultValues: service ? toFormValues(service) : EMPTY,
  });
  const create = useCreateService();
  const update = useUpdateService();

  const onSubmit = form.handleSubmit((values) => {
    const options = {
      onSuccess: (saved: Service) => {
        toast.success(service ? `Saved ${saved.name}.` : `Added ${saved.name}.`);
        onDone();
      },
      onError: (error: unknown) => applyApiError(error, form.setError, FIELDS),
    };
    if (service) update.mutate({ id: service.id, input: values }, options);
    else create.mutate(values, options);
  });

  return (
    <form onSubmit={onSubmit} noValidate className="flex min-h-0 flex-1 flex-col">
      <EditorBody>
        <FormSection title="What you sell" description="Used to match signals to this service.">
          <ServiceBasicsFields control={form.control} />
        </FormSection>
        <FormSection title="Who you sell to" description="Your ideal customer. Leave anything blank to match all.">
          <ServiceTargetingFields control={form.control} />
        </FormSection>
        {form.formState.errors.root && <FieldError>{form.formState.errors.root.message}</FieldError>}
      </EditorBody>
      <EditorFooter
        submitLabel={service ? "Save changes" : "Add service"}
        pending={create.isPending || update.isPending}
        onCancel={onCancel}
      />
    </form>
  );
}
