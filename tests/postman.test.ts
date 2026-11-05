import fs from "node:fs";
import { describe, expect, it } from "vitest";

type Item = { name: string; item?: Item[]; request?: { method: string; url: { raw: string }; body?: { raw: string } } };

describe("Postman collection", () => {
  const c = JSON.parse(fs.readFileSync("docs/postman/quoteloom.postman_collection.json", "utf8")) as { info: { schema: string }; item: Item[]; variable: { key: string }[] };
  const flat = (items: Item[]): Item[] => items.flatMap((i) => (i.item ? flat(i.item) : [i]));

  it("is a valid v2.1 collection with request bodies that parse as JSON, no secrets", () => {
    expect(c.info.schema).toContain("v2.1.0");
    const reqs = flat(c.item);
    expect(reqs.length).toBeGreaterThan(15);
    for (const r of reqs) if (r.request?.body) expect(() => JSON.parse(r.request!.body!.raw)).not.toThrow();
    expect(c.variable.map((v) => v.key)).toEqual(expect.arrayContaining(["baseUrl", "shop"]));
    expect(JSON.stringify(c)).not.toMatch(/api[_-]?key|secret|bearer/i);
  });

  it("covers every MCP tool", () => {
    const text = JSON.stringify(c);
    for (const t of ["search_products", "get_product", "request_quote", "create_checkout", "get_order_status"]) expect(text).toContain(t);
  });
});
