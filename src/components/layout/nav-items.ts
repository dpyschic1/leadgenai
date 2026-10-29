import {
  BookmarkIcon,
  Building2Icon,
  LayoutDashboardIcon,
  SettingsIcon,
  TargetIcon,
  type LucideIcon,
} from "lucide-react";

export const NAV_ITEMS: { href: string; label: string; icon: LucideIcon }[] = [
  { href: "/", label: "Dashboard", icon: LayoutDashboardIcon },
  { href: "/opportunities", label: "Opportunities", icon: TargetIcon },
  { href: "/companies", label: "Companies", icon: Building2Icon },
  { href: "/lists", label: "Lists", icon: BookmarkIcon },
  { href: "/settings", label: "Settings", icon: SettingsIcon },
];

export function isActive(pathname: string, href: string): boolean {
  return href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(`${href}/`);
}

/** Title of the section the current path belongs to, for the header breadcrumb. */
export function sectionTitle(pathname: string): string {
  return NAV_ITEMS.find((item) => isActive(pathname, item.href))?.label ?? "";
}
