import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Badge, Button, Card, EmptyState, Table } from "@/components/ui";
import { addToast, MAX_TOASTS, removeToast, type ToastItem } from "@/components/ui/Toast";
import { ProductCard } from "@/components/catalog/ProductCard";
import { isActive, NAV_ITEMS } from "@/components/shell/nav";
import { stockLabel, stockTone } from "@/components/catalog/types";

const html = renderToStaticMarkup;

describe("ui components", () => {
  it("Button defaults to type=button and applies the variant", () => {
    const out = html(<Button variant="secondary">Save</Button>);
    expect(out).toContain('type="button"');
    expect(out).toContain("btn-secondary");
  });

  it("Badge renders tone and dot classes", () => {
    const out = html(<Badge tone="warning" dot>Simulation mode</Badge>);
    expect(out).toContain("badge-warning");
    expect(out).toContain("badge-dot");
    expect(out).toContain("Simulation mode");
  });

  it("Card shows its title and hero class", () => {
    const out = html(<Card title="Hello" hero>Body</Card>);
    expect(out).toContain("<h3>Hello</h3>");
    expect(out).toContain("card-hero");
  });

  it("EmptyState is announced as status and shows its action", () => {
    const out = html(<EmptyState title="Nothing here" action={<button>Add</button>}>Try adding one.</EmptyState>);
    expect(out).toContain('role="status"');
    expect(out).toContain("Nothing here");
    expect(out).toContain("Add");
  });

  it("Table renders headers, rows and right-aligned numeric cells", () => {
    const out = html(
      <Table
        columns={[
          { key: "n", header: "Name", render: (r: { n: string; v: number }) => r.n },
          { key: "v", header: "Value", numeric: true, render: (r) => r.v },
        ]}
        rows={[{ n: "Scarf", v: 48 }]}
        rowKey={(r) => r.n}
      />,
    );
    expect(out).toContain('scope="col"');
    expect(out).toContain("Scarf");
    expect(out).toContain('class="num"');
  });

  it("ProductCard shows price, SKU and a stock badge", () => {
    const out = html(
      <ProductCard product={{ sku: "LT-1", title: "Scarf", description: "Soft", price_cents: 4800, currency: "USD", stock: 3 }} />,
    );
    expect(out).toContain("48.00");
    expect(out).toContain("LT-1");
    expect(out).toContain("Low: 3 left");
  });
});

describe("toast queue", () => {
  const t = (id: number): ToastItem => ({ id, message: `m${id}`, tone: "info" });

  it("keeps only the newest MAX_TOASTS", () => {
    let list: ToastItem[] = [];
    for (let i = 1; i <= MAX_TOASTS + 2; i++) list = addToast(list, t(i));
    expect(list).toHaveLength(MAX_TOASTS);
    expect(list[list.length - 1].id).toBe(MAX_TOASTS + 2);
  });

  it("removes a toast by id", () => {
    expect(removeToast([t(1), t(2)], 1).map((x) => x.id)).toEqual([2]);
  });
});

describe("navigation and stock helpers", () => {
  it("marks the right nav item active", () => {
    expect(isActive("/", "/")).toBe(true);
    expect(isActive("/catalog", "/")).toBe(false);
    expect(isActive("/catalog", "/catalog")).toBe(true);
    expect(isActive("/catalogue", "/catalog")).toBe(false);
    expect(isActive("/disputes/dsp_1", "/orders", ["/disputes"])).toBe(true);
  });

  it("only links to real pages, the rest are flagged soon", () => {
    expect(NAV_ITEMS.filter((i) => !i.soon).map((i) => i.href)).toEqual(["/", "/setup", "/catalog", "/playground", "/orders", "/settings", "/analytics", "/studio", "/about"]);
  });

  it("classifies stock", () => {
    expect(stockTone(0)).toBe("danger");
    expect(stockTone(5)).toBe("warning");
    expect(stockTone(6)).toBe("success");
    expect(stockLabel(0)).toBe("Out of stock");
  });
});
