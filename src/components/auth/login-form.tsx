"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { SubmitButton } from "@/components/forms/submit-button";
import { TextField } from "@/components/forms/text-field";
import { FieldError, FieldGroup } from "@/components/ui/field";
import { useLogin } from "@/hooks/use-auth";
import { applyApiError } from "@/lib/forms/apply-api-error";
import { loginSchema, type LoginInput } from "@/lib/validation/auth";
import { AuthHeading } from "./auth-heading";

export function LoginForm() {
  const router = useRouter();
  const login = useLogin();
  const form = useForm<LoginInput>({
    resolver: zodResolver(loginSchema),
    defaultValues: { email: "", password: "" },
  });

  const onSubmit = form.handleSubmit((values) =>
    login.mutate(values, {
      onSuccess: () => router.replace("/"),
      onError: (error) => applyApiError(error, form.setError, ["email", "password"]),
    }),
  );

  return (
    <>
      <AuthHeading title="Welcome back" description="Sign in to see what changed since your last visit." />
      <form onSubmit={onSubmit} noValidate>
        <FieldGroup>
          <TextField control={form.control} name="email" label="Work email" type="email" autoComplete="email" />
          <TextField
            control={form.control}
            name="password"
            label="Password"
            type="password"
            autoComplete="current-password"
          />
          {form.formState.errors.root && <FieldError>{form.formState.errors.root.message}</FieldError>}
          <SubmitButton pending={login.isPending} pendingLabel="Signing in…">
            Sign in
          </SubmitButton>
        </FieldGroup>
      </form>
      <p className="mt-6 text-sm text-muted-foreground">
        New to LeadGenAI?{" "}
        <Link href="/signup" className="font-medium text-primary hover:underline underline-offset-4">
          Create a workspace
        </Link>
      </p>
    </>
  );
}
