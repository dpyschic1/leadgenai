"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { SubmitButton } from "@/components/forms/submit-button";
import { TextField } from "@/components/forms/text-field";
import { Button } from "@/components/ui/button";
import { FieldError, FieldGroup } from "@/components/ui/field";
import { Skeleton } from "@/components/ui/skeleton";
import { useAcceptInvitation, useInvitationPreview } from "@/hooks/use-invitation";
import type { InvitationPreview } from "@/lib/api/types";
import { ROLE_DESCRIPTIONS, ROLE_LABELS } from "@/lib/domain/members";
import { applyApiError } from "@/lib/forms/apply-api-error";
import {
  acceptAsExistingUserSchema,
  acceptAsNewUserSchema,
  type AcceptAsExistingUserInput,
  type AcceptAsNewUserInput,
} from "@/lib/validation/members";
import { AuthHeading } from "./auth-heading";

/**
 * Full-page navigation into the workspace: whoever used this browser before (maybe another
 * account) leaves nothing behind in the query cache.
 */
const enterWorkspace = () => window.location.replace("/");

export function AcceptInvitation() {
  const { token } = useParams<{ token: string }>();
  const { data: invitation, error } = useInvitationPreview(token);

  if (error) return <InvalidInvitation message={error.message} />;
  if (!invitation) return <AcceptInvitationSkeleton />;

  return (
    <>
      <AuthHeading
        title={`Join ${invitation.workspaceName}`}
        description={`${invitation.invitedBy ?? "A teammate"} invited you as ${ROLE_LABELS[invitation.role].toLowerCase()}: ${ROLE_DESCRIPTIONS[invitation.role].toLowerCase()}`}
      />
      <div className="mb-6 rounded-lg border bg-card px-4 py-3">
        <p className="text-xs text-muted-foreground">Joining as</p>
        <p className="truncate text-sm font-medium">{invitation.email}</p>
      </div>
      {invitation.accountExists ? (
        <ExistingAccountForm token={token} invitation={invitation} />
      ) : (
        <NewAccountForm token={token} />
      )}
    </>
  );
}

function NewAccountForm({ token }: { token: string }) {
  const accept = useAcceptInvitation(token);
  const form = useForm<AcceptAsNewUserInput>({
    resolver: zodResolver(acceptAsNewUserSchema),
    defaultValues: { name: "", password: "" },
  });

  const onSubmit = form.handleSubmit((values) =>
    accept.mutate(values, {
      onSuccess: enterWorkspace,
      onError: (error) => applyApiError(error, form.setError, ["name", "password"]),
    }),
  );

  return (
    <form onSubmit={onSubmit} noValidate>
      <FieldGroup>
        <TextField control={form.control} name="name" label="Your name" autoComplete="name" autoFocus />
        <TextField
          control={form.control}
          name="password"
          label="Choose a password"
          type="password"
          autoComplete="new-password"
          description="At least 8 characters."
        />
        {form.formState.errors.root && <FieldError>{form.formState.errors.root.message}</FieldError>}
        <SubmitButton pending={accept.isPending} pendingLabel="Joining…">
          Join workspace
        </SubmitButton>
      </FieldGroup>
    </form>
  );
}

function ExistingAccountForm({ token, invitation }: { token: string; invitation: InvitationPreview }) {
  const accept = useAcceptInvitation(token);
  const form = useForm<AcceptAsExistingUserInput>({
    resolver: zodResolver(acceptAsExistingUserSchema),
    defaultValues: { password: "" },
  });

  const onSubmit = form.handleSubmit((values) =>
    accept.mutate(values, {
      onSuccess: enterWorkspace,
      onError: (error) => applyApiError(error, form.setError, ["password"]),
    }),
  );

  return (
    <form onSubmit={onSubmit} noValidate>
      <FieldGroup>
        <p className="text-sm text-muted-foreground">
          You already have a LeadGenAI account. Enter its password to add {invitation.workspaceName} to it.
        </p>
        <TextField
          control={form.control}
          name="password"
          label="Password"
          type="password"
          autoComplete="current-password"
          autoFocus
        />
        {form.formState.errors.root && <FieldError>{form.formState.errors.root.message}</FieldError>}
        <SubmitButton pending={accept.isPending} pendingLabel="Joining…">
          Join workspace
        </SubmitButton>
      </FieldGroup>
    </form>
  );
}

function InvalidInvitation({ message }: { message: string }) {
  return (
    <>
      <AuthHeading title="This invitation can't be used" description={message} />
      <Button asChild variant="outline" className="h-10 w-full">
        <Link href="/login">Go to sign in</Link>
      </Button>
    </>
  );
}

export function AcceptInvitationSkeleton() {
  return (
    <div className="space-y-6" aria-label="Loading invitation">
      <div className="space-y-2">
        <Skeleton className="h-7 w-56" />
        <Skeleton className="h-4 w-full" />
      </div>
      <Skeleton className="h-14 w-full rounded-lg" />
      <Skeleton className="h-10 w-full rounded-lg" />
      <Skeleton className="h-10 w-full rounded-lg" />
    </div>
  );
}
