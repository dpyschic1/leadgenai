"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { BookmarkIcon, ChevronRightIcon, PlusIcon } from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/layout/page-header";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useLists } from "@/hooks/use-lists";
import { usePermission } from "@/hooks/use-permission";
import type { SavedList } from "@/lib/api/types";
import { EDITOR_ROLES } from "@/lib/permissions";
import { ListNameDialog } from "./list-name-dialog";

const dateFormat = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short" });

export function ListsView() {
  const router = useRouter();
  const { data: lists } = useLists();
  const canEdit = usePermission(EDITOR_ROLES);
  const [creating, setCreating] = useState(false);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Lists"
        description="Group the opportunities you want to act on, e.g. by service or next step, and export any list to CSV."
        action={
          canEdit &&
          lists &&
          lists.length > 0 && (
            <Button onClick={() => setCreating(true)}>
              <PlusIcon />
              New list
            </Button>
          )
        }
      />

      {!lists ? (
        <ListsSkeleton />
      ) : lists.length === 0 ? (
        <EmptyLists canEdit={canEdit} onCreate={() => setCreating(true)} />
      ) : (
        <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3" aria-label="Lists">
          {lists.map((list) => (
            <ListCard key={list.id} list={list} />
          ))}
        </ul>
      )}

      <ListNameDialog
        open={creating}
        onClose={() => setCreating(false)}
        onSaved={(list) => {
          toast.success(`Created ${list.name}.`);
          setCreating(false);
          router.push(`/lists/${list.id}`);
        }}
      />
    </div>
  );
}

function ListCard({ list }: { list: SavedList }) {
  return (
    <li>
      <Link
        href={`/lists/${list.id}`}
        className="group flex items-center gap-4 rounded-xl border bg-card p-5 transition-shadow hover:shadow-[0_8px_24px_-12px_rgba(27,36,51,0.18)]"
      >
        <span className="grid size-11 shrink-0 place-items-center rounded-lg bg-signal-tint text-primary">
          <BookmarkIcon className="size-5" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate font-semibold group-hover:text-primary">{list.name}</p>
          <p className="text-sm text-muted-foreground">
            {list.opportunityCount === 1 ? "1 opportunity" : `${list.opportunityCount} opportunities`}
            <span aria-hidden> · </span>
            Updated {dateFormat.format(new Date(list.updatedAt))}
          </p>
        </div>
        <ChevronRightIcon className="size-4 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
      </Link>
    </li>
  );
}

function ListsSkeleton() {
  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3" aria-label="Loading lists">
      {[0, 1, 2].map((card) => (
        <div key={card} className="flex items-center gap-4 rounded-xl border bg-card p-5">
          <Skeleton className="size-11 rounded-lg" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-4 w-32" />
            <Skeleton className="h-3 w-44" />
          </div>
        </div>
      ))}
    </div>
  );
}

function EmptyLists({ canEdit, onCreate }: { canEdit: boolean; onCreate: () => void }) {
  return (
    <section className="flex flex-col items-center rounded-xl border border-dashed bg-card px-6 py-14 text-center">
      <span className="grid size-11 place-items-center rounded-full bg-signal-tint text-primary">
        <BookmarkIcon className="size-5" />
      </span>
      <h2 className="mt-4 font-semibold">No lists yet</h2>
      <p className="mt-1.5 max-w-md text-sm text-muted-foreground">
        Create lists like &ldquo;Contact today&rdquo; or &ldquo;Website redesign&rdquo;, then save opportunities to them
        from each opportunity&apos;s page.
      </p>
      {canEdit && (
        <Button className="mt-5" onClick={onCreate}>
          <PlusIcon />
          New list
        </Button>
      )}
    </section>
  );
}
