import {
  BookmarkIcon,
  BriefcaseBusinessIcon,
  Building2Icon,
  ContactRoundIcon,
  LayoutDashboardIcon,
  SettingsIcon,
  TargetIcon,
  type LucideIcon,
} from "lucide-react";

export type NavItem = { href: string; label: string; icon: LucideIcon };

/**
 * Main navigation, in the order people work: describe what you sell, add the companies you
 * watch, review the opportunities they produce, contact their leads, then save the best ones to lists.
 */
export const NAV_ITEMS: NavItem[] = [
  { href: "/", label: "Dashboard", icon: LayoutDashboardIcon },
  { href: "/services", label: "Services & ICP", icon: BriefcaseBusinessIcon },
  { href: "/companies", label: "Companies", icon: Building2Icon },
  { href: "/opportunities", label: "Opportunities", icon: TargetIcon },
  { href: "/leads", label: "Leads", icon: ContactRoundIcon },
  { href: "/lists", label: "Lists", icon: BookmarkIcon },
];

/** Workspace administration, kept apart from the daily flow at the bottom of the sidebar. */
export const SECONDARY_NAV_ITEMS: NavItem[] = [{ href: "/settings", label: "Settings", icon: SettingsIcon }];

export function isActive(pathname: string, href: string): boolean {
  return href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(`${href}/`);
}

/** Title of the section the current path belongs to, for the header breadcrumb. */
export function sectionTitle(pathname: string): string {
  return [...NAV_ITEMS, ...SECONDARY_NAV_ITEMS].find((item) => isActive(pathname, item.href))?.label ?? "";
}
