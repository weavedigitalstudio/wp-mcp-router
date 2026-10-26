import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../src/server.js";
import { cleanRules, decideRules, rulesFromRoute, rulesFromSiteInfo, MAX_RULES_CHARS } from "../src/site-rules.js";
import { restRouteUrl } from "../src/wp-client.js";
import type { FleetConfig } from "../src/config.js";

/**
 * Block MCP's custom instructions (a site's rules for agents) never reached
 * router agents: Block MCP 2.2.1 serves them only to its own Node server
 * (Roots & Fruit review, 26 October 2026). The router now attaches them to the
 * first wp_run on each site, or the next one when the lookup is slower than
 * the call. It never waits for them: the first version held the agent's result
 * for up to 5 seconds on a slow site. These tests run the real server over an
 * in-memory MCP pair, against fake sites behind a fake fetch.
 */

// Tool calls would otherwise append to the real audit log in ~/.local/state.
process.env.WP_MCP_ROUTER_AUDIT = "off";

const RULES = "Content only.\n\nNever use em dashes. Undo by writing back the content you read.";

/** An agent's call slow enough that a lookup on an instant fake site is in first. */
const IN_TIME = 40;

interface FakeSite {
  abilities: string[];
  /** weave/get-site-info output; omit agent_instructions to act like 0.9.4. */
  siteInfo?: Record<string, unknown>;
  siteInfoDelayMs?: number;
  /** Block MCP's instructions route. hang: never answers (until aborted). */
  route?: { status: number; body?: unknown; hang?: boolean; delayMs?: number };
  /** How long the agent's own ability call takes (any ability but get-site-info). */
  runDelayMs?: number;
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
      if (site.runDelayMs) await wait(site.runDelayMs, signal);
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
  /** A call plus how long it took, in ms. */
  const timed = async (name: string, args: Record<string, unknown>) => {
    const started = Date.now();
    const out = await call(name, args);
    return { out, ms: Date.now() - started };
  };
  return { call, timed, close: () => client.close() };
}

const WITH_FIELD = {
  abilities: ["weave/get-site-info", "weave/get-post"],
  siteInfo: {
    site_url: "https://new.test",
    agent_instructions: { text: RULES, updated_at: "2026-10-20T02:12:00Z", source: "gk-block-mcp" },
  },
};

/** weave-abilities 0.9.4 with Block MCP 2.2.1: no field, rules on the route. */
const ON_094 = {
  abilities: ["weave/get-site-info", "weave/get-post"],
  route: { status: 200, body: { addendum: RULES, length: RULES.length, max_length: 2000, updated_at: 1792462320 } },
};

const ROUTE_SOURCE = "/wp-json/gk-block-api/v1/instructions";

test("ready in time: the first wp_run carries the rules, later ones do not", async () => {
  const log: Log = [];
  globalThis.fetch = fakeFleet({ new: { ...WITH_FIELD, runDelayMs: IN_TIME } }, log);
  const { call, close } = await connect(configFor(["new"]));

  const first = await call("wp_run", { site: "new", ability_name: "weave/get-post", arguments: { id: 1 } });
  assert.equal(first.site_rules.text, RULES);
  assert.equal(first.site_rules.source, "weave/get-site-info", "get-site-info's field is preferred when it is in");
  assert.equal(first.site_rules.updated_at, "2026-10-20T02:12:00Z");
  assert.equal(first.site_rules.arrived_late, undefined);
  assert.equal(first.site_rules_pending, undefined);
  assert.match(first.site_rules.about, /rules this site's administrators set for AI agents/);
  assert.match(first.result.content[0].text, /weave\/get-post/, "the agent's own result is untouched");
  assert.deepEqual(Object.keys(first).slice(0, 4), ["site", "ability", "site_rules", "result"], "rules come before the result");

  const second = await call("wp_run", { site: "new", ability_name: "weave/get-post", arguments: { id: 2 } });
  assert.equal(second.site_rules, undefined);
  assert.equal(second.site_rules_note, undefined);
  assert.equal(second.site_rules_pending, undefined);

  // Both sources were asked at once, the route first, and once per session.
  const routeAt = log.indexOf(`new GET ${ROUTE_SOURCE}`);
  const infoAt = log.indexOf("new run weave/get-site-info");
  assert.ok(routeAt >= 0 && infoAt >= 0, log.join(" | "));
  assert.ok(routeAt < infoAt, "the route is sent first");
  assert.equal(log.filter((l) => l.includes("GET")).length, 1);
  assert.equal(log.filter((l) => l === "new run weave/get-site-info").length, 1);
  await close();
});

test("a site on weave-abilities 0.9.4 gets its rules from Block MCP's route", async () => {
  const log: Log = [];
  globalThis.fetch = fakeFleet({ old: { ...ON_094, runDelayMs: IN_TIME } }, log);
  const { call, close } = await connect(configFor(["old"]));

  const first = await call("wp_run", { ability_name: "weave/get-post", arguments: {} });
  assert.equal(first.site_rules.text, RULES);
  assert.equal(first.site_rules.source, ROUTE_SOURCE);
  assert.equal(first.site_rules.updated_at, "2026-10-20T02:12:00Z");
  assert.ok(log.includes(`old GET ${ROUTE_SOURCE}`));
  await close();
});

test("late: the call is never held, and rules that miss it go out with the next wp_run, marked late", async () => {
  const log: Log = [];
  globalThis.fetch = fakeFleet({ slow: { ...ON_094, route: { ...ON_094.route, delayMs: 300 } } }, log);
  const { call, timed, close } = await connect(configFor(["slow"]));

  const first = await timed("wp_run", { ability_name: "weave/get-post" });
  assert.ok(first.ms < 150, `the first call returned in ${first.ms} ms, not after the 300 ms lookup`);
  assert.equal(first.out.site_rules, undefined);
  assert.match(first.out.site_rules_pending, /The router was still checking slow for agent rules when this call returned/);
  assert.match(first.out.site_rules_pending, /Make your next call a read if you were about to write/);
  assert.match(first.out.result.content[0].text, /weave\/get-post/);

  const second = await timed("wp_run", { ability_name: "weave/get-post" });
  assert.ok(second.ms < 150, `the second call returned in ${second.ms} ms`);
  assert.ok(second.out.site_rules_pending, "still on the way");

  await wait(350);
  const third = await call("wp_run", { ability_name: "weave/get-post" });
  assert.equal(third.site_rules.text, RULES);
  assert.equal(third.site_rules.source, ROUTE_SOURCE);
  assert.match(third.site_rules.arrived_late, /These arrived late/);
  assert.match(third.site_rules.arrived_late, /2 earlier wp_run calls on slow ran without them/);
  assert.equal(third.site_rules_pending, undefined);

  const fourth = await call("wp_run", { ability_name: "weave/get-post" });
  assert.equal(fourth.site_rules, undefined);
  assert.equal(fourth.site_rules_pending, undefined);
  assert.equal(log.filter((l) => l.includes("GET")).length, 1, "one lookup, however many calls it took to deliver");

  const sites = await call("wp_list_sites", {});
  assert.equal(sites.sites[0].agent_rules, "sent late, with a later wp_run");
  await close();
});

test("get-site-info as the agent's own first call: its result is the source, and the router does not call it again", async () => {
  // With the field: the agent's own result settles it at once, even though
  // the route is slow, so the rules are in time and nothing waits.
  const log: Log = [];
  globalThis.fetch = fakeFleet({ new: { ...WITH_FIELD, route: { status: 200, body: { addendum: RULES }, delayMs: 300 } } }, log);
  const { timed, close } = await connect(configFor(["new"]));

  const first = await timed("wp_run", { ability_name: "weave/get-site-info" });
  assert.ok(first.ms < 150, `returned in ${first.ms} ms`);
  assert.equal(first.out.site_rules.text, RULES);
  assert.equal(first.out.site_rules.source, "weave/get-site-info");
  assert.equal(first.out.site_rules.arrived_late, undefined);
  assert.equal(log.filter((l) => l === "new run weave/get-site-info").length, 1, "only the agent's own call");
  assert.ok(log.includes(`new GET ${ROUTE_SOURCE}`), "the route was asked beside it");
  await close();
});

test("get-site-info as the agent's own first call on 0.9.4: no field, so the route's answer follows with the next call", async () => {
  const log: Log = [];
  globalThis.fetch = fakeFleet({ old: { ...ON_094, route: { ...ON_094.route, delayMs: 200 } } }, log);
  const { call, timed, close } = await connect(configFor(["old"]));

  const first = await timed("wp_run", { ability_name: "weave/get-site-info" });
  assert.ok(first.ms < 150, `returned in ${first.ms} ms`);
  assert.equal(first.out.site_rules, undefined);
  assert.ok(first.out.site_rules_pending);

  await wait(250);
  const second = await call("wp_run", { ability_name: "weave/get-post" });
  assert.equal(second.site_rules.text, RULES);
  assert.equal(second.site_rules.source, ROUTE_SOURCE);
  assert.match(second.site_rules.arrived_late, /1 earlier wp_run on old ran without them. Check anything it changed/);
  assert.equal(log.filter((l) => l === "old run weave/get-site-info").length, 1, "the router never sent its own");
  await close();
});

test("failure: a lookup that never answers adds only the short note, and is tried three times a session at most", async () => {
  const log: Log = [];
  globalThis.fetch = fakeFleet({ slow: { abilities: ["weave/get-post"], route: { status: 200, hang: true } } }, log);
  const { call, timed, close } = await connect(configFor(["slow"], { rulesTimeoutMs: 300 }));

  const first = await timed("wp_run", { ability_name: "weave/get-post" });
  assert.ok(first.ms < 150, `returned in ${first.ms} ms, not after the 300 ms budget`);
  assert.match(first.out.result.content[0].text, /weave\/get-post/, "the call itself still answers");
  assert.equal(first.out.site_rules_note, undefined, "no failure yet, just on the way");
  assert.ok(first.out.site_rules_pending);

  await wait(400);
  const second = await call("wp_run", { ability_name: "weave/get-post" });
  assert.match(second.site_rules_note, /Could not read slow's agent rules: no answer within 300 ms/);
  assert.match(second.site_rules_note, /Trying again/);
  assert.equal(second.site_rules, undefined);
  assert.equal(second.site_rules_pending, undefined);

  // Each later wp_run starts the next try; the one after it reports.
  await call("wp_run", { ability_name: "weave/get-post" });
  await wait(400);
  const fourth = await call("wp_run", { ability_name: "weave/get-post" });
  assert.match(fourth.site_rules_note, /Trying again/);
  await call("wp_run", { ability_name: "weave/get-post" });
  await wait(400);
  const sixth = await call("wp_run", { ability_name: "weave/get-post" });
  assert.match(sixth.site_rules_note, /Not trying again this session/);

  const seventh = await call("wp_run", { ability_name: "weave/get-post" });
  assert.deepEqual(Object.keys(seventh), ["site", "ability", "result"], "after giving up, nothing is added");
  assert.equal(log.filter((l) => l.includes("GET")).length, 3);

  const sites = await call("wp_list_sites", {});
  assert.match(sites.sites[0].agent_rules, /unreadable this session/);
  await close();
});

test("rules that land just after the deadline, before the next call, go out instead of the failure", async () => {
  // Budget 100 ms, route answers at 150 ms: the deadline has written a
  // failure, but the requests run a little past it, and the text is in by
  // the next call, so the agent gets the rules, not a note.
  globalThis.fetch = fakeFleet({ edge: { abilities: ["weave/get-post"], route: { ...ON_094.route, delayMs: 150 } } }, []);
  const { call, close } = await connect(configFor(["edge"], { rulesTimeoutMs: 100 }));

  const first = await call("wp_run", { ability_name: "weave/get-post" });
  assert.ok(first.site_rules_pending);
  await wait(250);
  const second = await call("wp_run", { ability_name: "weave/get-post" });
  assert.equal(second.site_rules_note, undefined);
  assert.equal(second.site_rules.text, RULES);
  assert.match(second.site_rules.arrived_late, /1 earlier wp_run/);
  await close();
});

test("a rate-limited route is a failure to retry, not 'no rules'", async () => {
  globalThis.fetch = fakeFleet(
    { busy: { abilities: ["weave/get-post"], runDelayMs: IN_TIME, route: { status: 429, body: { code: "rate_limit_exceeded" } } } },
    [],
  );
  const { call, close } = await connect(configFor(["busy"]));

  const first = await call("wp_run", { ability_name: "weave/get-post" });
  assert.match(first.site_rules_note, /rate-limited/);
  await close();
});

test("get-site-info's field covers a route that fails", async () => {
  globalThis.fetch = fakeFleet({ new: { ...WITH_FIELD, runDelayMs: IN_TIME, route: { status: 429, body: {} } } }, []);
  const { call, close } = await connect(configFor(["new"]));

  const first = await call("wp_run", { ability_name: "weave/get-post" });
  assert.equal(first.site_rules.text, RULES);
  assert.equal(first.site_rules.source, "weave/get-site-info");
  assert.equal(first.site_rules_note, undefined);
  await close();
});

test("the route's answer is enough on its own: it does not wait for a slow get-site-info", async () => {
  globalThis.fetch = fakeFleet(
    { new: { ...WITH_FIELD, siteInfoDelayMs: 400, runDelayMs: IN_TIME, route: { status: 200, body: { addendum: RULES } } } },
    [],
  );
  const { timed, close } = await connect(configFor(["new"]));

  const first = await timed("wp_run", { ability_name: "weave/get-post" });
  assert.ok(first.ms < 300, `returned in ${first.ms} ms`);
  assert.equal(first.out.site_rules.text, RULES);
  assert.equal(first.out.site_rules.source, ROUTE_SOURCE);
  await close();
});

test("when both are in by the time the call returns, get-site-info's field is the one sent", async () => {
  globalThis.fetch = fakeFleet(
    { new: { ...WITH_FIELD, siteInfoDelayMs: 20, runDelayMs: 100, route: { status: 200, body: { addendum: "Route copy." } } } },
    [],
  );
  const { call, close } = await connect(configFor(["new"]));

  const first = await call("wp_run", { ability_name: "weave/get-post" });
  assert.equal(first.site_rules.source, "weave/get-site-info");
  assert.equal(first.site_rules.text, RULES);
  await close();
});

test("a site without Block MCP adds nothing and is not asked again", async () => {
  const log: Log = [];
  globalThis.fetch = fakeFleet({ bb: { abilities: ["weave/get-post"], runDelayMs: IN_TIME } }, log);
  const { call, close } = await connect(configFor(["bb"]));

  const first = await call("wp_run", { ability_name: "weave/get-post" });
  const second = await call("wp_run", { ability_name: "weave/get-post" });
  assert.deepEqual(Object.keys(first), ["site", "ability", "result"]);
  assert.deepEqual(Object.keys(second), ["site", "ability", "result"]);
  assert.equal(log.filter((l) => l.includes("GET")).length, 1);
  await close();
});

test("no Block MCP, call faster than get-site-info: the route's 404 settles it, so nothing is promised", async () => {
  // The race from the 0.5.6 review: the 404 is in before the call returns,
  // but get-site-info is slower than the call. 0.5.6 waited on get-site-info,
  // so the call went back with site_rules_pending, which promised rules with
  // the next wp_run, and none ever came. A 404 means no Block MCP, and
  // get-site-info only has the field when Block MCP is active, so the 404 is
  // the answer on its own.
  const log: Log = [];
  globalThis.fetch = fakeFleet(
    { bare: { abilities: ["weave/get-site-info", "weave/get-post"], siteInfoDelayMs: 300, runDelayMs: IN_TIME } },
    log,
  );
  const { call, timed, close } = await connect(configFor(["bare"]));

  const first = await timed("wp_run", { ability_name: "weave/get-post" });
  assert.ok(first.ms < 200, `returned in ${first.ms} ms, not after the 300 ms get-site-info`);
  assert.deepEqual(Object.keys(first.out), ["site", "ability", "result"], "no site_rules_pending: nothing is on the way");
  assert.ok(log.includes("bare run weave/get-site-info"), "get-site-info was asked beside the route");

  const sites = await call("wp_list_sites", {});
  assert.equal(sites.sites[0].agent_rules, "none (no Block MCP)");

  await wait(350);
  const second = await call("wp_run", { ability_name: "weave/get-post" });
  assert.deepEqual(Object.keys(second), ["site", "ability", "result"]);
  assert.equal(log.filter((l) => l.includes("GET")).length, 1, "not asked again");
  await close();
});

test("no Block MCP, call faster than the route: the pending line promises no rules, and nothing follows", async () => {
  globalThis.fetch = fakeFleet(
    { bare: { abilities: ["weave/get-site-info", "weave/get-post"], route: { status: 404, body: { code: "rest_no_route" }, delayMs: 200 } } },
    [],
  );
  const { call, close } = await connect(configFor(["bare"]));

  const first = await call("wp_run", { ability_name: "weave/get-post" });
  assert.ok(first.site_rules_pending, "the 404 is not in yet, so the check is still running");
  assert.doesNotMatch(first.site_rules_pending, /they come with the next wp_run/, "no promise of rules that may not exist");
  assert.match(first.site_rules_pending, /Any rules the site sets come as site_rules with a later wp_run/);
  assert.match(first.site_rules_pending, /Once a result here has no site_rules_pending, the check is done/);

  await wait(250);
  const second = await call("wp_run", { ability_name: "weave/get-post" });
  assert.deepEqual(Object.keys(second), ["site", "ability", "result"], "the check is done and the site sets none");
  const sites = await call("wp_list_sites", {});
  assert.equal(sites.sites[0].agent_rules, "none (no Block MCP)");
  await close();
});

test("Block MCP with empty instructions says so once, briefly", async () => {
  const log: Log = [];
  globalThis.fetch = fakeFleet(
    {
      empty: {
        abilities: ["weave/get-site-info", "weave/get-post"],
        runDelayMs: IN_TIME,
        siteInfo: { agent_instructions: { text: "", updated_at: "", source: "gk-block-mcp" } },
      },
    },
    log,
  );
  const { call, close } = await connect(configFor(["empty"]));

  const first = await call("wp_run", { ability_name: "weave/get-post" });
  assert.match(first.site_rules.about, /custom instructions are empty/);
  assert.equal(first.site_rules.text, undefined);
  const second = await call("wp_run", { ability_name: "weave/get-post" });
  assert.equal(second.site_rules, undefined);
  await close();
});

test("if the agent's call fails, the rules go out with the next call instead", async () => {
  const sites: Record<string, FakeSite> = { flaky: { ...WITH_FIELD, runDelayMs: IN_TIME, down: true } };
  globalThis.fetch = fakeFleet(sites, []);
  const { call, close } = await connect(configFor(["flaky"]));

  const first = await call("wp_run", { ability_name: "weave/get-post" });
  assert.ok(first.error, "the failure is reported as before");
  sites.flaky.down = false;
  const second = await call("wp_run", { ability_name: "weave/get-post" });
  assert.equal(second.site_rules.text, RULES);
  assert.match(second.site_rules.arrived_late, /1 earlier wp_run/);
  await close();
});

test("parallel first calls on one site send the rules once", async () => {
  globalThis.fetch = fakeFleet({ new: { ...WITH_FIELD, runDelayMs: IN_TIME } }, []);
  const { call, close } = await connect(configFor(["new"]));

  const results = await Promise.all([1, 2, 3].map((id) => call("wp_run", { ability_name: "weave/get-post", arguments: { id } })));
  assert.equal(results.filter((r) => r.site_rules).length, 1);
  assert.equal(results.filter((r) => r.site_rules_pending).length, 0);
  await close();
});

test("rules are per site: each site sends its own, once", async () => {
  globalThis.fetch = fakeFleet(
    {
      new: { ...WITH_FIELD, runDelayMs: IN_TIME },
      other: { abilities: ["weave/get-post"], runDelayMs: IN_TIME, route: { status: 200, body: { addendum: "Other site rules.", updated_at: 0 } } },
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
  globalThis.fetch = fakeFleet({ new: { ...WITH_FIELD, runDelayMs: IN_TIME } }, []);
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
  assert.deepEqual(Object.keys(first), ["site", "ability", "result"]);
  assert.ok(!log.includes("new run weave/get-site-info"));
  assert.ok(!log.some((l) => l.includes("GET")));
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

test("decideRules: get-site-info's field wins, a route answer with text is enough, and so is a 404", () => {
  const found = (source: string) => ({ kind: "found" as const, text: "Rules.", source });
  const budget = "5 seconds";
  assert.equal(decideRules(found("info"), found("route"), false, budget)?.source, "info");
  assert.equal(decideRules("pending", found("route"), false, budget)?.source, "route");
  assert.equal(decideRules(found("info"), "pending", false, budget)?.source, "info");
  assert.deepEqual(decideRules("pending", { kind: "absent" }, false, budget), { kind: "absent" }, "a 404 settles it: no Block MCP, so no field");
  assert.equal(decideRules(found("info"), { kind: "absent" }, false, budget)?.source, "info", "a field that is in still wins");
  assert.equal(decideRules("pending", { kind: "failed", reason: "HTTP 403" }, false, budget), undefined, "a failure still waits for get-site-info");
  assert.deepEqual(decideRules("none", { kind: "absent" }, false, budget), { kind: "absent" });
  assert.deepEqual(decideRules("pending", { kind: "absent" }, true, budget), { kind: "absent" });
  assert.equal(decideRules("none", "pending", false, budget), undefined);
  assert.deepEqual(decideRules("none", "pending", true, budget), { kind: "failed", reason: "no answer within 5 seconds" });
  assert.deepEqual(decideRules("none", { kind: "failed", reason: "HTTP 503" }, false, budget), { kind: "failed", reason: "HTTP 503" });
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
