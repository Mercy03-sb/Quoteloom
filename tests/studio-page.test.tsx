// @vitest-environment happy-dom
import { act, cleanup, render } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { seedDemoHistory } from "@/lib/demo-history";
import { NAV_ITEMS } from "@/components/shell/nav";
import { installTestDb } from "./helpers";

vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined }),
  headers: async () => new Headers({ host: "localhost:3000" }),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push() {}, refresh() {} }), usePathname: () => "/studio" }));

import StudioPage from "@/app/studio/page";
import { StudioBoundary } from "@/components/studio/StudioBoundary";
import { checkLicence } from "@/components/studio/licence";
import { StudioGate } from "@/components/studio/StudioGate";

const sp = { searchParams: Promise.resolve({}) };
let errors: ReturnType<typeof vi.spyOn>;
let warns: ReturnType<typeof vi.spyOn>;

const mediaQuery = (matches: boolean) => {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: () => ({ matches, addEventListener() {}, removeEventListener() {} }),
  });
};

beforeEach(() => {
  vi.stubEnv("CHANNEL3_API_KEY", "");
  errors = vi.spyOn(console, "error").mockImplementation(() => {});
  warns = vi.spyOn(console, "warn").mockImplementation(() => {});
  const { db, shop } = installTestDb();
  seedDemoHistory(db, shop.id);
});
afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

// Any console error or warning during a render counts as a failure.
const noConsoleNoise = () => {
  expect(errors.mock.calls, "console.error calls").toEqual([]);
  expect(warns.mock.calls, "console.warn calls").toEqual([]);
};

describe("/studio page", () => {
  it("is in the nav as Studio", () => {
    expect(NAV_ITEMS.find((n) => n.href === "/studio")?.label).toBe("Studio");
  });

  it("without a licence key renders the AG Grid Community analytics with a notice, and no console output", async () => {
    vi.stubEnv("NEXT_PUBLIC_AG_GRID_LICENSE_KEY", "");
    const out = renderToStaticMarkup(await StudioPage(sp));
    expect(out).toContain("<h1>Studio</h1>");
    expect(out).toContain('data-testid="studio-fallback"');
    expect(out).toContain('data-reason="missing"');
    expect(out).toContain("no licence key is configured");
    for (const id of ["sales", "traffic", "unmet", "disputes"]) expect(out).toContain(`data-section="${id}"`);
    expect(out.match(/data-testid="demo-banner"/g)).toHaveLength(1); // the banner is shown once, not once per layer
    expect(out).not.toContain('data-testid="studio-box"');
    noConsoleNoise();
  });

  it("with a key renders a loading state on the server (Studio loads in the browser only)", async () => {
    vi.stubEnv("NEXT_PUBLIC_AG_GRID_LICENSE_KEY", "dummy-key-for-test");
    const out = renderToStaticMarkup(await StudioPage(sp));
    expect(out).not.toContain('data-testid="studio-fallback"');
    expect(out).not.toContain('data-testid="studio-box"');
    expect(out).toContain("Studio");
    noConsoleNoise();
  });

  it("shows the Community view and a larger-screen notice at phone width", async () => {
    vi.stubEnv("NEXT_PUBLIC_AG_GRID_LICENSE_KEY", "dummy-key-for-test");
    mediaQuery(true);
    const { findByTestId } = render(<StudioGate shop="demo" fallback={<p>community view</p>} />);
    const box = await findByTestId("studio-fallback");
    expect(box.getAttribute("data-reason")).toBe("small");
    expect(box.textContent).toContain("best on a larger screen");
    expect(box.textContent).toContain("community view");
    noConsoleNoise();
  });
});

describe("studio licence guard and error boundary", () => {
  it("treats a garbage key as invalid instead of throwing", () => {
    expect(checkLicence("not-a-real-key")).toEqual({ ok: false, reason: "invalid" });
    expect(checkLicence("")).toEqual({ ok: false, reason: "invalid" });
  });

  it("falls back to the Community view when the Studio chunk crashes", async () => {
    vi.stubEnv("NEXT_PUBLIC_AG_GRID_LICENSE_KEY", "dummy-key-for-test");
    mediaQuery(false);
    const onError = vi.fn();
    function Boom(): never {
      throw new Error("studio exploded");
    }
    await act(async () => {
      render(
        <StudioBoundary onError={onError}>
          <Boom />
        </StudioBoundary>,
      );
    });
    expect(onError).toHaveBeenCalledTimes(1);
    expect(errors.mock.calls.some((c) => String(c[0]).includes("[studio] AG Studio crashed"))).toBe(true);
  });
});
