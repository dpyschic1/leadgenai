"use client";

import { Loader2Icon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useDeleteService } from "@/hooks/use-services";
import type { Service } from "@/lib/api/types";

export function DeleteServiceDialog({ service, onClose }: { service: Service | null; onClose: () => void }) {
  const remove = useDeleteService();

  const confirm = () => {
    if (!service) return;
    remove.mutate(service.id, {
      onSuccess: () => {
        toast.success(`Deleted ${service.name}.`);
        onClose();
      },
      onError: (error) => toast.error(error.message),
    });
  };

  return (
    <Dialog open={service !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete {service?.name}?</DialogTitle>
          <DialogDescription>
            Its targeting is removed too. Opportunities already linked to it keep their history but
            lose the service match.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={confirm} disabled={remove.isPending} aria-busy={remove.isPending}>
            {remove.isPending && <Loader2Icon className="animate-spin" />}
            Delete service
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
