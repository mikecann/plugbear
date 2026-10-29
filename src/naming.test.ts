import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { MAX_TOOL_NAME_LENGTH, nameTools, policyName, sanitizeToolName } from "./naming.ts";

const VALID = /^[a-zA-Z0-9_-]{1,64}$/;

describe("tool naming", () => {
  it("prefixes names with <prefix>__", () => {
    const names = nameTools("notion", ["search", "fetch"]);
    assert.deepEqual([...names], [
      ["notion__search", "search"],
      ["notion__fetch", "fetch"],
    ]);
  });

  it("keeps dashes and replaces other characters", () => {
    assert.equal(sanitizeToolName("notion-update-page"), "notion-update-page");
    assert.equal(sanitizeToolName("a.b/c d:é"), "a_b_c_d__");
    const names = nameTools("x", ["a.b/c"]);
    assert.equal([...names.keys()][0], "x__a_b_c");
  });

  it("truncates long names with a hash and keeps the reverse map", () => {
    const long = "list_every_single_thing_in_the_workspace_including_archived_items_and_more";
    const names = nameTools("notioncx", [long, "short"]);
    const [exposed] = [...names.keys()];
    assert.ok(exposed!.length <= MAX_TOOL_NAME_LENGTH);
    assert.match(exposed!, VALID);
    assert.match(exposed!, /^notioncx__list_every_single_thing.*_[0-9a-f]{8}$/);
    assert.equal(names.get(exposed!), long);
    assert.equal(names.get("notioncx__short"), "short");
  });

  it("is stable for the same input", () => {
    const tools = ["a".repeat(100), "b.c", "b_c"];
    assert.deepEqual([...nameTools("p", tools)], [...nameTools("p", tools)]);
  });

  it("never gives two tools the same name", () => {
    const tools = ["b.c", "b_c", "b c", "b/c"];
    const names = nameTools("p", tools);
    assert.equal(names.size, tools.length);
    // The tool whose name is already clean keeps it.
    assert.equal(names.get("p__b_c"), "b_c");
    for (const name of names.keys()) assert.match(name, VALID);
    assert.deepEqual(new Set(names.values()), new Set(tools));
  });

  it("separates long names that share a start", () => {
    const base = "x".repeat(70);
    const names = nameTools("p", [`${base}1`, `${base}2`]);
    assert.equal(names.size, 2);
    for (const name of names.keys()) assert.ok(name.length <= 64);
  });

  it("has a _ style with no second __ for Grok", () => {
    const tools = ["search", "a__b", "x.__y", "fetch_", "z".repeat(80), "a_b"];
    const names = nameTools("notion", tools, "_");
    assert.equal(names.size, tools.length);
    assert.equal(names.get("notion_search"), "search");
    assert.equal(names.get("notion_fetch_"), "fetch_");
    // "a__b" cleans to "a_b", which a later tool owns outright.
    assert.equal(names.get("notion_a_b"), "a_b");
    for (const name of names.keys()) {
      assert.ok(!name.includes("__"), name);
      assert.match(name, VALID);
    }
    assert.deepEqual(new Set(names.values()), new Set(tools));
    // Names that start with "_" or a character that becomes one.
    const edge = ["_private", ".hidden", "$ref", `_${"y".repeat(70)}`, "private"];
    const edgeNames = nameTools("fake", edge, "_");
    assert.equal(edgeNames.size, edge.length);
    assert.equal(edgeNames.get("fake_private"), "private");
    for (const name of edgeNames.keys()) {
      assert.ok(!name.includes("__"), name);
      assert.match(name, VALID);
    }
    assert.deepEqual(new Set(edgeNames.values()), new Set(edge));
    // Cut names never end the head in "_" before the hash.
    const cut = nameTools("p", [`${"ab_".repeat(30)}`], "_");
    assert.ok(![...cut.keys()][0]!.includes("__"));
  });

  it("matches policy against the upstream's own name", () => {
    assert.equal(policyName("gmail", "send.message"), "gmail__send.message");
  });
});
