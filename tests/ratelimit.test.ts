import { beforeEach, describe, expect, it } from "vitest";
import { LIMITS, RateLimiter, clientIp, limitResponse, limiter } from "@/lib/ratelimit";

const ids = (workspace: string | null, ip = "1.1.1.1") => ({ workspace, ip });

describe("RateLimiter", () => {
  it("allows up to the workspace limit, then blocks with a retry-after", () => {
    const rl = new RateLimiter();
    const { max } = LIMITS.ingest.workspace;
    for (let i = 0; i < max; i++) expect(rl.check("ingest", ids("ws_a", `9.9.9.${i}`), 0).ok).toBe(true);
    const v = rl.check("ingest", ids("ws_a", "9.9.9.200"), 1000);
    expect(v).toMatchObject({ ok: false, scope: "workspace" });
    expect(v.ok === false && v.retryAfterSec).toBeGreaterThan(0);
  });

  it("limits per IP even when each request has a fresh workspace", () => {
    const rl = new RateLimiter();
    const { max } = LIMITS.ingest.ip;
    for (let i = 0; i < max; i++) expect(rl.check("ingest", ids(`ws_${i}`, "2.2.2.2"), 0).ok).toBe(true);
    expect(rl.check("ingest", ids("ws_new", "2.2.2.2"), 0)).toMatchObject({ ok: false, scope: "ip" });
    expect(rl.check("ingest", ids("ws_new", "3.3.3.3"), 0).ok).toBe(true);
  });

  it("limits IP-only callers (no workspace)", () => {
    const rl = new RateLimiter();
    for (let i = 0; i < LIMITS.checkout.ip.max; i++) rl.check("checkout", ids(null, "4.4.4.4"), 0);
    expect(rl.check("checkout", ids(null, "4.4.4.4"), 0)).toMatchObject({ ok: false, scope: "ip" });
  });

  it("keeps workspaces independent of each other", () => {
    const rl = new RateLimiter();
    for (let i = 0; i < LIMITS.chat.workspace.max + 5; i++) rl.check("chat", ids("ws_a", `5.5.${i}.1`), 0);
    expect(rl.check("chat", ids("ws_a", "6.6.6.6"), 0).ok).toBe(false);
    expect(rl.check("chat", ids("ws_b", "7.7.7.7"), 0).ok).toBe(true);
  });

  it("keeps buckets independent of each other", () => {
    const rl = new RateLimiter();
    for (let i = 0; i < LIMITS.checkout.workspace.max + 1; i++) rl.check("checkout", ids("ws_a", `8.8.${i}.1`), 0);
    expect(rl.check("checkout", ids("ws_a", "8.8.250.1"), 0).ok).toBe(false);
    expect(rl.check("chat", ids("ws_a", "8.8.250.1"), 0).ok).toBe(true);
  });

  it("starts a fresh window after windowMs", () => {
    const rl = new RateLimiter();
    const { max, windowMs } = LIMITS.chat.workspace;
    for (let i = 0; i <= max; i++) rl.check("chat", ids("ws_a", `1.2.${i}.3`), 0);
    expect(rl.check("chat", ids("ws_a", "1.2.250.3"), windowMs - 1).ok).toBe(false);
    expect(rl.check("chat", ids("ws_a", "1.2.250.3"), windowMs).ok).toBe(true);
  });

  it("covers ingest, chat and checkout with both a workspace and an IP limit", () => {
    for (const b of ["ingest", "chat", "checkout"] as const) {
      expect(LIMITS[b].workspace.max).toBeGreaterThan(0);
      expect(LIMITS[b].ip.max).toBeGreaterThanOrEqual(LIMITS[b].workspace.max);
    }
  });
});

describe("helpers", () => {
  beforeEach(() => limiter().reset());

  it("returns a 429 with Retry-After for a failed verdict, and null for ok", async () => {
    expect(limitResponse({ ok: true })).toBeNull();
    const res = limitResponse({ ok: false, retryAfterSec: 12, scope: "ip" });
    expect(res?.status).toBe(429);
    expect(res?.headers.get("retry-after")).toBe("12");
    expect(await res?.json()).toMatchObject({ error: "rate_limited", retry_after: 12 });
  });

  it("reads the client IP from x-forwarded-for, first hop", () => {
    expect(clientIp(new Headers({ "x-forwarded-for": "203.0.113.9, 10.0.0.1" }))).toBe("203.0.113.9");
    expect(clientIp(new Headers())).toBe("unknown");
  });
});
