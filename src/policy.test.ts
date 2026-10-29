import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { parsePolicy, type Policy } from "./config.ts";
import { globMatch } from "./glob.ts";
import { decide, isNonEmpty, mayAsk } from "./policy.ts";

const defaults: Policy = parsePolicy(
  JSON.parse(readFileSync(new URL("../config/policy.example.json", import.meta.url), "utf8")),
);

function action(policy: Policy, toolName: string, args: Record<string, unknown> = {}, agentId = "codex") {
  return decide(policy, { agentId, upstreamId: toolName.split("__")[0]!, toolName, args }).action;
}

describe("glob", () => {
  it("matches * across underscores and is case-insensitive", () => {
    assert.ok(globMatch("*__*send*", "gmail__send_message"));
    assert.ok(globMatch("*__*send*", "slack__chat_sendMessage"));
    assert.ok(globMatch("*__*send*", "x__SendNow"));
    assert.ok(!globMatch("*__*send*", "notion__update_page"));
    assert.ok(globMatch("notion*", "notioncx"));
    assert.ok(globMatch("a?c", "abc"));
    assert.ok(!globMatch("a?c", "abbc"));
  });

  it("treats regex characters literally", () => {
    assert.ok(globMatch("a.b", "a.b"));
    assert.ok(!globMatch("a.b", "axb"));
    assert.ok(globMatch("(x)+", "(x)+"));
  });
});

describe("default policy", () => {
  it("asks before anything that reaches other people or can't be undone", () => {
    for (const tool of [
      "gmail__send_message",
      "gmail__reply_to_thread",
      "gmail__forward_email",
      "slack__post_message",
      "notion__delete_block",
      "gmail__trash_message",
      "drive__share_file",
      "drive__update_permissions",
      "cal__invite_guest",
    ]) {
      assert.equal(action(defaults, tool), "ask", tool);
    }
  });

  it("allows page edits and reads", () => {
    for (const tool of [
      "notion__notion-update-page",
      "notion__notion-create-pages",
      "notion__notion-search",
      "notioncx__notion-fetch",
      "sentry__search_issues",
      "deepwiki__ask_question",
    ]) {
      assert.equal(action(defaults, tool), "allow", tool);
    }
  });

  it("asks for calendar events only when they have attendees", () => {
    assert.equal(action(defaults, "gcal__create_event", { title: "Focus" }), "allow");
    assert.equal(action(defaults, "gcal__create_event", { attendees: [] }), "allow");
    assert.equal(action(defaults, "gcal__create_event", { attendees: "" }), "allow");
    assert.equal(action(defaults, "gcal__update_event", { attendees: ["a@b.c"] }), "ask");
  });
});

describe("rule matching", () => {
  const policy = parsePolicy({
    default: "allow",
    rules: [
      { tool: "*__danger*", action: "deny" },
      { tool: "*__post*", agents: ["grok", "muse"], action: "deny" },
      { tool: "cf__*", upstreams: ["cloudflare"], action: "ask" },
      { tool: "*__post*", action: "ask" },
    ],
  });

  it("uses the first matching rule", () => {
    assert.deepEqual(decide(policy, { agentId: "codex", upstreamId: "x", toolName: "x__danger_post", args: {} }), {
      action: "deny",
      ruleIndex: 0,
    });
  });

  it("scopes rules to agents", () => {
    assert.equal(action(policy, "x__post_it", {}, "grok"), "deny");
    assert.equal(action(policy, "x__post_it", {}, "codex"), "ask");
  });

  it("scopes rules to upstreams", () => {
    assert.equal(
      decide(policy, { agentId: "codex", upstreamId: "cloudflare", toolName: "cf__workers_list", args: {} }).action,
      "ask",
    );
    assert.equal(
      decide(policy, { agentId: "codex", upstreamId: "other", toolName: "cf__workers_list", args: {} }).action,
      "allow",
    );
  });

  it("falls back to the default", () => {
    assert.deepEqual(decide(policy, { agentId: "codex", upstreamId: "x", toolName: "x__read", args: {} }), {
      action: "allow",
      ruleIndex: null,
    });
    const strict = parsePolicy({ default: "deny", rules: [] });
    assert.equal(action(strict, "x__read"), "deny");
  });

  it("knows what counts as a non-empty argument", () => {
    assert.equal(isNonEmpty(undefined), false);
    assert.equal(isNonEmpty(null), false);
    assert.equal(isNonEmpty("  "), false);
    assert.equal(isNonEmpty([]), false);
    assert.equal(isNonEmpty({}), false);
    assert.equal(isNonEmpty(0), true);
    assert.equal(isNonEmpty(false), true);
    assert.equal(isNonEmpty("x"), true);
    assert.equal(isNonEmpty([1]), true);
  });

  it("knows which tools some arguments could hold", () => {
    const rules = parsePolicy({
      default: "allow",
      rules: [
        { tool: "x__read_*", action: "allow" },
        { tool: "*__*send*", action: "ask" },
        { tool: "gcal__*event*", ifArgs: ["attendees"], action: "ask" },
        { tool: "x__*", ifArgs: ["force"], action: "deny" },
        { tool: "x__*", action: "ask", agents: ["grok"] },
      ],
    });
    const may = (toolName: string, agentId = "codex") => mayAsk(rules, { agentId, upstreamId: "x", toolName });
    assert.equal(may("gmail__send_message"), true);
    assert.equal(may("gcal__create_event"), true);
    assert.equal(may("gcal__list_calendars"), false);
    // An earlier allow rule without ifArgs settles it.
    assert.equal(may("x__read_send_log"), false);
    // An ifArgs rule with another action doesn't stop a later ask.
    assert.equal(may("x__update", "grok"), true);
    assert.equal(may("x__update"), false);
    assert.equal(mayAsk(parsePolicy({ default: "ask", rules: [] }), { agentId: "a", upstreamId: "x", toolName: "x__y" }), true);
  });

  it("rejects unknown actions and fields", () => {
    assert.throws(() => parsePolicy({ rules: [{ tool: "*", action: "maybe" }] }));
    assert.throws(() => parsePolicy({ rules: [{ tool: "*", action: "ask", when: "x" }] }));
  });
});
