"use client";

import { useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { ArrowLeftIcon, BookmarkIcon, MoreHorizontalIcon, PencilIcon, Trash2Icon, XIcon } from "lucide-react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/forms/confirm-dialog";
import { ExportButton } from "@/components/opportunities/export-button";
import { OpportunityCard } from "@/components/opportunities/opportunity-card";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { useDeleteList, useList, useToggleSaved } from "@/hooks/use-lists";
import { usePermission } from "@/hooks/use-permission";
import { ApiError } from "@/lib/api/client";
import type { OpportunitySummary, SavedListDetail } from "@/lib/api/types";
import { EDITOR_ROLES } from "@/lib/permissions";
import { ListNameDialog } from "./list-name-dialog";

export function ListDetailView() {
  const { id } = useParams<{ id: string }>();
  const { data: list, error } = useList(id);

  if (error instanceof ApiError && error.status === 404) return <ListNotFound />;
  if (!list) return <ListDetailSkeleton />;
  return <ListDetailContent list={list} />;
}

function ListDetailContent({ list }: { list: SavedListDetail }) {
  const router = useRouter();
  const canEdit = usePermission(EDITOR_ROLES);
  const [renaming, setRenaming] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const deleteList = useDeleteList();

  return (
    <div className="space-y-6">
      <BackToLists />

      <header className="flex flex-col gap-4 rounded-2xl border bg-card p-6 sm:flex-row sm:items-center">
        <span className="grid size-14 shrink-0 place-items-center rounded-xl bg-signal-tint text-primary">
          <BookmarkIcon className="size-6" />
        </span>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-2xl font-semibold">{list.name}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {list.opportunityCount === 1 ? "1 opportunity" : `${list.opportunityCount} opportunities`}, highest priority first
          </p>
        </div>
        {canEdit && (
          <div className="flex items-center gap-2">
            <ExportButton query={{ listId: list.id }} disabled={list.items.length === 0} />
            <Button variant="outline" onClick={() => setRenaming(true)}>
              <PencilIcon />
              Rename
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="icon" aria-label="More actions">
                  <MoreHorizontalIcon />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem variant="destructive" onSelect={() => setConfirmDelete(true)}>
                  <Trash2Icon />
                  Delete list
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        )}
      </header>

      {list.items.length > 0 ? (
        <ul className="space-y-3" aria-label={`Opportunities on ${list.name}`}>
          {list.items.map((opportunity) => (
            <OpportunityCard
              key={opportunity.id}
              opportunity={opportunity}
              action={canEdit && <RemoveFromListButton listId={list.id} listName={list.name} opportunity={opportunity} />}
            />
          ))}
        </ul>
      ) : (
        <p className="rounded-xl border border-dashed bg-card px-6 py-12 text-center text-sm text-muted-foreground">
          Nothing on this list yet. Open an opportunity and use <span className="font-medium text-foreground">Save to list</span>.{" "}
          <Link href="/opportunities" className="font-medium text-primary hover:underline underline-offset-4">
            Go to opportunities
          </Link>
        </p>
      )}

      <ListNameDialog
        open={renaming}
        list={list}
        onClose={() => setRenaming(false)}
        onSaved={(saved) => {
          toast.success(`Renamed to ${saved.name}.`);
          setRenaming(false);
        }}
      />
      <ConfirmDialog
        open={confirmDelete}
        title={`Delete ${list.name}?`}
        description="Only the list is deleted. Its opportunities stay in your feed with their status and notes."
        confirmLabel="Delete list"
        pending={deleteList.isPending}
        onClose={() => setConfirmDelete(false)}
        onConfirm={() =>
          deleteList.mutate(list.id, {
            onSuccess: () => {
              toast.success(`Deleted ${list.name}.`);
              router.push("/lists");
            },
            onError: (error) => toast.error(error.message),
          })
        }
      />
    </div>
  );
}

function RemoveFromListButton({
  listId,
  listName,
  opportunity,
}: {
  listId: string;
  listName: string;
  opportunity: OpportunitySummary;
}) {
  const toggle = useToggleSaved();
  return (
    <Button
      variant="ghost"
      size="icon"
      className="size-8 text-muted-foreground hover:text-destructive"
      aria-label={`Remove ${opportunity.company.name} from ${listName}`}
      title="Remove from list"
      disabled={toggle.isPending}
      onClick={() =>
        toggle.mutate(
          { listId, opportunityId: opportunity.id, saved: false },
          {
            onSuccess: () => toast.success(`Removed ${opportunity.company.name} from ${listName}.`),
            onError: (error) => toast.error(error.message),
          },
        )
      }
    >
      <XIcon />
    </Button>
  );
}

function BackToLists() {
  return (
    <Link href="/lists" className="inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground">
      <ArrowLeftIcon className="size-4" />
      Lists
    </Link>
  );
}

function ListNotFound() {
  return (
    <div className="flex flex-col items-center rounded-xl border border-dashed bg-card px-6 py-16 text-center">
      <h1 className="font-semibold">List not found</h1>
      <p className="mt-1.5 text-sm text-muted-foreground">It may have been deleted.</p>
      <Button asChild variant="outline" className="mt-5">
        <Link href="/lists">
          <ArrowLeftIcon />
          Back to lists
        </Link>
      </Button>
    </div>
  );
}

export function ListDetailSkeleton() {
  return (
    <div className="space-y-6" aria-label="Loading list">
      <Skeleton className="h-5 w-20" />
      <div className="flex items-center gap-4 rounded-2xl border bg-card p-6">
        <Skeleton className="size-14 rounded-xl" />
        <div className="flex-1 space-y-2">
          <Skeleton className="h-7 w-56" />
          <Skeleton className="h-4 w-40" />
        </div>
      </div>
      <div className="space-y-3">
        {[0, 1].map((row) => (
          <Skeleton key={row} className="h-32 w-full rounded-xl" />
        ))}
      </div>
    </div>
  );
}
