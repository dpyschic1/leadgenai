"use client";

import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { CheckIcon, CopyIcon, Loader2Icon } from "lucide-react";
import { toast } from "sonner";
import { ControlledField } from "@/components/forms/controlled-field";
import { TextField } from "@/components/forms/text-field";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { FieldError } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { useInviteMember } from "@/hooks/use-team";
import { invitationUrl } from "@/lib/api/members";
import type { CreatedInvitation } from "@/lib/api/types";
import { INVITATION_TTL_DAYS } from "@/lib/domain/members";
import { applyApiError } from "@/lib/forms/apply-api-error";
import { inviteMemberSchema, type InviteMemberInput } from "@/lib/validation/members";
import { RoleSelect } from "./role-select";

/**
 * Invites a teammate, then shows the one-time link to send them. Also used for "New link":
 * pass `resend` and the email and role are filled in, so submitting replaces the old link.
 */
export function InviteMemberDialog({
  open,
  resend,
  onClose,
}: {
  open: boolean;
  resend?: InviteMemberInput;
  onClose: () => void;
}) {
  const [created, setCreated] = useState<CreatedInvitation | null>(null);
  const close = () => {
    setCreated(null);
    onClose();
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !next && close()}>
      <DialogContent>
        {created ? (
          <InvitationLink created={created} onDone={close} />
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>{resend ? "New invitation link" : "Invite a teammate"}</DialogTitle>
              <DialogDescription>
                {resend
                  ? "The old link stops working. Send the new one instead."
                  : "They'll get their own sign-in and work in this workspace with you."}
              </DialogDescription>
            </DialogHeader>
            {/* Mounted only while open, so it starts from fresh values each time. */}
            {open && <InviteForm defaults={resend} onCancel={close} onCreated={setCreated} />}
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function InviteForm({
  defaults,
  onCancel,
  onCreated,
}: {
  defaults?: InviteMemberInput;
  onCancel: () => void;
  onCreated: (created: CreatedInvitation) => void;
}) {
  const invite = useInviteMember();
  const form = useForm<InviteMemberInput>({
    resolver: zodResolver(inviteMemberSchema),
    defaultValues: defaults ?? { email: "", role: "member" },
  });

  const onSubmit = form.handleSubmit((values) =>
    invite.mutate(values, {
      onSuccess: onCreated,
      onError: (error) => applyApiError(error, form.setError, ["email", "role"]),
    }),
  );

  return (
    <form onSubmit={onSubmit} noValidate className="space-y-5">
      <TextField
        control={form.control}
        name="email"
        label="Email"
        type="email"
        placeholder="teammate@company.com"
        autoComplete="off"
        readOnly={defaults !== undefined}
        autoFocus={defaults === undefined}
      />
      <ControlledField control={form.control} name="role" label="Role">
        {({ field, id, invalid }) => <RoleSelect id={id} value={field.value} onChange={field.onChange} invalid={invalid} />}
      </ControlledField>
      {form.formState.errors.root && <FieldError>{form.formState.errors.root.message}</FieldError>}
      <DialogFooter>
        <Button type="button" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" disabled={invite.isPending} aria-busy={invite.isPending}>
          {invite.isPending && <Loader2Icon className="animate-spin" />}
          {defaults ? "Create new link" : "Create invitation"}
        </Button>
      </DialogFooter>
    </form>
  );
}

function InvitationLink({ created, onDone }: { created: CreatedInvitation; onDone: () => void }) {
  const url = invitationUrl(created.token);
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      toast.success("Link copied.");
    } catch {
      toast.error("Couldn't copy. Select the link and copy it yourself.");
    }
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>Send this link to {created.invitation.email}</DialogTitle>
        <DialogDescription>
          It works once and expires in {INVITATION_TTL_DAYS} days. For security it&apos;s only shown now; if it gets lost,
          create a new one from the team list.
        </DialogDescription>
      </DialogHeader>
      <div className="flex gap-2">
        <Input value={url} readOnly aria-label="Invitation link" className="h-10 font-mono text-xs" onFocus={(e) => e.target.select()} />
        <Button type="button" onClick={copy} className="h-10 shrink-0">
          {copied ? <CheckIcon /> : <CopyIcon />}
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onDone}>
          Done
        </Button>
      </DialogFooter>
    </>
  );
}
