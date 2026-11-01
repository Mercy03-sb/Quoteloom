export type NavItem = { href: string; label: string; soon?: boolean };

export const NAV_ITEMS: NavItem[] = [
  { href: "/", label: "Dashboard" },
  { href: "/catalog", label: "Catalog" },
  { href: "/chat", label: "Buyer chat", soon: true },
  { href: "/orders", label: "Orders & disputes", soon: true },
  { href: "/analytics", label: "Analytics", soon: true },
];

export function isActive(pathname: string, href: string): boolean {
  return href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(`${href}/`);
}
