"use client";

import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Loader2Icon } from "lucide-react";
import { TextField } from "@/components/forms/text-field";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { FieldError } from "@/components/ui/field";
import { useCreateList, useRenameList } from "@/hooks/use-lists";
import type { SavedList } from "@/lib/api/types";
import { applyApiError } from "@/lib/forms/apply-api-error";
import { listSchema, type ListInput, type ListValues } from "@/lib/validation/lists";

/** Creates a list, or renames `list` when given. `onSaved` receives the saved list. */
export function ListNameDialog({
  open,
  list,
  onClose,
  onSaved,
}: {
  open: boolean;
  list?: SavedList;
  onClose: () => void;
  onSaved: (list: SavedList) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{list ? "Rename list" : "New list"}</DialogTitle>
          <DialogDescription>
            {list ? "Opportunities on it stay where they are." : "Group opportunities the way you work them, e.g. by service or next step."}
          </DialogDescription>
        </DialogHeader>
        {/* Mounted only while open, so it starts from fresh values each time. */}
        {open && <ListNameForm list={list} onCancel={onClose} onSaved={onSaved} />}
      </DialogContent>
    </Dialog>
  );
}

function ListNameForm({
  list,
  onCancel,
  onSaved,
}: {
  list?: SavedList;
  onCancel: () => void;
  onSaved: (list: SavedList) => void;
}) {
  const form = useForm<ListInput, unknown, ListValues>({
    resolver: zodResolver(listSchema),
    defaultValues: { name: list?.name ?? "" },
  });
  const create = useCreateList();
  const rename = useRenameList();
  const pending = create.isPending || rename.isPending;

  const onSubmit = form.handleSubmit((values) => {
    const options = { onSuccess: onSaved, onError: (error: unknown) => applyApiError(error, form.setError, ["name"]) };
    if (list) rename.mutate({ id: list.id, input: values }, options);
    else create.mutate(values, options);
  });

  return (
    <form onSubmit={onSubmit} noValidate className="space-y-5">
      <TextField control={form.control} name="name" label="Name" placeholder="e.g. Contact today" maxLength={60} autoFocus />
      {form.formState.errors.root && <FieldError>{form.formState.errors.root.message}</FieldError>}
      <DialogFooter>
        <Button type="button" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" disabled={pending} aria-busy={pending}>
          {pending && <Loader2Icon className="animate-spin" />}
          {list ? "Save" : "Create list"}
        </Button>
      </DialogFooter>
    </form>
  );
}
