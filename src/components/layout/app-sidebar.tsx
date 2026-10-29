"use client";

import { Suspense } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Logo } from "@/components/brand/logo";
import { cn } from "@/lib/utils";
import { CurrentWorkspace } from "./current-workspace";
import { NAV_ITEMS, SECONDARY_NAV_ITEMS, isActive, type NavItem } from "./nav-items";
import { UserMenu } from "./user-menu";

type NavListProps = { items: NavItem[]; label: string; className?: string; onNavigate?: () => void };

/** Links with the current page highlighted. `pathname` is null before the URL is known. */
function NavList({ items, label, className, onNavigate, pathname }: NavListProps & { pathname: string | null }) {
  return (
    <nav className={cn("flex flex-col gap-0.5", className)} aria-label={label}>
      {items.map((item) => {
        const active = pathname !== null && isActive(pathname, item.href);
        const Icon = item.icon;
        return (
          <Link
            key={item.href}
            href={item.href}
            onClick={onNavigate}
            aria-current={active ? "page" : undefined}
            className={cn(
              "flex items-center gap-3 rounded-lg px-2.5 py-2 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
              active &&
                "bg-sidebar-accent font-medium text-sidebar-accent-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
            )}
          >
            <Icon className="size-4" />
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}

function CurrentNavList(props: NavListProps) {
  return <NavList {...props} pathname={usePathname()} />;
}

/**
 * Reading the URL suspends on dynamic routes (e.g. /companies/[id]) under Cache Components, so
 * only the highlighting waits for it; the links themselves render in the static shell.
 */
function SidebarNav(props: NavListProps) {
  return (
    <Suspense fallback={<NavList {...props} pathname={null} />}>
      <CurrentNavList {...props} />
    </Suspense>
  );
}

/** Sidebar body, shared by the desktop sidebar and the mobile menu sheet. */
export function SidebarContent({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <div className="flex h-full flex-col px-3 py-4">
      <Link href="/" onClick={onNavigate} className="mb-5 px-2" aria-label="LeadGenAI dashboard">
        <Logo />
      </Link>

      <CurrentWorkspace />

      <SidebarNav items={NAV_ITEMS} label="Main" className="mt-5 flex-1" onNavigate={onNavigate} />
      <SidebarNav items={SECONDARY_NAV_ITEMS} label="Workspace" className="mb-3" onNavigate={onNavigate} />

      <div className="border-t pt-3">
        <UserMenu />
      </div>
    </div>
  );
}

export function AppSidebar() {
  return (
    <aside className="sticky top-0 hidden h-screen w-64 shrink-0 border-r bg-sidebar lg:block">
      <SidebarContent />
    </aside>
  );
}
