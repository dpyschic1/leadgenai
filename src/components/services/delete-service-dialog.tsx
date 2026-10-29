"use client";

import { toast } from "sonner";
import { ConfirmDialog } from "@/components/forms/confirm-dialog";
import { useDeleteService } from "@/hooks/use-services";
import type { Service } from "@/lib/api/types";

export function DeleteServiceDialog({ service, onClose }: { service: Service | null; onClose: () => void }) {
  const remove = useDeleteService();

  return (
    <ConfirmDialog
      open={service !== null}
      title={`Delete ${service?.name}?`}
      description="Its targeting is removed too. Opportunities already linked to it keep their history but lose the service match."
      confirmLabel="Delete service"
      pending={remove.isPending}
      onClose={onClose}
      onConfirm={() =>
        service &&
        remove.mutate(service.id, {
          onSuccess: () => {
            toast.success(`Deleted ${service.name}.`);
            onClose();
          },
          onError: (error) => toast.error(error.message),
        })
      }
    />
  );
}
