// Design tokens: the single source of truth for Quoteloom's look.
// Palette idea: undyed linen neutrals, one indigo (the dye), and a few "thread" colours.
// `themeCss()` turns these into CSS custom properties; components only use `var(--…)`.

export type ThemeName = "light" | "dark";

export const colors: Record<ThemeName, Record<string, string>> = {
  light: {
    bg: "#f6f2ea", // linen
    surface: "#fffdf9",
    "surface-2": "#efe9dd",
    border: "#e0d8c8",
    "border-strong": "#c9bfab",
    text: "#231f2e",
    "text-muted": "#625c70",
    accent: "#3b3fb6", // indigo
    "accent-hover": "#2f3396",
    "accent-soft": "#e6e7f8",
    "on-accent": "#ffffff",
    success: "#1f7a4d",
    "success-soft": "#dff2e7",
    warning: "#8a5a00",
    "warning-soft": "#f8ecd0",
    danger: "#b3261e",
    "danger-soft": "#f9dedc",
    "thread-1": "#3b3fb6",
    "thread-2": "#b4452f",
    "thread-3": "#b98a1b",
    "thread-4": "#4f7a52",
    "thread-5": "#7a3b78",
    shadow: "0 1px 2px rgb(35 31 46 / 0.06), 0 6px 20px rgb(35 31 46 / 0.06)",
  },
  dark: {
    bg: "#17151f",
    surface: "#201d2b",
    "surface-2": "#2a2638",
    border: "#37334a",
    "border-strong": "#4b4663",
    text: "#f1ede4",
    "text-muted": "#b2acc2",
    accent: "#9ea1ff",
    "accent-hover": "#b9bbff",
    "accent-soft": "#2d2f5e",
    "on-accent": "#14132b",
    success: "#6fd39b",
    "success-soft": "#1d3a2b",
    warning: "#e6b956",
    "warning-soft": "#3d3115",
    danger: "#ff948c",
    "danger-soft": "#4a2220",
    "thread-1": "#9ea1ff",
    "thread-2": "#e8836d",
    "thread-3": "#e0b44a",
    "thread-4": "#86b889",
    "thread-5": "#c586c2",
    shadow: "0 1px 2px rgb(0 0 0 / 0.4), 0 8px 24px rgb(0 0 0 / 0.35)",
  },
};

/** Modular type scale (≈1.2). Sizes in rem. */
export const fontSizes = {
  xs: "0.75rem",
  sm: "0.875rem",
  base: "1rem",
  lg: "1.2rem",
  xl: "1.5rem",
  "2xl": "1.95rem",
  "3xl": "2.6rem",
} as const;

export const fonts = {
  display: "'Fraunces Variable', Georgia, 'Times New Roman', serif",
  body: "'Hanken Grotesk Variable', system-ui, -apple-system, 'Segoe UI', sans-serif",
  mono: "ui-monospace, 'Cascadia Code', Consolas, monospace",
} as const;

/** 4px base spacing grid. */
export const space = {
  1: "0.25rem",
  2: "0.5rem",
  3: "0.75rem",
  4: "1rem",
  5: "1.5rem",
  6: "2rem",
  7: "3rem",
  8: "4.5rem",
} as const;

export const radii = { sm: "6px", md: "10px", lg: "16px", pill: "999px" } as const;

export const sidebarWidth = "248px";

function vars(prefix: string, values: Record<string, string>): string {
  return Object.entries(values)
    .map(([k, v]) => `--${prefix}${k}:${v};`)
    .join("");
}

function themeVars(theme: ThemeName): string {
  return vars("c-", colors[theme]);
}

/** CSS for :root. Dark follows the OS unless data-theme says otherwise. */
export function themeCss(): string {
  const shared =
    vars("fs-", fontSizes) + vars("sp-", space) + vars("r-", radii) + vars("f-", fonts) + `--sidebar-w:${sidebarWidth};`;
  return [
    `:root{color-scheme:light;${shared}${themeVars("light")}}`,
    `@media (prefers-color-scheme:dark){:root:not([data-theme]){color-scheme:dark;${themeVars("dark")}}}`,
    `:root[data-theme="light"]{color-scheme:light;${themeVars("light")}}`,
    `:root[data-theme="dark"]{color-scheme:dark;${themeVars("dark")}}`,
  ].join("\n");
}

/** WCAG relative luminance contrast ratio between two #rrggbb colours. */
export function contrastRatio(a: string, b: string): number {
  const lum = (hex: string) => {
    const n = parseInt(hex.slice(1), 16);
    const [r, g, bl] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
      const c = v / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** Stable thread colour (1-5) for a string, used for product swatches. */
export function threadFor(key: string): 1 | 2 | 3 | 4 | 5 {
  let h = 0;
  for (const ch of key) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return ((h % 5) + 1) as 1 | 2 | 3 | 4 | 5;
}
