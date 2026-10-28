"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { TextField } from "@/components/forms/text-field";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { FieldError, FieldGroup } from "@/components/ui/field";
import { useRegister } from "@/hooks/use-auth";
import { applyApiError } from "@/lib/forms/apply-api-error";
import { registerSchema, type RegisterInput } from "@/lib/validation/auth";

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
    <Card>
      <CardHeader>
        <CardTitle>Create your workspace</CardTitle>
        <CardDescription>Start finding evidence-backed opportunities.</CardDescription>
      </CardHeader>
      <form onSubmit={onSubmit} noValidate>
        <CardContent>
          <FieldGroup>
            <TextField control={form.control} name="name" label="Your name" autoComplete="name" />
            <TextField control={form.control} name="email" label="Work email" type="email" autoComplete="email" />
            <TextField
              control={form.control}
              name="password"
              label="Password"
              type="password"
              autoComplete="new-password"
            />
            <TextField
              control={form.control}
              name="workspaceName"
              label="Company / workspace name"
              autoComplete="organization"
            />
            {form.formState.errors.root && <FieldError>{form.formState.errors.root.message}</FieldError>}
          </FieldGroup>
        </CardContent>
        <CardFooter className="mt-6 flex flex-col gap-3">
          <Button type="submit" className="w-full" disabled={register.isPending}>
            {register.isPending ? "Creating workspace…" : "Create workspace"}
          </Button>
          <p className="text-sm text-muted-foreground">
            Already have an account?{" "}
            <Link href="/login" className="text-foreground underline underline-offset-4">
              Sign in
            </Link>
          </p>
        </CardFooter>
      </form>
    </Card>
  );
}
