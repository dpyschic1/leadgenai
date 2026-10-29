"use client";

import { useId, type ReactNode } from "react";
import {
  Controller,
  type Control,
  type ControllerRenderProps,
  type FieldPath,
  type FieldValues,
} from "react-hook-form";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";

type ControlProps<T extends FieldValues, N extends FieldPath<T>> = {
  field: ControllerRenderProps<T, N>;
  id: string;
  invalid: boolean;
  describedBy?: string;
};

/**
 * Label, optional hint and error around any custom control bound to react-hook-form.
 * Use `TextField` for plain text inputs; this is for chips, multi-selects, sliders and similar.
 */
export function ControlledField<T extends FieldValues, N extends FieldPath<T>, TOutput extends FieldValues = T>({
  control,
  name,
  label,
  description,
  optional,
  children,
}: {
  control: Control<T, unknown, TOutput>;
  name: N;
  label: string;
  description?: string;
  optional?: boolean;
  children: (props: ControlProps<T, N>) => ReactNode;
}) {
  const id = useId();
  const descriptionId = description ? `${id}-description` : undefined;

  return (
    <Controller
      control={control}
      name={name}
      render={({ field, fieldState }) => (
        <Field data-invalid={fieldState.invalid}>
          <FieldLabel htmlFor={id}>
            {label}
            {optional && <span className="font-normal text-muted-foreground">Optional</span>}
          </FieldLabel>
          {description && <FieldDescription id={descriptionId}>{description}</FieldDescription>}
          {children({ field, id, invalid: fieldState.invalid, describedBy: descriptionId })}
          {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
        </Field>
      )}
    />
  );
}
