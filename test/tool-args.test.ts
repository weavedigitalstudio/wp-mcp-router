import { test } from "node:test";
import assert from "node:assert/strict";
import { unknownToolArgs } from "../src/server.js";

const tools = [
  {
    name: "wp_run",
    inputSchema: { properties: { site: {}, ability_name: {}, arguments: {}, compact: {} } },
  },
  { name: "wp_list_sites", inputSchema: { properties: { refresh: {} } } },
];

test("parameters sent beside arguments are refused, not dropped", () => {
  const r = unknownToolArgs(tools, "wp_run", {
    site: "nursing-research-dev",
    ability_name: "weave/list-images",
    parameters: { per_page: 8 },
  });
  assert.ok(r);
  assert.match(r.message, /does not accept parameters/);
  assert.match(r.message, /inside "arguments"/);
  assert.deepEqual(r.detail.unknown, ["parameters"]);
});

test("an ability parameter at the top level is refused", () => {
  const r = unknownToolArgs(tools, "wp_run", { ability_name: "weave/list-images", per_page: 8 });
  assert.deepEqual(r?.detail.unknown, ["per_page"]);
});

test("a well-formed call passes", () => {
  assert.equal(
    unknownToolArgs(tools, "wp_run", { site: "x", ability_name: "weave/list-images", arguments: { per_page: 8 }, compact: true }),
    null,
  );
});

test("arguments that are not an object are refused", () => {
  const r = unknownToolArgs(tools, "wp_run", { ability_name: "weave/list-images", arguments: '{"per_page":8}' });
  assert.match(r?.message ?? "", /must be an object/);
  assert.ok(unknownToolArgs(tools, "wp_run", { ability_name: "a/b", arguments: [] }));
});

test("the arguments hint only appears on tools that take arguments", () => {
  const r = unknownToolArgs(tools, "wp_list_sites", { refrsh: true });
  assert.ok(r);
  assert.doesNotMatch(r.message, /arguments/);
});

test("an unknown tool name is left to the dispatcher", () => {
  assert.equal(unknownToolArgs(tools, "wp_nope", { a: 1 }), null);
});
