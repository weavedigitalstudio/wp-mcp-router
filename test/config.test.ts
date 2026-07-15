/**
 * Weave hardening: the registry loader must refuse plain-HTTP sites for
 * non-loopback hosts (Basic auth would leak the Application Password),
 * while still allowing loopback hosts for local development.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.js";

function withSites(sites: unknown, fn: () => void): void {
  const prev = process.env.WP_MCP_ROUTER_SITES;
  process.env.WP_MCP_ROUTER_SITES = JSON.stringify({ sites });
  try {
    fn();
  } finally {
    if (prev === undefined) delete process.env.WP_MCP_ROUTER_SITES;
    else process.env.WP_MCP_ROUTER_SITES = prev;
  }
}

const cred = { username: "agent", appPassword: "xxxx xxxx" };

test("rejects a plain-HTTP site on a non-loopback host", () => {
  withSites([{ id: "bad", url: "http://example.com", ...cred }], () => {
    assert.throws(() => loadConfig(), /plain HTTP/);
  });
});

test("rejects a plain-HTTP custom endpoint on a non-loopback host", () => {
  withSites(
    [{ id: "bad", url: "https://example.com", endpoint: "http://example.com/wp-json/mcp/x", ...cred }],
    () => {
      assert.throws(() => loadConfig(), /plain HTTP/);
    },
  );
});

test("allows plain HTTP for loopback dev hosts", () => {
  withSites([{ id: "dev", url: "http://localhost:8888", ...cred }], () => {
    const { config } = loadConfig();
    assert.equal(config.sites[0].id, "dev");
  });
});

test("allows HTTPS sites", () => {
  withSites([{ id: "ok", url: "https://example.com", ...cred }], () => {
    const { config } = loadConfig();
    assert.equal(config.sites[0].endpoint, "https://example.com/wp-json/mcp/mcp-adapter-default-server");
  });
});
