// Tiny HTML helpers. Regex-based on purpose: no HTML parser dependency, and we only need a few tags.

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", euro: "€", pound: "£", rupee: "₹", copy: "©" };

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const code = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

export function squash(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/** Remove scripts, styles, comments and other non-content blocks. */
export function stripNonContent(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|svg|template|iframe)\b[\s\S]*?<\/\1\s*>/gi, " ");
}

export function textOf(html: string): string {
  return squash(decodeEntities(html.replace(/<[^>]+>/g, " ")));
}

/** Parse the attributes of one tag string such as `<meta property="og:title" content="x">`. */
export function attrsOf(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([a-zA-Z_:][\w:.-]*)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
  const inner = tag.replace(/^<\s*[\w-]+/, "").replace(/\/?>$/, "");
  for (let m = re.exec(inner); m; m = re.exec(inner)) {
    out[m[1].toLowerCase()] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? "");
  }
  return out;
}

export function pageTitle(html: string): string | null {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const t = m ? textOf(m[1]) : "";
  return t || null;
}

/** meta name/property -> content, lower-cased keys. First occurrence wins. */
export function metaTags(html: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of html.matchAll(/<meta\b[^>]*>/gi)) {
    const a = attrsOf(m[0]);
    const key = (a.property ?? a.name ?? a.itemprop)?.toLowerCase();
    if (key && a.content !== undefined && !(key in out)) out[key] = a.content;
  }
  return out;
}

/** Same-origin links on a page, absolute, without fragments, in document order. */
export function sameOriginLinks(html: string, base: URL): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of html.matchAll(/<a\b[^>]*>/gi)) {
    const href = attrsOf(m[0]).href;
    if (!href || /^(#|mailto:|tel:|javascript:)/i.test(href)) continue;
    let u: URL;
    try {
      u = new URL(href, base);
    } catch {
      continue;
    }
    if (u.origin !== base.origin) continue;
    u.hash = "";
    if (/\.(jpe?g|png|gif|webp|svg|ico|pdf|zip|css|js|mp4|mp3|xml|json|txt|csv)$/i.test(u.pathname)) continue;
    if (seen.has(u.href)) continue;
    seen.add(u.href);
    out.push(u.href);
  }
  return out;
}
