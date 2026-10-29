"use client";

import { useState } from "react";
import { BriefcaseBusinessIcon, PlusIcon } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { usePermission } from "@/hooks/use-permission";
import { useServices } from "@/hooks/use-services";
import type { Service } from "@/lib/api/types";
import { CONFIG_ROLES } from "@/lib/permissions";
import { DeleteServiceDialog } from "./delete-service-dialog";
import { ServiceCard, ServiceCardSkeleton } from "./service-card";
import { ServiceForm } from "./service-form";

/** `null` = closed, `"new"` = adding, a service = editing it. */
type Editing = Service | "new" | null;

export function ServicesView() {
  const { data: services, isPending } = useServices();
  const canEdit = usePermission(CONFIG_ROLES);
  const [editing, setEditing] = useState<Editing>(null);
  const [deleting, setDeleting] = useState<Service | null>(null);
  const close = () => setEditing(null);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Services & ICP"
        description="What you sell and who you sell it to. Every opportunity is scored against these."
        action={
          canEdit && services && services.length > 0 ? (
            <Button onClick={() => setEditing("new")}>
              <PlusIcon />
              Add service
            </Button>
          ) : undefined
        }
      />

      {isPending ? (
        <div className="grid gap-5 lg:grid-cols-2" aria-label="Loading services">
          <ServiceCardSkeleton />
          <ServiceCardSkeleton />
        </div>
      ) : services && services.length > 0 ? (
        <div className="grid gap-5 lg:grid-cols-2">
          {services.map((service) => (
            <ServiceCard
              key={service.id}
              service={service}
              canEdit={canEdit}
              onEdit={() => setEditing(service)}
              onDelete={() => setDeleting(service)}
            />
          ))}
        </div>
      ) : (
        <EmptyServices canEdit={canEdit} onAdd={() => setEditing("new")} />
      )}

      <Sheet open={editing !== null} onOpenChange={(open) => !open && close()}>
        <SheetContent side="right" className="flex flex-col gap-0 p-0 data-[side=right]:w-full data-[side=right]:sm:max-w-2xl data-[side=right]:xl:max-w-3xl">
          <SheetHeader className="border-b px-6 py-5">
            <SheetTitle>{editing === "new" ? "Add a service" : "Edit service"}</SheetTitle>
            <SheetDescription>
              {editing === "new"
                ? "Describe one thing you sell. Add a separate service for each offer."
                : "Changes apply to how new opportunities are scored."}
            </SheetDescription>
          </SheetHeader>
          {editing !== null && (
            <ServiceForm
              key={editing === "new" ? "new" : editing.id}
              service={editing === "new" ? undefined : editing}
              onDone={close}
              onCancel={close}
            />
          )}
        </SheetContent>
      </Sheet>

      <DeleteServiceDialog service={deleting} onClose={() => setDeleting(null)} />
    </div>
  );
}

function EmptyServices({ canEdit, onAdd }: { canEdit: boolean; onAdd: () => void }) {
  return (
    <section className="flex flex-col items-center rounded-xl border border-dashed bg-card px-6 py-14 text-center">
      <span className="grid size-11 place-items-center rounded-full bg-signal-tint text-primary">
        <BriefcaseBusinessIcon className="size-5" />
      </span>
      <h2 className="mt-4 font-semibold">Add what you sell</h2>
      <p className="mt-1.5 max-w-md text-sm text-muted-foreground">
        {canEdit
          ? "Start with your main service and the customers it's for. Signals are matched and scored against it."
          : "An owner, admin or manager needs to add your services before opportunities can be scored."}
      </p>
      {canEdit && (
        <Button className="mt-5" onClick={onAdd}>
          <PlusIcon />
          Add your first service
        </Button>
      )}
    </section>
  );
}
