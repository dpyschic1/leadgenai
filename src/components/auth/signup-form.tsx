"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { SubmitButton } from "@/components/forms/submit-button";
import { TextField } from "@/components/forms/text-field";
import { FieldError, FieldGroup } from "@/components/ui/field";
import { useRegister } from "@/hooks/use-auth";
import { applyApiError } from "@/lib/forms/apply-api-error";
import { registerSchema, type RegisterInput } from "@/lib/validation/auth";
import { AuthHeading } from "./auth-heading";

const FIELDS = ["name", "email", "password", "workspaceName"] as const;

export function SignupForm() {
  const router = useRouter();
  const register = useRegister();
  const form = useForm<RegisterInput>({
    resolver: zodResolver(registerSchema),
    defaultValues: { name: "", email: "", password: "", workspaceName: "" },
  });

  const onSubmit = form.handleSubmit((values) =>
    register.mutate(values, {
      onSuccess: () => router.replace("/"),
      onError: (error) => applyApiError(error, form.setError, FIELDS),
    }),
  );

  return (
    <>
      <AuthHeading
        title="Create your workspace"
        description="Start with your account. You'll describe what you sell in the next step."
      />
      <form onSubmit={onSubmit} noValidate>
        <FieldGroup>
          <TextField control={form.control} name="name" label="Your name" autoComplete="name" />
          <TextField control={form.control} name="email" label="Work email" type="email" autoComplete="email" />
          <TextField
            control={form.control}
            name="password"
            label="Password"
            type="password"
            autoComplete="new-password"
            description="At least 8 characters."
          />
          <TextField
            control={form.control}
            name="workspaceName"
            label="Company name"
            autoComplete="organization"
          />
          {form.formState.errors.root && <FieldError>{form.formState.errors.root.message}</FieldError>}
          <SubmitButton pending={register.isPending} pendingLabel="Creating workspace…">
            Create workspace
          </SubmitButton>
        </FieldGroup>
      </form>
      <p className="mt-6 text-sm text-muted-foreground">
        Already have an account?{" "}
        <Link href="/login" className="font-medium text-primary hover:underline underline-offset-4">
          Sign in
        </Link>
      </p>
    </>
  );
}
