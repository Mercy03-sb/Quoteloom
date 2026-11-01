export type NavItem = { href: string; label: string; soon?: boolean; also?: string[] };

export const NAV_ITEMS: NavItem[] = [
  { href: "/", label: "Dashboard" },
  { href: "/setup", label: "Set up a shop" },
  { href: "/catalog", label: "Catalog" },
  { href: "/chat", label: "Buyer chat" },
  { href: "/orders", label: "Orders & disputes", also: ["/disputes"] },
  { href: "/settings", label: "Shop settings" },
  { href: "/analytics", label: "Analytics", soon: true },
];

export function isActive(pathname: string, href: string, also: string[] = []): boolean {
  if (also.some((a) => isActive(pathname, a))) return true;
  return href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(`${href}/`);
}
