import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../src/server.js";
import { cleanRules, rulesFromRoute, rulesFromSiteInfo, MAX_RULES_CHARS } from "../src/site-rules.js";
import { restRouteUrl } from "../src/wp-client.js";
import type { FleetConfig } from "../src/config.js";

/**
 * Block MCP's custom instructions (a site's rules for agents) never reached
 * router agents: Block MCP 2.2.1 serves them only to its own Node server
 * (Roots & Fruit review, 26 October 2026). The router now attaches them to the
 * first wp_run on each site. These tests run the real server over an
 * in-memory MCP pair, against fake sites behind a fake fetch.
 */

// Tool calls would otherwise append to the real audit log in ~/.local/state.
process.env.WP_MCP_ROUTER_AUDIT = "off";

const RULES = "Content only.\n\nNever use em dashes. Undo by writing back the content you read.";

interface FakeSite {
  abilities: string[];
  /** weave/get-site-info output; omit agent_instructions to act like 0.9.4. */
  siteInfo?: Record<string, unknown>;
  siteInfoDelayMs?: number;
  /** Block MCP's instructions route. hang: never answers (until aborted). */
  route?: { status: number; body?: unknown; hang?: boolean; delayMs?: number };
  /** The agent's own ability call throws a network error. */
  down?: boolean;
}

type Log = string[];

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
}

function wait(ms: number, signal?: AbortSignal | null): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      reject(Object.assign(new Error("This operation was aborted"), { name: "AbortError" }));
    });
  });
}

/** One fetch for a fleet of fake mcp-adapter sites at https://<id>.test. */
function fakeFleet(sites: Record<string, FakeSite>, log: Log): typeof fetch {
  return (async (input: unknown, init?: RequestInit) => {
    const url = new URL(String(input));
    const id = url.hostname.replace(/\.test$/, "");
    const site = sites[id];
    const signal = init?.signal;

    if ((init?.method ?? "GET") === "GET") {
      log.push(`${id} GET ${url.pathname}`);
      const route = site.route ?? { status: 404, body: { code: "rest_no_route" } };
      if (route.hang) {
        await wait(60_000, signal);
      }
      if (route.delayMs) await wait(route.delayMs, signal);
      return json(route.body ?? {}, route.status);
    }

    const body = JSON.parse(String(init?.body));
    if (body.method === "initialize") {
      return json({ jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2025-11-25", capabilities: {} } }, 200, {
        "Mcp-Session-Id": `s-${id}`,
      });
    }
    if (body.method === "notifications/initialized") return new Response("", { status: 202 });

    const { name, arguments: args } = body.params;
    if (name === "mcp-adapter-discover-abilities") {
      const text = JSON.stringify({ abilities: site.abilities.map((n) => ({ name: n, description: n })) });
      return json({ jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text }] } });
    }
    if (name === "mcp-adapter-execute-ability") {
      log.push(`${id} run ${args.ability_name}`);
      if (args.ability_name === "weave/get-site-info") {
        if (site.siteInfoDelayMs) await wait(site.siteInfoDelayMs, signal);
        const text = JSON.stringify({ success: true, data: site.siteInfo ?? { site_url: `https://${id}.test` } });
        return json({ jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text }] } });
      }
      if (site.down) throw Object.assign(new Error("fetch failed"), { cause: { code: "ECONNRESET" } });
      const text = JSON.stringify({ success: true, data: { ok: args.ability_name } });
      return json({ jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text }] } });
    }
    return json({ jsonrpc: "2.0", id: body.id, error: { code: -32601, message: "nope" } });
  }) as typeof fetch;
}

function configFor(ids: string[], extra: Partial<FleetConfig> = {}): FleetConfig {
  return {
    sites: ids.map((id) => ({
      id,
      label: id,
      url: `https://${id}.test`,
      endpoint: `https://${id}.test/wp-json/mcp/mcp-adapter-default-server`,
      username: "u",
      appPassword: "p",
      tags: [],
      excludeFromFanout: false,
    })),
    defaultSite: ids[0],
    catalogTtlMs: 60_000,
    requestTimeoutMs: 5_000,
    initTimeoutMs: 5_000,
    rulesTimeoutMs: 1_000,
    ...extra,
  };
}

async function connect(config: FleetConfig) {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await buildServer(config).connect(serverSide);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(clientSide);
  const call = async (name: string, args: Record<string, unknown>) => {
    const res: any = await client.callTool({ name, arguments: args });
    return JSON.parse(res.content[0].text);
  };
  return { call, close: () => client.close() };
}

const WITH_FIELD = {
  abilities: ["weave/get-site-info", "weave/get-post"],
  siteInfo: {
    site_url: "https://new.test",
    agent_instructions: { text: RULES, updated_at: "2026-10-20T02:12:00Z", source: "gk-block-mcp" },
  },
};

test("the first wp_run on a site carries its rules from get-site-info, later ones do not", async () => {
  const log: Log = [];
  globalThis.fetch = fakeFleet({ new: WITH_FIELD }, log);
  const { call, close } = await connect(configFor(["new"]));

  const first = await call("wp_run", { site: "new", ability_name: "weave/get-post", arguments: { id: 1 } });
  assert.equal(first.site_rules.text, RULES);
  assert.equal(first.site_rules.source, "weave/get-site-info");
  assert.equal(first.site_rules.updated_at, "2026-10-20T02:12:00Z");
  assert.match(first.site_rules.about, /rules this site's administrators set for AI agents/);
  assert.match(first.result.content[0].text, /weave\/get-post/, "the agent's own result is untouched");
  assert.deepEqual(Object.keys(first).slice(0, 4), ["site", "ability", "site_rules", "result"], "rules come before the result");

  const second = await call("wp_run", { site: "new", ability_name: "weave/get-post", arguments: { id: 2 } });
  assert.equal(second.site_rules, undefined);
  assert.equal(second.site_rules_note, undefined);
  assert.ok(!log.some((l) => l.includes("GET")), "the public route is not needed when the field is there");
  assert.equal(log.filter((l) => l === "new run weave/get-site-info").length, 1, "looked up once per session");
  await close();
});

test("a site on weave-abilities 0.9.4 gets its rules from Block MCP's route", async () => {
  const log: Log = [];
  globalThis.fetch = fakeFleet(
    {
      old: {
        abilities: ["weave/get-site-info", "weave/get-post"],
        route: { status: 200, body: { addendum: RULES, length: RULES.length, max_length: 2000, updated_at: 1792462320 } },
      },
    },
    log,
  );
  const { call, close } = await connect(configFor(["old"]));

  const first = await call("wp_run", { ability_name: "weave/get-post", arguments: {} });
  assert.equal(first.site_rules.text, RULES);
  assert.equal(first.site_rules.source, "/wp-json/gk-block-api/v1/instructions");
  assert.equal(first.site_rules.updated_at, "2026-10-20T02:12:00Z");
  assert.ok(log.includes("old GET /wp-json/gk-block-api/v1/instructions"));
  await close();
});

test("when the agent's first call is get-site-info, the router reads that result instead of calling it twice", async () => {
  const log: Log = [];
  globalThis.fetch = fakeFleet({ new: WITH_FIELD }, log);
  const { call, close } = await connect(configFor(["new"]));

  const first = await call("wp_run", { ability_name: "weave/get-site-info" });
  assert.equal(first.site_rules.text, RULES);
  assert.equal(log.filter((l) => l === "new run weave/get-site-info").length, 1);
  await close();
});

test("a site without Block MCP adds nothing and is not asked again", async () => {
  const log: Log = [];
  globalThis.fetch = fakeFleet({ bb: { abilities: ["weave/get-post"] } }, log);
  const { call, close } = await connect(configFor(["bb"]));

  const first = await call("wp_run", { ability_name: "weave/get-post" });
  const second = await call("wp_run", { ability_name: "weave/get-post" });
  assert.equal(first.site_rules, undefined);
  assert.equal(first.site_rules_note, undefined);
  assert.equal(second.site_rules, undefined);
  assert.equal(log.filter((l) => l.includes("GET")).length, 1);
  await close();
});

test("Block MCP with empty instructions says so once, briefly", async () => {
  const log: Log = [];
  globalThis.fetch = fakeFleet(
    {
      empty: {
        abilities: ["weave/get-site-info", "weave/get-post"],
        siteInfo: { agent_instructions: { text: "", updated_at: "", source: "gk-block-mcp" } },
      },
    },
    log,
  );
  const { call, close } = await connect(configFor(["empty"]));

  const first = await call("wp_run", { ability_name: "weave/get-post" });
  assert.match(first.site_rules.about, /custom instructions are empty/);
  assert.equal(first.site_rules.text, undefined);
  await close();
});

test("a lookup that never answers costs at most the budget, adds a note, and is retried a few times only", async () => {
  const log: Log = [];
  globalThis.fetch = fakeFleet({ slow: { abilities: ["weave/get-post"], route: { status: 200, hang: true } } }, log);
  const { call, close } = await connect(configFor(["slow"], { rulesTimeoutMs: 150 }));

  const started = Date.now();
  const first = await call("wp_run", { ability_name: "weave/get-post" });
  const took = Date.now() - started;
  assert.ok(took < 1_000, `call returned in ${took}ms`);
  assert.match(first.result.content[0].text, /weave\/get-post/, "the call itself still answers");
  assert.match(first.site_rules_note, /Could not read slow's agent rules: no answer within 150 ms/);
  assert.match(first.site_rules_note, /Trying again/);

  const second = await call("wp_run", { ability_name: "weave/get-post" });
  const third = await call("wp_run", { ability_name: "weave/get-post" });
  const fourth = await call("wp_run", { ability_name: "weave/get-post" });
  assert.match(second.site_rules_note, /Trying again/);
  assert.match(third.site_rules_note, /Not trying again this session/);
  assert.equal(fourth.site_rules_note, undefined);
  assert.equal(log.filter((l) => l.includes("GET")).length, 3);

  const sites = await call("wp_list_sites", {});
  assert.match(sites.sites[0].agent_rules, /unreadable this session/);
  await close();
});

test("a rate-limited route is a failure to retry, not 'no rules'", async () => {
  globalThis.fetch = fakeFleet({ busy: { abilities: ["weave/get-post"], route: { status: 429, body: { code: "rate_limit_exceeded" } } } }, []);
  const { call, close } = await connect(configFor(["busy"]));

  const first = await call("wp_run", { ability_name: "weave/get-post" });
  assert.match(first.site_rules_note, /rate-limited/);
  await close();
});

test("if the agent's call fails, the rules go out with the next call instead", async () => {
  const sites: Record<string, FakeSite> = { flaky: { ...WITH_FIELD, down: true } };
  globalThis.fetch = fakeFleet(sites, []);
  const { call, close } = await connect(configFor(["flaky"]));

  const first = await call("wp_run", { ability_name: "weave/get-post" });
  assert.ok(first.error, "the failure is reported as before");
  sites.flaky.down = false;
  const second = await call("wp_run", { ability_name: "weave/get-post" });
  assert.equal(second.site_rules.text, RULES);
  await close();
});

test("parallel first calls on one site send the rules once", async () => {
  globalThis.fetch = fakeFleet({ new: { ...WITH_FIELD, siteInfoDelayMs: 50 } }, []);
  const { call, close } = await connect(configFor(["new"]));

  const results = await Promise.all([1, 2, 3].map((id) => call("wp_run", { ability_name: "weave/get-post", arguments: { id } })));
  assert.equal(results.filter((r) => r.site_rules).length, 1);
  await close();
});

test("rules are per site: each site sends its own, once", async () => {
  globalThis.fetch = fakeFleet(
    {
      new: WITH_FIELD,
      other: { abilities: ["weave/get-post"], route: { status: 200, body: { addendum: "Other site rules.", updated_at: 0 } } },
    },
    [],
  );
  const { call, close } = await connect(configFor(["new", "other"]));

  const a = await call("wp_run", { site: "new", ability_name: "weave/get-post" });
  const b = await call("wp_run", { site: "other", ability_name: "weave/get-post" });
  assert.equal(a.site_rules.text, RULES);
  assert.equal(b.site_rules.text, "Other site rules.");
  assert.equal(b.site_rules.updated_at, undefined, "no timestamp when the route has none");
  await close();
});

test("wp_list_sites shows what was sent, and refresh sends the rules again", async () => {
  globalThis.fetch = fakeFleet({ new: WITH_FIELD }, []);
  const { call, close } = await connect(configFor(["new"]));

  const before = await call("wp_list_sites", {});
  assert.equal(before.sites[0].agent_rules, undefined, "nothing is fetched just to list sites");
  await call("wp_run", { ability_name: "weave/get-post" });
  const after = await call("wp_list_sites", {});
  assert.equal(after.sites[0].agent_rules, "sent with the first wp_run");

  await call("wp_list_sites", { refresh: true });
  const again = await call("wp_run", { ability_name: "weave/get-post" });
  assert.equal(again.site_rules.text, RULES);
  await close();
});

test("siteRules false turns the lookup off", async () => {
  const log: Log = [];
  globalThis.fetch = fakeFleet({ new: WITH_FIELD }, log);
  const { call, close } = await connect(configFor(["new"], { siteRules: false }));

  const first = await call("wp_run", { ability_name: "weave/get-post" });
  assert.equal(first.site_rules, undefined);
  assert.ok(!log.includes("new run weave/get-site-info"));
  await close();
});

test("wp_run_across is unchanged: no rules attached to a fan-out", async () => {
  globalThis.fetch = fakeFleet({ new: WITH_FIELD }, []);
  const { call, close } = await connect(configFor(["new"]));

  const out = await call("wp_run_across", { ability_name: "weave/get-post" });
  assert.equal(out.outcomes[0].status, "ok");
  assert.equal(JSON.stringify(out).includes("site_rules"), false);
  await close();
});

test("cleanRules drops hidden characters and keeps Block MCP's 2,000 character cap", () => {
  assert.equal(cleanRules("  Line one\r\nLine two\u202E\u200B\u0007 \tend  "), "Line one\nLine two \tend");
  const long = cleanRules("é".repeat(MAX_RULES_CHARS + 50));
  assert.ok(long.startsWith("é".repeat(MAX_RULES_CHARS)));
  assert.ok(long.endsWith("[cut at 2,000 characters]"));
});

test("rulesFromSiteInfo reads the field and ignores errors and older results", () => {
  const env = (data: unknown, isError = false) => ({ isError, content: [{ type: "text", text: JSON.stringify({ success: true, data }) }] });
  assert.equal(rulesFromSiteInfo(env({ agent_instructions: { text: "Rules.", updated_at: "" } }))?.kind, "found");
  assert.equal(rulesFromSiteInfo(env({ site_url: "x" })), undefined, "0.9.4 has no field");
  assert.equal(rulesFromSiteInfo(env({ agent_instructions: { text: "Rules." } }, true)), undefined);
  assert.equal(rulesFromSiteInfo({ content: [{ type: "text", text: "not json" }] }), undefined);
});

test("rulesFromRoute maps each answer", () => {
  assert.deepEqual(rulesFromRoute(404, { code: "rest_no_route" }), { kind: "absent" });
  assert.equal(rulesFromRoute(200, { addendum: "  " }).kind, "empty");
  assert.equal(rulesFromRoute(200, undefined).kind, "failed", "a WAF page is not 'no rules'");
  assert.equal(rulesFromRoute(503, {}).kind, "failed");
});

test("restRouteUrl follows the endpoint's form", () => {
  assert.equal(
    restRouteUrl("https://a.test/wp-json/mcp/mcp-adapter-default-server", "https://a.test", "/gk-block-api/v1/instructions"),
    "https://a.test/wp-json/gk-block-api/v1/instructions",
  );
  assert.equal(
    restRouteUrl("https://a.test/sub/wp-json/mcp/x", "https://a.test/sub", "/gk-block-api/v1/instructions"),
    "https://a.test/sub/wp-json/gk-block-api/v1/instructions",
  );
  assert.equal(
    restRouteUrl("https://a.test/?rest_route=/mcp/mcp-adapter-default-server", "https://a.test", "/gk-block-api/v1/instructions"),
    "https://a.test/?rest_route=%2Fgk-block-api%2Fv1%2Finstructions",
  );
  assert.equal(restRouteUrl("https://a.test/custom-mcp", "https://a.test/", "/x"), "https://a.test/wp-json/x");
});
