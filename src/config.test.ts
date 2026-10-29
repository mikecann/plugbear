import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { agentCanUse, upstreamsFor } from "./access.ts";
import { configFile, loadConfig, parseAgents, parseUpstreams, type UpstreamConfig } from "./config.ts";

const examplesDir = fileURLToPath(new URL("../config/", import.meta.url));

function emptyConfigDir(): string {
  return mkdtempSync(join(tmpdir(), "connectors-config-"));
}

describe("shipped examples", () => {
  const config = loadConfig({ configDir: emptyConfigDir(), examplesDir });

  it("has Notion and DeepWiki on, and the others there to switch on", () => {
    assert.deepEqual(
      config.upstreams.map((upstream) => [upstream.id, upstream.prefix, upstream.enabled]),
      [
        ["notion", "notion", true],
        ["deepwiki", "deepwiki", true],
        ["sentry", "sentry", false],
        ["cloudflare", "cf", false],
        ["gmail", "gmail", false],
        ["gcal", "gcal", false],
      ],
    );
  });

  it("has two example agents with the clients install-clients.sh wires", () => {
    assert.deepEqual(
      config.agents.map((agent) => [agent.id, agent.client?.type]),
      [
        ["claude", "claude"],
        ["codex", "codex"],
      ],
    );
    for (const agent of config.agents) {
      assert.equal(upstreamsFor(agent, config.upstreams).length, config.upstreams.length, agent.id);
    }
  });

  it("starts with the default policy", () => {
    assert.equal(config.policy.default, "allow");
    assert.equal(config.policy.rules.length, 10);
  });
});

describe("config files", () => {
  it("uses the install's own file where there is one and the example for the rest", () => {
    const configDir = emptyConfigDir();
    writeFileSync(
      join(configDir, "agents.json"),
      JSON.stringify([
        { id: "sam-laptop", title: "Sam's laptop", upstreams: ["deepwiki"], client: { type: "claude", configDir: "~/.claude-work" } },
      ]),
    );
    const dirs = { configDir, examplesDir };
    assert.equal(configFile(dirs, "agents"), join(configDir, "agents.json"));
    assert.equal(configFile(dirs, "upstreams"), join(examplesDir, "upstreams.example.json"));
    const config = loadConfig(dirs);
    assert.deepEqual(
      config.agents.map((agent) => agent.id),
      ["sam-laptop"],
    );
    assert.equal(config.agents[0]!.client?.configDir, "~/.claude-work");
    assert.equal(config.upstreams.length, 6);
    assert.equal(config.policy.rules.length, 10);
  });

  it("names the file that's wrong", () => {
    const configDir = emptyConfigDir();
    writeFileSync(join(configDir, "policy.json"), "{ not json");
    assert.throws(() => loadConfig({ configDir, examplesDir }), new RegExp(`${join(configDir, "policy.json")} isn't valid JSON`));
    writeFileSync(join(configDir, "policy.json"), JSON.stringify({ rules: [{ tool: "*", action: "maybe" }] }));
    assert.throws(() => loadConfig({ configDir, examplesDir }), /policy\.json is not valid/);
  });

  it("only knows the clients install-clients.sh can wire", () => {
    assert.throws(() => parseAgents([{ id: "a", title: "A", client: { type: "cursor" } }]));
    assert.throws(() => parseAgents([{ id: "a", title: "A", client: { type: "codex", token: "x" } }]));
  });
});

describe("upstream validation", () => {
  const base = { id: "a", title: "A", prefix: "a", type: "http", url: "https://example.com/mcp", auth: { type: "none" } };

  it("requires https", () => {
    assert.throws(() => parseUpstreams([{ ...base, url: "http://example.com/mcp" }]), /https/);
    assert.throws(() => parseUpstreams([{ ...base, url: "http://127.0.0.1:1/mcp" }]), /https/);
    assert.doesNotThrow(() => parseUpstreams([{ ...base, url: "http://127.0.0.1:1/mcp" }], { allowLoopbackHttp: true }));
    assert.throws(() => parseUpstreams([{ ...base, url: "http://10.0.0.1/mcp" }], { allowLoopbackHttp: true }), /https/);
  });

  it("rejects credentials in URLs", () => {
    assert.throws(() => parseUpstreams([{ ...base, url: "https://user:pw@example.com/mcp" }]), /secrets/);
  });

  it("checks prefixes", () => {
    assert.throws(() => parseUpstreams([{ ...base, prefix: "Has_Under" }]));
    assert.throws(() => parseUpstreams([{ ...base, prefix: "elevenchars" }]));
    assert.throws(() => parseUpstreams([{ ...base, prefix: "connectors" }]), /built-in/);
    assert.throws(
      () => parseUpstreams([base, { ...base, id: "b" }]),
      /prefix "a"/,
    );
    assert.throws(() => parseUpstreams([base, { ...base, prefix: "b" }]), /id "a"/);
  });

  it("accepts stdio servers with env from secret files", () => {
    const [upstream] = parseUpstreams([
      {
        id: "tasks",
        title: "Tasks",
        prefix: "tasks",
        type: "stdio",
        command: "/usr/bin/env",
        args: ["node", "server.js"],
        env: { MODE: "prod", API_KEY: { secretFile: "upstream-env/tasks-key" } },
      },
    ]);
    assert.equal(upstream!.type, "stdio");
    assert.equal(upstream!.enabled, true);
  });

  it("rejects unknown fields", () => {
    assert.throws(() => parseUpstreams([{ ...base, token: "abc" }]));
  });

  it("accepts Google upstreams sharing an account, and keeps the account's files apart from other upstreams'", () => {
    const gmail = { id: "gmail", title: "Gmail", prefix: "gmail", type: "google", service: "gmail" };
    const [parsed] = parseUpstreams([gmail]);
    assert.equal(parsed!.type === "google" && parsed!.account, "google");
    assert.doesNotThrow(() =>
      parseUpstreams([gmail, { id: "gcal", title: "Calendar", prefix: "gcal", type: "google", service: "calendar" }]),
    );
    assert.throws(() => parseUpstreams([{ ...gmail, service: "drive" }]));
    assert.throws(() => parseUpstreams([{ ...gmail, command: "/bin/sh" }]));
    assert.throws(() => parseUpstreams([gmail, { ...base, id: "google" }]), /Google account "google"/);
  });
});

describe("agent allowlists", () => {
  const upstreams: UpstreamConfig[] = parseUpstreams([
    { id: "notion", title: "N", prefix: "n", type: "http", url: "https://a.example/mcp", auth: { type: "oauth" } },
    { id: "notionwork", title: "N2", prefix: "n2", tags: ["work"], type: "http", url: "https://a.example/mcp", auth: { type: "oauth" } },
    { id: "sentry", title: "S", prefix: "s", tags: ["work", "errors"], type: "http", url: "https://b.example/mcp", auth: { type: "oauth" } },
  ]);
  const [notion, notionwork, sentry] = upstreams as [UpstreamConfig, UpstreamConfig, UpstreamConfig];
  const agent = (list: string[]) => parseAgents([{ id: "a", title: "A", upstreams: list }])[0]!;

  it("handles ids, globs, tags and exclusions in any order", () => {
    assert.ok(agentCanUse(agent(["*"]), sentry));
    assert.ok(!agentCanUse(agent([]), notion));
    assert.ok(agentCanUse(agent(["notion"]), notion));
    assert.ok(!agentCanUse(agent(["notion"]), notionwork));
    assert.ok(agentCanUse(agent(["notion*"]), notionwork));
    assert.ok(!agentCanUse(agent(["*", "!tag:work"]), notionwork));
    assert.ok(!agentCanUse(agent(["!tag:work", "*"]), notionwork));
    assert.ok(agentCanUse(agent(["*", "!tag:work"]), notion));
    assert.ok(agentCanUse(agent(["tag:errors"]), sentry));
    assert.ok(!agentCanUse(agent(["*", "!sentry"]), sentry));
  });
});
