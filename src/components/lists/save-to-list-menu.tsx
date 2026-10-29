"use client";

import { useState } from "react";
import { BookmarkCheckIcon, BookmarkIcon, PlusIcon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useLists, useToggleSaved } from "@/hooks/use-lists";
import type { OpportunityDetail, SavedList } from "@/lib/api/types";
import { ListNameDialog } from "./list-name-dialog";

/** Ticks the lists an opportunity is on; a new list created here gets the opportunity straight away. */
export function SaveToListMenu({ opportunity }: { opportunity: OpportunityDetail }) {
  const { data: lists } = useLists();
  const toggle = useToggleSaved();
  const [creating, setCreating] = useState(false);
  const saved = new Set(opportunity.listIds);

  const setSaved = (list: SavedList, next: boolean) =>
    toggle.mutate(
      { listId: list.id, opportunityId: opportunity.id, saved: next },
      {
        onSuccess: () => toast.success(next ? `Saved to ${list.name}.` : `Removed from ${list.name}.`),
        onError: (error) => toast.error(error.message),
      },
    );

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" className="h-10">
            {saved.size > 0 ? <BookmarkCheckIcon className="text-primary" /> : <BookmarkIcon />}
            {saved.size > 0 ? `Saved to ${saved.size === 1 ? "1 list" : `${saved.size} lists`}` : "Save to list"}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-60">
          <DropdownMenuLabel className="text-xs text-muted-foreground">Save to</DropdownMenuLabel>
          {lists?.map((list) => (
            <DropdownMenuCheckboxItem
              key={list.id}
              checked={saved.has(list.id)}
              disabled={toggle.isPending}
              // Keep the menu open so several lists can be ticked in a row.
              onSelect={(event) => event.preventDefault()}
              onCheckedChange={(checked) => setSaved(list, checked)}
            >
              <span className="truncate">{list.name}</span>
            </DropdownMenuCheckboxItem>
          ))}
          {lists?.length === 0 && <p className="px-1.5 py-1 text-sm text-muted-foreground">No lists yet.</p>}
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => setCreating(true)}>
            <PlusIcon />
            New list…
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <ListNameDialog
        open={creating}
        onClose={() => setCreating(false)}
        onSaved={(list) => {
          setCreating(false);
          setSaved(list, true);
        }}
      />
    </>
  );
}
