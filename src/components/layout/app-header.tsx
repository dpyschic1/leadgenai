"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { CalendarDaysIcon, ChevronRightIcon, MenuIcon } from "lucide-react";
import { LogoMark } from "@/components/brand/logo";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { useCurrentUser } from "@/hooks/use-current-user";
import { useToday } from "@/hooks/use-today";
import { SidebarContent } from "./app-sidebar";
import { sectionTitle } from "./nav-items";

/** Below `lg` the sidebar is hidden; this opens the same content in a slide-over sheet. */
function MobileMenu() {
  const [open, setOpen] = useState(false);

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button variant="ghost" size="icon" className="-ml-2 lg:hidden" aria-label="Open menu">
          <MenuIcon />
        </Button>
      </SheetTrigger>
      <SheetContent side="left" className="w-72 p-0">
        <SheetTitle className="sr-only">Menu</SheetTitle>
        <SidebarContent onNavigate={() => setOpen(false)} />
      </SheetContent>
    </Sheet>
  );
}

/** Top bar of every signed-in page: where you are, and today's date. */
export function AppHeader() {
  const pathname = usePathname();
  const { data: me } = useCurrentUser();
  const today = useToday();

  return (
    <header className="sticky top-0 z-20 border-b bg-background/85 backdrop-blur supports-[backdrop-filter]:bg-background/70">
      <div className="flex h-14 items-center gap-3 px-4 sm:px-8">
        <MobileMenu />
        <Link href="/" className="lg:hidden" aria-label="LeadGenAI dashboard">
          <LogoMark />
        </Link>

        <nav aria-label="Breadcrumb" className="min-w-0 flex-1">
          <ol className="flex items-center gap-1.5 text-sm">
            <li className="hidden min-w-0 sm:block">
              {me ? (
                <span className="block truncate text-muted-foreground">{me.workspace.name}</span>
              ) : (
                <Skeleton className="h-4 w-28" />
              )}
            </li>
            <li aria-hidden="true" className="hidden text-muted-foreground/60 sm:block">
              <ChevronRightIcon className="size-3.5" />
            </li>
            <li className="truncate font-medium" aria-current="page">
              {sectionTitle(pathname)}
            </li>
          </ol>
        </nav>

        <div className="hidden items-center gap-2 text-sm text-muted-foreground sm:flex">
          <CalendarDaysIcon className="size-4" />
          {today ?? <Skeleton className="h-4 w-36" />}
        </div>
      </div>
    </header>
  );
}
