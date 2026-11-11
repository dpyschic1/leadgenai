import {
  BookmarkIcon,
  BriefcaseBusinessIcon,
  ContactRoundIcon,
  LayoutDashboardIcon,
  SettingsIcon,
  TargetIcon,
  type LucideIcon,
} from "lucide-react";

export type NavItem = { href: string; label: string; icon: LucideIcon };

/**
 * Main navigation, in the order people work: describe what you sell, review the opportunities
 * found for it, contact their leads, then save the best ones to lists. Companies have no menu item:
 * a salesperson works from opportunities, which show the company's details and every contact.
 */
export const NAV_ITEMS: NavItem[] = [
  { href: "/", label: "Dashboard", icon: LayoutDashboardIcon },
  { href: "/services", label: "Services & ICP", icon: BriefcaseBusinessIcon },
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
