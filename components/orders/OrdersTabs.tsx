import Link from "next/link";

export function OrdersTabs({ active }: { active: "orders" | "disputes" }) {
  return (
    <nav className="tabs" aria-label="Orders and disputes">
      <Link href="/orders" aria-current={active === "orders" ? "page" : undefined}>Orders</Link>
      <Link href="/disputes" aria-current={active === "disputes" ? "page" : undefined}>Disputes</Link>
    </nav>
  );
}
