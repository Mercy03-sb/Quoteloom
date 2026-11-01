// Absolute base URL for links shown to users and passed to PayPal.
// Request host first (works on Render and localhost), then NEXT_PUBLIC_BASE_URL, then localhost.

type HeaderGetter = { get(name: string): string | null };
type Env = Record<string, string | undefined>;

const HOST_RE = /^[a-z0-9.-]+(:\d{1,5})?$/i;

export function resolveBaseUrl(headers?: HeaderGetter, env: Env = process.env): string {
  const host = (headers?.get("x-forwarded-host") ?? headers?.get("host") ?? "").split(",")[0].trim();
  if (host && HOST_RE.test(host)) {
    const forwarded = headers?.get("x-forwarded-proto")?.split(",")[0].trim();
    const local = /^(localhost|127\.0\.0\.1|\[::1\])(:|$)/.test(host);
    const proto = forwarded === "http" || forwarded === "https" ? forwarded : local ? "http" : "https";
    return `${proto}://${host}`;
  }
  const fallback = env.NEXT_PUBLIC_BASE_URL?.trim();
  if (fallback) return fallback.replace(/\/+$/, "");
  return "http://localhost:3000";
}

export function mcpUrl(base: string, slug: string): string {
  return `${base}/m/${slug}/mcp`;
}
