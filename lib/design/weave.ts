// Per-product woven swatch: a pattern and a colour derived from the title and attributes.
// Pure data in, CSS out, so it is testable and works in both themes.

export type WeavePattern = "plain" | "twill" | "herringbone" | "stripes" | "gingham" | "waffle" | "diamond" | "basket";

export type Weave = { pattern: WeavePattern; hue: number; sat: number; light: number };

const BY_MATERIAL: Record<string, WeavePattern[]> = {
  wool: ["twill", "herringbone"],
  merino: ["twill", "herringbone"],
  cotton: ["waffle", "gingham"],
  linen: ["stripes", "plain"],
  jute: ["basket", "diamond"],
};
const ALL: WeavePattern[] = ["plain", "twill", "herringbone", "stripes", "gingham", "waffle", "diamond", "basket"];

const NAMED: Record<string, [number, number]> = {
  grey: [220, 9],
  gray: [220, 9],
  red: [12, 62],
  natural: [38, 38],
  blue: [228, 58],
  green: [140, 38],
  yellow: [44, 70],
  black: [260, 8],
  white: [40, 10],
};

function hash(s: string): number {
  let h = 2166136261;
  for (const ch of s) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
  return h;
}

export type WeaveInput = { sku: string; title: string; attrs?: Record<string, unknown> };

export function weaveFor({ sku, title, attrs = {} }: WeaveInput): Weave {
  const h = hash(`${sku}|${title}`);
  const material = String(attrs.material ?? "").toLowerCase();
  const key = Object.keys(BY_MATERIAL).find((m) => material.includes(m));
  const pool = key ? BY_MATERIAL[key] : ALL;
  const color = NAMED[String(attrs.color ?? "").toLowerCase()];
  return {
    pattern: pool[(h >>> 8) % pool.length],
    hue: color ? color[0] : h % 360,
    sat: color ? color[1] : 48,
    light: 46,
  };
}

/** Inline style for the swatch element. Colours blend into the current theme's surface. */
export function weaveStyle(w: Weave): Record<string, string> {
  const base = `hsl(${w.hue} ${w.sat}% ${w.light}%)`;
  const strong = `color-mix(in srgb, ${base} 38%, transparent)`;
  const soft = `color-mix(in srgb, ${base} 18%, transparent)`;
  const backgroundColor = `color-mix(in srgb, ${base} 12%, var(--c-surface))`;
  const g: Record<WeavePattern, [string, string]> = {
    plain: [
      `repeating-linear-gradient(0deg, ${soft} 0 2px, transparent 2px 8px), repeating-linear-gradient(90deg, ${strong} 0 2px, transparent 2px 8px)`,
      "auto",
    ],
    twill: [`repeating-linear-gradient(45deg, ${strong} 0 3px, transparent 3px 9px), repeating-linear-gradient(-45deg, ${soft} 0 1px, transparent 1px 9px)`, "auto"],
    herringbone: [
      `linear-gradient(135deg, ${strong} 25%, transparent 25%) -10px 0, linear-gradient(225deg, ${strong} 25%, transparent 25%) -10px 0, linear-gradient(315deg, ${soft} 25%, transparent 25%), linear-gradient(45deg, ${soft} 25%, transparent 25%)`,
      "20px 20px",
    ],
    stripes: [`repeating-linear-gradient(90deg, ${strong} 0 6px, transparent 6px 14px, ${soft} 14px 16px, transparent 16px 26px)`, "auto"],
    gingham: [`repeating-conic-gradient(${strong} 0% 25%, transparent 0% 50%)`, "18px 18px"],
    waffle: [
      `radial-gradient(circle at 50% 50%, transparent 0 3px, ${strong} 3px 4px, transparent 4px), repeating-linear-gradient(0deg, ${soft} 0 1px, transparent 1px 12px)`,
      "12px 12px, auto",
    ],
    diamond: [`repeating-linear-gradient(45deg, ${strong} 0 2px, transparent 2px 12px), repeating-linear-gradient(-45deg, ${strong} 0 2px, transparent 2px 12px)`, "auto"],
    basket: [`linear-gradient(90deg, ${strong} 50%, transparent 50%), linear-gradient(0deg, ${soft} 50%, transparent 50%)`, "20px 20px"],
  };
  const [backgroundImage, backgroundSize] = g[w.pattern];
  return { backgroundColor, backgroundImage, backgroundSize };
}
