import { describe, expect, it } from "vitest";
import { handleMcpRequest } from "@/lib/mcp";
import { seededDb } from "./helpers";

function rpc(method: string, params: unknown, id = 1): Request {
  return new Request("http://localhost/m/loom-and-thread/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2025-06-18",
      "x-agent-id": "test-agent",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
}

describe("MCP endpoint", () => {
  it("answers initialize", async () => {
    const { db, shop } = seededDb();
    const res = await handleMcpRequest(
      db,
      shop,
      rpc("initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "test", version: "0" },
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.result.serverInfo.name).toBe("quoteloom-loom-and-thread");
    expect(body.result.capabilities.tools).toBeDefined();
  });

  it("lists search_products", async () => {
    const { db, shop } = seededDb();
    const body = await (await handleMcpRequest(db, shop, rpc("tools/list", {}))).json();
    const names = body.result.tools.map((t: { name: string }) => t.name);
    expect(names).toContain("search_products");
  });

  it("runs search_products and logs the agent", async () => {
    const { db, shop } = seededDb();
    const res = await handleMcpRequest(
      db,
      shop,
      rpc("tools/call", { name: "search_products", arguments: { query: "linen throw" } }),
    );
    const body = await res.json();
    expect(body.result.isError).toBeFalsy();
    expect(body.result.structuredContent.results[0].sku).toBe("LT-THROW-LIN-BLU");
    const log = db.prepare("SELECT query, agent_id FROM search_log").get();
    expect(log).toEqual({ query: "linen throw", agent_id: "test-agent" });
  });

  it("rejects invalid arguments", async () => {
    const { db, shop } = seededDb();
    const res = await handleMcpRequest(
      db,
      shop,
      rpc("tools/call", { name: "search_products", arguments: { query: "x", limit: 0 } }),
    );
    const body = await res.json();
    expect(body.error ?? body.result?.isError).toBeTruthy();
  });
});
