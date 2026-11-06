import { describe, expect, it } from "vitest";
import { STUDIO_FIELDS, STUDIO_TABLES } from "@/lib/studio-fields";
import { analystInstructions } from "@/lib/studio-instructions";
import { DEFAULT_REPORT } from "@/lib/studio-report";
import { capMessage } from "@/lib/studio-prompts";

const tables = STUDIO_TABLES.map((id) => ({ id, fields: STUDIO_FIELDS[id].map((f) => ({ fieldId: f.id, dataType: "text", roles: ["dimension"] })) }));

describe("analyst instructions (turn 1)", () => {
  const text = analystInstructions(tables, DEFAULT_REPORT as never);
  it("carry the schema, the current page's widgets and a usage note, so no exploring turn is needed", () => {
    expect(text).toContain("orders: ");
    expect(text).toContain("amount");
    expect(text).toContain('Current page "overview"');
    expect(text).toContain("line-chart");
    expect(text).toMatch(/call add_widget/);
    expect(text).toMatch(/at most 4 steps/);
  });
  it("handle an empty page", () => {
    expect(analystInstructions(tables, { pages: [{ id: "p", widgets: {} }], selectedPageId: "p" })).toContain("The current page is empty.");
  });
});

describe("cap message", () => {
  it("says what was done and what is left", () => {
    const m = capMessage([{ type: "function_call", name: "add_widget" }, { type: "function_call", name: "execute_query" }]);
    expect(m).toBe("I added 1 widget and used execute query, but didn't finish within 4 steps (the free quota is limited). Ask me to continue.");
  });
  it("says so when nothing changed", () => {
    expect(capMessage([])).toMatch(/^I didn't get to change the dashboard, but didn't finish/);
  });
});
