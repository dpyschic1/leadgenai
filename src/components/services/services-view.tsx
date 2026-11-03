"use client";

import { useState } from "react";
import { BriefcaseBusinessIcon, PlusIcon } from "lucide-react";
import { EditorSheet } from "@/components/forms/editor-sheet";
import { PageHeader } from "@/components/layout/page-header";
import { Pagination, usePage } from "@/components/layout/pagination";
import { Button } from "@/components/ui/button";

import { usePermission } from "@/hooks/use-permission";
import { useServices } from "@/hooks/use-services";
import type { Service } from "@/lib/api/types";
import { CONFIG_ROLES } from "@/lib/permissions";
import { DeleteServiceDialog } from "./delete-service-dialog";
import { ServiceCard, ServiceCardSkeleton } from "./service-card";
import { ServiceForm } from "./service-form";

/** Cards sit two to a row, so a page holds an even number. */
const SERVICES_PER_PAGE = 12;

/** `null` = closed, `"new"` = adding, a service = editing it. */
type Editing = Service | "new" | null;

export function ServicesView() {
  const [page, setPage] = usePage("services", SERVICES_PER_PAGE);
  const { data, isPending } = useServices(page);
  const services = data?.items;
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
          canEdit && data && data.total > 0 ? (
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
      ) : services && data && data.total > 0 ? (
        <>
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
          <Pagination page={data.page} pageSize={data.pageSize} total={data.total} noun="services" onChange={setPage} />
        </>
      ) : (
        <EmptyServices canEdit={canEdit} onAdd={() => setEditing("new")} />
      )}

      <EditorSheet
        open={editing !== null}
        onClose={close}
        title={editing === "new" ? "Add a service" : "Edit service"}
        description={
          editing === "new"
            ? "Describe one thing you sell. Add a separate service for each offer."
            : "Changes apply to how new opportunities are scored."
        }
      >
        {editing !== null && (
          <ServiceForm
            key={editing === "new" ? "new" : editing.id}
            service={editing === "new" ? undefined : editing}
            onDone={close}
            onCancel={close}
          />
        )}
      </EditorSheet>

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
