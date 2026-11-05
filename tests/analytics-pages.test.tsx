import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { seedDemoHistory } from "@/lib/demo-history";
import { issueQuoteDrafted } from "@/lib/quote";
import { installTestDb } from "./helpers";

vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined }),
  headers: async () => new Headers({ host: "localhost:3000" }),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push() {}, refresh() {} }), usePathname: () => "/analytics" }));

import AnalyticsPage from "@/app/analytics/page";
import AgentPlayground from "@/app/playground/page";
import OldChatRoute from "@/app/chat/page";
import QuotePage from "@/app/quote/[quoteId]/page";
import AnalyticsLoading from "@/app/analytics/loading";

const html = renderToStaticMarkup;
const sp = { searchParams: Promise.resolve({}) };
let errors: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.stubEnv("CHANNEL3_API_KEY", ""); // never live in tests
  errors = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("/analytics page", () => {
  it("renders four sections with demo data, a demo banner and no console errors", async () => {
    const { db, shop } = installTestDb();
    seedDemoHistory(db, shop.id);
    const out = html(await AnalyticsPage(sp));
    for (const id of ["sales", "traffic", "unmet", "disputes"]) expect(out).toContain(`data-section="${id}"`);
    expect(out).toContain('data-testid="demo-banner"');
    expect(out).toContain("Demo data.");
    expect(out).not.toContain('data-state="error"');
    expect(out).not.toContain("buy.trychannel3.com");
    expect(errors).not.toHaveBeenCalled();
  });

  it("empty database: every section shows an empty state, not an error", async () => {
    installTestDb();
    const out = html(await AnalyticsPage(sp));
    expect(out.match(/data-state="empty"/g)?.length).toBe(4);
    expect(out).not.toContain("demo-banner");
    expect(errors).not.toHaveBeenCalled();
  });

  it("a failing query degrades that section only, with an error notice", async () => {
    const { db, shop } = installTestDb();
    seedDemoHistory(db, shop.id);
    db.pragma("foreign_keys = OFF");
    db.exec("DROP TABLE disputes");
    const out = html(await AnalyticsPage(sp));
    expect(out).toContain('data-section="disputes" data-state="error"');
    expect(out).toContain('data-section="sales" data-state="ok"');
    expect(out).toContain("could not be loaded");
  });

  it("has a loading state", () => {
    expect(html(<AnalyticsLoading />)).toContain('aria-busy="true"');
  });
});

describe("agent playground rename", () => {
  it("shows the new heading and one-line explanation, and the old /chat route renders the same page", async () => {
    installTestDb();
    const out = html(await AgentPlayground(sp));
    expect(out).toContain("Agent playground");
    expect(out).toContain("built-in test agent");
    expect(out).toContain("MCP URL");
    expect(html(await OldChatRoute(sp))).toContain("Agent playground");
    expect(errors).not.toHaveBeenCalled();
  });
});

describe("quote page market reference", () => {
  it("shows the market line (similar items, no offer link) for a negotiated quote", async () => {
    const { db, shop } = installTestDb();
    const q = await issueQuoteDrafted(db, shop, { sku: "LT-SCARF-WOOL-GRY", qty: 1, offerCents: 3000, agentId: "t" }, { market: { env: {} } });
    const out = html(await QuotePage({ params: Promise.resolve({ quoteId: q.id }) }));
    expect(out).toContain('data-testid="market-line"');
    expect(out).toContain("Market reference (via Channel3");
    expect(out).toMatch(/similar/i);
    expect(out).not.toContain("buy.trychannel3.com");
    expect(errors).not.toHaveBeenCalled();
  });
});
