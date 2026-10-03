import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { WpClient } from "../src/wp-client.js";
import type { SiteConfig } from "../src/config.js";

/**
 * mcp-adapter 0.7.0 refuses every request after `initialize` that lacks an
 * MCP-Protocol-Version header (-32600). Found on a local dev site, 4 October
 * 2026. These tests pin the header behaviour against a fake server.
 */

const site = {
  id: "fake",
  url: "https://fake.test",
  endpoint: "https://fake.test/wp-json/mcp/mcp-adapter-default-server",
  username: "u",
  appPassword: "p",
} as SiteConfig;

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

type Seen = { method: string; headers: Record<string, string> };

/** A fake mcp-adapter that answers like 0.7.0, header check included. */
function fakeServer(agreed: string, seen: Seen[]): typeof fetch {
  return (async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    const headers = init?.headers as Record<string, string>;
    seen.push({ method: body.method, headers });

    if (body.method === "initialize") {
      return new Response(
        JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { protocolVersion: agreed, capabilities: {} } }),
        { status: 200, headers: { "Content-Type": "application/json", "Mcp-Session-Id": "s1" } },
      );
    }
    if (body.method === "notifications/initialized") {
      return new Response("", { status: 202 });
    }
    if (headers["MCP-Protocol-Version"] !== agreed) {
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: body.id,
          error: { code: -32600, message: `Invalid Request: MCP-Protocol-Version header is required for a ${agreed} session` },
        }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { tools: [{ name: "t" }] } }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
}

test("sends the agreed MCP-Protocol-Version on every request after initialize", async () => {
  const seen: Seen[] = [];
  globalThis.fetch = fakeServer("2025-11-25", seen);

  const tools = await new WpClient(site, 5_000, 5_000).listTools();

  assert.deepEqual(tools, [{ name: "t" }]);
  assert.equal(seen[0].method, "initialize");
  assert.equal(seen[0].headers["MCP-Protocol-Version"], undefined, "initialize itself carries no version header");
  for (const req of seen.slice(1)) {
    assert.equal(req.headers["MCP-Protocol-Version"], "2025-11-25", req.method);
    assert.equal(req.headers["Mcp-Session-Id"], "s1", req.method);
  }
});

test("echoes the version the server picked, not the one we proposed", async () => {
  const seen: Seen[] = [];
  globalThis.fetch = fakeServer("2025-06-18", seen);

  await new WpClient(site, 5_000, 5_000).listTools();

  const list = seen.find((r) => r.method === "tools/list");
  assert.equal(list?.headers["MCP-Protocol-Version"], "2025-06-18");
});

test("proposes 2025-11-25", async () => {
  let proposed: unknown;
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    if (body.method === "initialize") proposed = body.params.protocolVersion;
    return fakeServer("2025-11-25", [])(_url as string, init);
  }) as typeof fetch;

  await new WpClient(site, 5_000, 5_000).listTools();

  assert.equal(proposed, "2025-11-25");
});
