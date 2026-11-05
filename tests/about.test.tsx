import fs from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import AboutPage from "@/app/about/page";
import { BUILT_WITH } from "@/lib/built-with";

describe("About page and README", () => {
  it("lists every tool in the page and in the README Built with section", () => {
    const html = renderToStaticMarkup(<AboutPage />);
    const readme = fs.readFileSync("README.md", "utf8");
    expect(readme).toContain("## Built with");
    for (const t of BUILT_WITH) {
      expect(html).toContain(t.name);
      expect(readme).toContain(t.name);
    }
    expect(BUILT_WITH.map((t) => t.name)).toEqual(["PayPal", "AG Grid Community", "Channel3", "APIMatic Context Plugin", "Render", "Gemini", "Claude Code"]);
  });
});
