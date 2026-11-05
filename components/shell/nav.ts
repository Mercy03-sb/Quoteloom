export type NavItem = { href: string; label: string; soon?: boolean; also?: string[] };

export const NAV_ITEMS: NavItem[] = [
  { href: "/", label: "Dashboard" },
  { href: "/setup", label: "Set up a shop" },
  { href: "/catalog", label: "Catalog" },
  { href: "/playground", label: "Agent playground", also: ["/chat"] },
  { href: "/orders", label: "Orders & disputes", also: ["/disputes"] },
  { href: "/settings", label: "Shop settings" },
  { href: "/analytics", label: "Analytics" },
];

export function isActive(pathname: string, href: string, also: string[] = []): boolean {
  if (also.some((a) => isActive(pathname, a))) return true;
  return href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(`${href}/`);
}

/** Pages meant for buyers, shown without the merchant shell. */
export function isPublicPath(pathname: string | null): boolean {
  return Boolean(pathname && (pathname === "/receipt" || pathname.startsWith("/receipt/")));
}
