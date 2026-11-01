"use client";

import { usePathname, useRouter } from "next/navigation";

type Props = { shops: { slug: string; name: string }[]; active: string };

/** Pick which shop a page shows (your published shops plus the shared demo). Hidden when there is only one. */
export function ShopSwitcher({ shops, active }: Props) {
  const router = useRouter();
  const pathname = usePathname();
  if (shops.length < 2) return null;
  return (
    <label className="switcher">
      <span className="sr-only">Shop</span>
      <select value={active} onChange={(e) => router.push(`${pathname}?shop=${encodeURIComponent(e.target.value)}`)}>
        {shops.map((s) => (
          <option key={s.slug} value={s.slug}>
            {s.name}
          </option>
        ))}
      </select>
    </label>
  );
}
