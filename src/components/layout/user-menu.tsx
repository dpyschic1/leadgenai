"use client";

import { ChevronsUpDownIcon, LogOutIcon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useLogout } from "@/hooks/use-auth";
import { useCurrentUser } from "@/hooks/use-current-user";
import { goToLogin } from "@/lib/navigation";

export function UserMenu() {
  const { data: me, isPending } = useCurrentUser();
  const logout = useLogout();

  if (isPending || !me) {
    return <div className="h-12 animate-pulse rounded-lg bg-muted" aria-label="Loading account" />;
  }

  const handleSignOut = () =>
    logout.mutate(undefined, {
      onSuccess: goToLogin,
      onError: () => toast.error("Couldn't sign out. Check your connection and try again."),
    });

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" className="h-auto w-full justify-between px-2 py-2 text-left">
          <span className="min-w-0">
            <span className="block truncate text-sm font-medium">{me.workspace.name}</span>
            <span className="block truncate text-xs text-muted-foreground">{me.user.name ?? me.user.email}</span>
          </span>
          <ChevronsUpDownIcon className="size-4 shrink-0 text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-56">
        <DropdownMenuLabel className="font-normal">
          <span className="block truncate text-sm">{me.user.email}</span>
          <span className="block text-xs capitalize text-muted-foreground">{me.user.role}</span>
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
