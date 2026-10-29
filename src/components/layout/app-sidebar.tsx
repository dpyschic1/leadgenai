"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Logo } from "@/components/brand/logo";
import { cn } from "@/lib/utils";
import { CurrentWorkspace } from "./current-workspace";
import { NAV_ITEMS, isActive } from "./nav-items";
import { UserMenu } from "./user-menu";

/** Sidebar body, shared by the desktop sidebar and the mobile menu sheet. */
export function SidebarContent({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();

  return (
    <div className="flex h-full flex-col px-3 py-4">
      <Link href="/" onClick={onNavigate} className="mb-5 px-2" aria-label="LeadGenAI dashboard">
        <Logo />
      </Link>

      <CurrentWorkspace />

      <nav className="mt-5 flex flex-1 flex-col gap-0.5" aria-label="Main">
        {NAV_ITEMS.map(({ href, label, icon: Icon }) => {
          const active = isActive(pathname, href);
          return (
            <Link
              key={href}
              href={href}
              onClick={onNavigate}
              aria-current={active ? "page" : undefined}
              className={cn(
                "flex items-center gap-3 rounded-lg px-2.5 py-2 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
                active &&
                  "bg-sidebar-accent font-medium text-sidebar-accent-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
              )}
            >
              <Icon className="size-4" />
              {label}
            </Link>
          );
        })}
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
