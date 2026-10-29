"use client";

import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Loader2Icon } from "lucide-react";
import { toast } from "sonner";
import { TextField } from "@/components/forms/text-field";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useCurrentUser } from "@/hooks/use-current-user";
import { usePermission } from "@/hooks/use-permission";
import { useUpdateWorkspace } from "@/hooks/use-update-workspace";
import type { Me } from "@/lib/api/types";
import { applyApiError } from "@/lib/forms/apply-api-error";
import { ADMIN_ROLES } from "@/lib/permissions";
import { updateWorkspaceSchema, type UpdateWorkspaceInput } from "@/lib/validation/auth";
import { SettingsSection } from "./settings-section";

const TITLE = "Workspace";
const DESCRIPTION = "The name your team sees across LeadGenAI.";

export function WorkspaceSettings() {
  const { data: me } = useCurrentUser();

  if (!me) {
    return (
      <SettingsSection title={TITLE} description={DESCRIPTION}>
        <div className="space-y-2" aria-label="Loading workspace">
          <Skeleton className="h-4 w-32" />
          <Skeleton className="h-10 w-full rounded-lg" />
        </div>
      </SettingsSection>
    );
  }
  return <WorkspaceForm key={me.workspace.name} me={me} />;
}

function WorkspaceForm({ me }: { me: Me }) {
  const canEdit = usePermission(ADMIN_ROLES);
  const update = useUpdateWorkspace();
  const form = useForm<UpdateWorkspaceInput>({
    resolver: zodResolver(updateWorkspaceSchema),
    defaultValues: { name: me.workspace.name },
  });

  const onSubmit = form.handleSubmit((values) =>
    update.mutate(values, {
      onSuccess: () => toast.success("Workspace name saved."),
      onError: (error) => applyApiError(error, form.setError, ["name"]),
    }),
  );

  return (
    <form onSubmit={onSubmit} noValidate>
      <SettingsSection
        title={TITLE}
        description={canEdit ? DESCRIPTION : `${DESCRIPTION} Only owners and admins can change it.`}
        footer={
          canEdit && (
            <Button type="submit" disabled={!form.formState.isDirty || update.isPending} aria-busy={update.isPending}>
              {update.isPending && <Loader2Icon className="animate-spin" />}
              Save name
            </Button>
          )
        }
      >
        <TextField control={form.control} name="name" label="Workspace name" disabled={!canEdit} />
      </SettingsSection>
    </form>
  );
}
