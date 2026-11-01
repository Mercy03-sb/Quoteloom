import { describe, expect, it } from "vitest";
import { colors, contrastRatio, themeCss, threadFor } from "@/lib/design/tokens";

describe("design tokens", () => {
  it("defines the same keys in light and dark", () => {
    expect(Object.keys(colors.dark).sort()).toEqual(Object.keys(colors.light).sort());
  });

  it.each(["light", "dark"] as const)("keeps readable contrast in the %s theme", (theme) => {
    const c = colors[theme];
    expect(contrastRatio(c.text, c.bg)).toBeGreaterThanOrEqual(7);
    expect(contrastRatio(c.text, c.surface)).toBeGreaterThanOrEqual(7);
    expect(contrastRatio(c["text-muted"], c.surface)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(c["text-muted"], c.bg)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(c["on-accent"], c.accent)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(c.accent, c["accent-soft"])).toBeGreaterThanOrEqual(4.5);
    for (const tone of ["success", "warning", "danger"]) {
      expect(contrastRatio(c[tone], c[`${tone}-soft`])).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("emits light, dark-by-OS and explicit-theme CSS", () => {
    const css = themeCss();
    expect(css).toContain("--c-accent:#3b3fb6");
    expect(css).toContain("prefers-color-scheme:dark");
    expect(css).toContain(':root[data-theme="dark"]');
    expect(css).toContain("--sidebar-w:");
  });

  it("maps a key to a stable thread colour 1-5", () => {
    expect(threadFor("LT-SCARF-WOOL-RED")).toBe(threadFor("LT-SCARF-WOOL-RED"));
    for (const k of ["a", "b", "LT-1", "LT-2"]) expect([1, 2, 3, 4, 5]).toContain(threadFor(k));
  });
});

describe("contrastRatio", () => {
  it("is 21 for black on white and 1 for identical colours", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 0);
    expect(contrastRatio("#336699", "#336699")).toBeCloseTo(1, 5);
  });
});
