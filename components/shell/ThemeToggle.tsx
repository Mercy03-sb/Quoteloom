"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui";
import { THEME_KEY } from "./theme-init";

type Choice = "light" | "dark";

export function ThemeToggle() {
  const [theme, setTheme] = useState<Choice | null>(null);

  useEffect(() => {
    const explicit = document.documentElement.dataset.theme as Choice | undefined;
    setTheme(explicit ?? (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"));
  }, []);

  function toggle() {
    const next: Choice = theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem(THEME_KEY, next);
    } catch {
      /* storage can be blocked; the theme still applies for this visit */
    }
    setTheme(next);
  }

  return (
    <Button variant="secondary" size="sm" onClick={toggle} aria-label="Toggle light and dark theme">
      {theme === "dark" ? "☀ Light theme" : "☾ Dark theme"}
    </Button>
  );
}

