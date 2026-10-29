"use client";

import { useId, type ComponentProps } from "react";
import { Controller, type Control, type FieldValues, type Path } from "react-hook-form";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";

type TextFieldProps<T extends FieldValues, TOutput extends FieldValues> = {
  /** Accepts forms whose resolver transforms values (input type T, output type TOutput). */
  control: Control<T, unknown, TOutput>;
  name: Path<T>;
  label: string;
  /** Hint shown under the input, e.g. password rules. */
  description?: string;
} & Omit<ComponentProps<typeof Input>, "name" | "id" | "value" | "onChange" | "onBlur">;

/** A labelled text input bound to react-hook-form, with accessible hint and error display. */
export function TextField<T extends FieldValues, TOutput extends FieldValues = T>({
  control,
  name,
  label,
  description,
  ...inputProps
}: TextFieldProps<T, TOutput>) {
  const id = useId();
  const descriptionId = `${id}-description`;

  return (
    <Controller
      control={control}
      name={name}
      render={({ field, fieldState }) => (
        <Field data-invalid={fieldState.invalid}>
          <FieldLabel htmlFor={id}>{label}</FieldLabel>
          <Input
            {...inputProps}
            {...field}
            id={id}
            className="h-10"
            aria-invalid={fieldState.invalid}
            aria-describedby={description ? descriptionId : undefined}
          />
          {description && <FieldDescription id={descriptionId}>{description}</FieldDescription>}
          {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
        </Field>
      )}
    />
  );
}
