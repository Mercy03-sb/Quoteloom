// Small in-memory fixed-window limiter. One process, disposable state: that is enough for the demo.
// Every costly endpoint is limited twice: per workspace and per IP.

export type Limit = { max: number; windowMs: number };
export type Bucket = "ingest" | "publish" | "chat" | "checkout";

/** Per-bucket limits. The IP limit is looser than the workspace one so shared networks still work. */
export const LIMITS: Record<Bucket, { workspace: Limit; ip: Limit }> = {
  ingest: { workspace: { max: 6, windowMs: 10 * 60_000 }, ip: { max: 12, windowMs: 10 * 60_000 } },
  publish: { workspace: { max: 10, windowMs: 10 * 60_000 }, ip: { max: 20, windowMs: 10 * 60_000 } },
  chat: { workspace: { max: 60, windowMs: 60_000 }, ip: { max: 120, windowMs: 60_000 } },
  checkout: { workspace: { max: 10, windowMs: 60_000 }, ip: { max: 20, windowMs: 60_000 } },
};

type Window = { start: number; count: number };
export type Verdict = { ok: true } | { ok: false; retryAfterSec: number; scope: "workspace" | "ip" };

const MAX_KEYS = 5000;

export class RateLimiter {
  private windows = new Map<string, Window>();

  /** Count one hit against `key`. Returns retry-after seconds when over the limit, else null. */
  private hit(key: string, limit: Limit, now: number): number | null {
    const w = this.windows.get(key);
    if (!w || now - w.start >= limit.windowMs) {
      this.windows.set(key, { start: now, count: 1 });
      return null;
    }
    w.count += 1;
    return w.count > limit.max ? Math.max(1, Math.ceil((w.start + limit.windowMs - now) / 1000)) : null;
  }

  private prune(now: number): void {
    if (this.windows.size < MAX_KEYS) return;
    for (const [k, w] of this.windows) if (now - w.start > 60 * 60_000) this.windows.delete(k);
    if (this.windows.size >= MAX_KEYS) this.windows.clear(); // worst case: forgive everyone rather than leak memory
  }

  check(bucket: Bucket, ids: { workspace: string | null; ip: string }, now = Date.now()): Verdict {
    this.prune(now);
    const lim = LIMITS[bucket];
    if (ids.workspace) {
      const retry = this.hit(`${bucket}:ws:${ids.workspace}`, lim.workspace, now);
      if (retry !== null) return { ok: false, retryAfterSec: retry, scope: "workspace" };
    }
    const retry = this.hit(`${bucket}:ip:${ids.ip}`, lim.ip, now);
    if (retry !== null) return { ok: false, retryAfterSec: retry, scope: "ip" };
    return { ok: true };
  }

  reset(): void {
    this.windows.clear();
  }
}

const g = globalThis as unknown as { __quoteloomLimiter?: RateLimiter };
export const limiter = (): RateLimiter => (g.__quoteloomLimiter ??= new RateLimiter());

/** Client IP: first x-forwarded-for hop (Render sets it), else "unknown". */
export function clientIp(headers: { get(name: string): string | null }): string {
  const xff = headers.get("x-forwarded-for")?.split(",")[0].trim();
  const ip = xff || headers.get("x-real-ip")?.trim() || "unknown";
  return ip.slice(0, 64);
}

/** A 429 response for a failed verdict, or null when the request may proceed. */
export function limitResponse(v: Verdict): Response | null {
  if (v.ok) return null;
  return Response.json(
    { error: "rate_limited", message: `Too many requests. Try again in ${v.retryAfterSec}s.`, retry_after: v.retryAfterSec },
    { status: 429, headers: { "retry-after": String(v.retryAfterSec) } },
  );
}
