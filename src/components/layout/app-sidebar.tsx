"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Logo } from "@/components/brand/logo";
import { cn } from "@/lib/utils";
import { CurrentWorkspace } from "./current-workspace";
import { NAV_ITEMS, SECONDARY_NAV_ITEMS, isActive, type NavItem } from "./nav-items";
import { UserMenu } from "./user-menu";

function NavLink({ item, onNavigate }: { item: NavItem; onNavigate?: () => void }) {
  const pathname = usePathname();
  const active = isActive(pathname, item.href);
  const Icon = item.icon;

  return (
    <Link
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
}

/** Sidebar body, shared by the desktop sidebar and the mobile menu sheet. */
export function SidebarContent({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <div className="flex h-full flex-col px-3 py-4">
      <Link href="/" onClick={onNavigate} className="mb-5 px-2" aria-label="LeadGenAI dashboard">
        <Logo />
      </Link>

      <CurrentWorkspace />

      <nav className="mt-5 flex flex-1 flex-col gap-0.5" aria-label="Main">
        {NAV_ITEMS.map((item) => (
          <NavLink key={item.href} item={item} onNavigate={onNavigate} />
        ))}
      </nav>

      <nav className="mb-3 flex flex-col gap-0.5" aria-label="Workspace">
        {SECONDARY_NAV_ITEMS.map((item) => (
          <NavLink key={item.href} item={item} onNavigate={onNavigate} />
        ))}
      </nav>

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
