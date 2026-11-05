// What Quoteloom is built with and exactly how each tool is used. The About page renders this list,
// and README.md ("Built with") says the same thing. A test keeps the names in sync.
export type BuiltWith = { name: string; how: string };

export const BUILT_WITH: BuiltWith[] = [
  {
    name: "PayPal",
    how:
      "Sandbox only. Checkout uses Orders v2: an order is created from a signed quote and captured after the buyer approves it. " +
      "Webhooks (signature verified) update orders: CHECKOUT.ORDER.APPROVED triggers capture and PAYMENT.CAPTURE.COMPLETED marks the order paid. " +
      "Disputes arrive as webhook events, and each one gets an evidence packet built from the signed quote and the order record. " +
      "The demo mostly uses simulated disputes; the real dispute and provide-evidence calls have not been tested against PayPal.",
  },
  {
    name: "AG Grid Community",
    how: "The tables: catalog, shop setup review, orders, disputes and the analytics page. Themed from the app's own colour tokens, light and dark. Outside /studio there are no enterprise features.",
  },
  {
    name: "AG Studio",
    how:
      "The /studio page: an editable dashboard of the shop's own data (orders, searches, unmet demand, disputes; demo rows are labelled Demo) with a default report already on the page. " +
      "Its chat panel builds dashboards from plain language through the AG Studio Agent Framework, with Gemini as the model behind our own server route, so the key never reaches the browser. " +
      "The assistant can only use Studio's own tools on the open report, and prices and rules are never in the data. " +
      "It runs on a 45-day trial licence that expires on 20 December 2026. Without a working licence, or if Studio fails to load or the screen is small, /studio shows the same analytics with AG Grid Community. " +
      "Without Gemini, the chat says so and its prompt starters still load prebuilt reports.",
  },
  {
    name: "Channel3",
    how:
      "Product search for context only. It gives a market price range of similar items during negotiation and \"consider stocking\" suggestions for searches that found nothing. " +
      "Results are cached in SQLite, with a committed snapshot as the fallback when the key is unset, credits run out or the call fails. It never sets a price.",
  },
  {
    name: "APIMatic Context Plugin",
    how: "Used while writing lib/paypal.ts, to get the PayPal Server SDK calls right. It is a development tool and is not part of the running app.",
  },
  {
    name: "Render",
    how: "Hosts the single Node service on the free tier (render.yaml). SQLite is re-seeded on every start, so state is disposable.",
  },
  {
    name: "Gemini",
    how:
      "Free tier, plain fetch, only through lib/llm.ts. It normalises messy HTML when a shop page has no structured data, can word replies to buyer offers, and is the model behind the AG Studio chat. " +
      "It never decides a price: the price is fixed by code first. Without a key, rule-based code does both jobs.",
  },
  {
    name: "Claude Code",
    how: "Wrote most of the code, tests and docs under human direction. Claude is not called by the running app.",
  },
];
