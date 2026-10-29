"use client";

import { ChevronsUpDownIcon, LogOutIcon } from "lucide-react";
import { toast } from "sonner";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { useLogout } from "@/hooks/use-auth";
import { useCurrentUser } from "@/hooks/use-current-user";
import { sentenceCase } from "@/lib/format";
import { goToLogin } from "@/lib/navigation";

function initials(name: string | null, email: string): string {
  const source = name?.trim() || email;
  const parts = source.split(/[\s@.]+/).filter(Boolean);
  return parts
    .slice(0, 2)
    .map((part) => part[0]!.toUpperCase())
    .join("");
}

export function UserMenu() {
  const { data: me } = useCurrentUser();
  const logout = useLogout();

  if (!me) {
    return (
      <div className="flex items-center gap-3 px-2 py-2" aria-label="Loading account">
        <Skeleton className="size-8 rounded-full" />
        <div className="flex-1 space-y-1.5">
          <Skeleton className="h-3.5 w-24" />
          <Skeleton className="h-3 w-32" />
        </div>
      </div>
    );
  }

  const handleSignOut = () =>
    logout.mutate(undefined, {
      onSuccess: goToLogin,
      onError: () => toast.error("Couldn't sign out. Check your connection and try again."),
    });

  return (
    <DropdownMenu>
      <DropdownMenuTrigger className="flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left outline-none hover:bg-accent focus-visible:ring-3 focus-visible:ring-ring/50 data-[state=open]:bg-accent">
        <span className="grid size-8 shrink-0 place-items-center rounded-full bg-foreground text-xs font-semibold text-background">
          {initials(me.user.name, me.user.email)}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">{me.user.name ?? me.user.email}</span>
          <span className="block truncate text-xs text-muted-foreground">{me.user.email}</span>
        </span>
        <ChevronsUpDownIcon className="size-4 shrink-0 text-muted-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="start" className="w-(--radix-dropdown-menu-trigger-width)">
        <DropdownMenuLabel className="font-normal">
          <span className="block text-xs text-muted-foreground">Role in {me.workspace.name}</span>
          <span className="block text-sm">{sentenceCase(me.user.role)}</span>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={handleSignOut} disabled={logout.isPending}>
          <LogOutIcon />
          Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
