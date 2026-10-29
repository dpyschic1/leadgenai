"use client";

import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Loader2Icon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
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

function Section({ title, description, children }: { title: string; description: string; children: React.ReactNode }) {
  return (
    <section className="space-y-5">
      <div>
        <h3 className="font-semibold">{title}</h3>
        <p className="mt-0.5 text-sm text-muted-foreground">{description}</p>
      </div>
      {children}
    </section>
  );
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
  const pending = create.isPending || update.isPending;

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
      <div className="flex-1 space-y-8 overflow-y-auto px-6 py-6">
        <Section title="What you sell" description="Used to match signals to this service.">
          <ServiceBasicsFields control={form.control} />
        </Section>
        <div className="border-t" />
        <Section title="Who you sell to" description="Your ideal customer. Leave anything blank to match all.">
          <ServiceTargetingFields control={form.control} />
        </Section>
        {form.formState.errors.root && <FieldError>{form.formState.errors.root.message}</FieldError>}
      </div>
      <div className="flex justify-end gap-2 border-t bg-background px-6 py-4">
        <Button type="button" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" disabled={pending} aria-busy={pending}>
          {pending && <Loader2Icon className="animate-spin" />}
          {service ? "Save changes" : "Add service"}
        </Button>
      </div>
    </form>
  );
}
