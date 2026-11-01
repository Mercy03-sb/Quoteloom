"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { Badge, ToastProvider } from "@/components/ui";
import { isActive, NAV_ITEMS } from "./nav";
import { ThemeToggle } from "./ThemeToggle";

function Mark() {
  return <span className="brand-mark weave" aria-hidden="true" />;
}

export function AppShell({ badges, children }: { badges: ReactNode; children: ReactNode }) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  return (
    <ToastProvider>
      <div className="shell">
        <header className="topbar">
          <Link href="/" className="brand">
            <Mark />
            <span className="brand-name">Quoteloom</span>
          </Link>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            aria-expanded={open}
            aria-controls="sidebar"
            onClick={() => setOpen((o) => !o)}
          >
            {open ? "Close" : "Menu"}
          </button>
        </header>
        <div className="scrim" data-open={open} onClick={() => setOpen(false)} />
        <aside id="sidebar" className="sidebar" data-open={open}>
          <Link href="/" className="brand">
            <Mark />
            <span className="brand-name">Quoteloom</span>
          </Link>
          <nav className="nav" aria-label="Main">
            <span className="nav-label">Workspace</span>
            {NAV_ITEMS.map((item) =>
              item.soon ? (
                <span key={item.href} className="nav-link" aria-disabled="true">
                  {item.label}
                  <Badge>Soon</Badge>
                </span>
              ) : (
                <Link
                  key={item.href}
                  href={item.href}
                  className="nav-link"
                  aria-current={isActive(pathname, item.href, item.also) ? "page" : undefined}
                >
                  {item.label}
                </Link>
              ),
            )}
          </nav>
          <div className="sidebar-foot">
            {badges}
            <ThemeToggle />
            <p className="stat-note">Fake data only. Sandbox only. No real money.</p>
            <p className="stat-note" data-testid="reset-note">The demo workspace resets when the server restarts.</p>
          </div>
        </aside>
        <main className="main">{children}</main>
      </div>
    </ToastProvider>
  );
}
