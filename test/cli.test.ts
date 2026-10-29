// The connectors CLI, run as a child process like ssh would run it.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { Store } from "../src/db.ts";

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const CLEAR_ENV = {
  CONNECTORS_HOME: "",
  CONNECTORS_CONFIG_DIR: "",
  CONNECTORS_ALLOW_LOOPBACK_UPSTREAMS: "",
  CONNECTORS_MODE: "",
  CONNECTORS_PORT: "",
  CONNECTORS_PUBLIC_URL: "",
  CONNECTORS_ADMIN_LOGINS: "",
  CONNECTORS_OWNER: "",
};

// The config folder has its own agents.json; everything else comes from
// the shipped examples.
function setup(options: { agents?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "connectors-cli-"));
  const home = join(root, "data");
  const configDir = join(home, "config");
  mkdirSync(configDir, { recursive: true });
  if (options.agents !== false) {
    writeFileSync(
      join(configDir, "agents.json"),
      JSON.stringify([
        { id: "codex", title: "Codex", upstreams: ["*"], client: { type: "codex" } },
        { id: "grok", title: "Grok", upstreams: ["*", "!tag:work"], toolSeparator: "_", client: { type: "grok" } },
        { id: "muse", title: "Muse", upstreams: ["deepwiki"] },
      ]),
    );
  }
  const runWith = (env: Record<string, string>, ...args: string[]) =>
    spawnSync(process.execPath, [CLI, ...args, "--home", home], {
      encoding: "utf8",
      env: { ...process.env, ...CLEAR_ENV, ...env },
    });
  const run = (...args: string[]) => runWith({}, ...args);
  return { root, home, configDir, run, runWith };
}

describe("connectors CLI", () => {
  it("prints a new token once, on stdout only, and stores its hash", () => {
    const { root, run } = setup();
    const added = run("agent", "add", "codex");
    assert.equal(added.status, 0, added.stderr);
    const token = added.stdout.trim();
    assert.match(token, /^cn_codex_[0-9a-f]{64}$/);
    assert.match(added.stderr, /only time it's shown/);
    assert.ok(!added.stderr.includes(token));
    const secretsFile = join(root, "data", "secrets", "agents.json");
    assert.ok(!readFileSync(secretsFile, "utf8").includes(token));
    assert.equal(statSync(secretsFile).mode & 0o777, 0o600);
    assert.equal(statSync(join(root, "data", "secrets")).mode & 0o777, 0o700);

    const again = run("agent", "add", "codex");
    assert.equal(again.status, 3);
    assert.equal(again.stdout, "");
    assert.match(again.stderr, /already has a token/);

    const rotated = run("agent", "rotate", "codex");
    assert.equal(rotated.status, 0);
    assert.notEqual(rotated.stdout.trim(), token);
  });

  it("reads a dev config with loopback upstreams when serve would", () => {
    const { configDir, run, runWith } = setup();
    writeFileSync(
      join(configDir, "upstreams.json"),
      JSON.stringify([{ id: "dev", title: "Dev", prefix: "dev", type: "http", url: "http://127.0.0.1:9/mcp", auth: { type: "none" } }]),
    );
    const refused = run("agent", "add", "codex");
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /must use https/);
    const added = runWith({ CONNECTORS_ALLOW_LOOPBACK_UPSTREAMS: "1" }, "agent", "add", "codex");
    assert.equal(added.status, 0, added.stderr);
    assert.match(added.stdout.trim(), /^cn_codex_[0-9a-f]{64}$/);
  });

  it("refuses agents that aren't in agents.json", () => {
    const { run } = setup();
    const result = run("agent", "add", "stranger");
    assert.equal(result.status, 2);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /isn't in .*agents\.json/);
  });

  it("lists agents and what they can use, without tokens", () => {
    const { run } = setup();
    const token = run("agent", "add", "grok").stdout.trim();
    const listed = run("agent", "list", "--json");
    assert.equal(listed.status, 0);
    assert.ok(!listed.stdout.includes(token));
    const data = JSON.parse(listed.stdout) as {
      agents: { id: string; hasToken: boolean; upstreams: string[]; client: { type: string } | null }[];
    };
    const grok = data.agents.find((agent) => agent.id === "grok")!;
    assert.equal(grok.hasToken, true);
    assert.deepEqual(grok.upstreams, ["notion", "deepwiki", "sentry", "cloudflare", "gmail", "gcal"]);
    assert.deepEqual(grok.client, { type: "grok" });
    assert.equal(data.agents.find((agent) => agent.id === "muse")?.client, null);
    assert.equal(data.agents.find((agent) => agent.id === "codex")?.hasToken, false);
    const text = run("agent", "list");
    assert.match(text.stdout, /grok\s+token set/);
  });

  it("removes a token", () => {
    const { run } = setup();
    run("agent", "add", "muse");
    assert.match(run("agent", "remove", "muse").stderr, /Removed/);
    assert.equal(run("agent", "rotate", "muse").status, 1);
  });

  it("says when the server isn't running", () => {
    const { run } = setup();
    const result = run("status", "--url", "http://127.0.0.1:9");
    assert.equal(result.status, 1);
    assert.match(result.stdout, /isn't answering/);
  });

  it("sets up a local install from the examples, and never overwrites", () => {
    const { home, configDir, run } = setup({ agents: false });
    const init = run("init", "--owner", "Ana");
    assert.equal(init.status, 0, init.stderr);
    assert.deepEqual(JSON.parse(readFileSync(join(configDir, "settings.json"), "utf8")), { mode: "local", ownerName: "Ana" });
    assert.match(readFileSync(join(configDir, "agents.json"), "utf8"), /"id": "claude"/);
    assert.equal(statSync(join(home, "secrets")).mode & 0o777, 0o700);
    writeFileSync(join(configDir, "agents.json"), "[]");
    const again = run("init", "--mode", "tailscale");
    assert.equal(again.status, 0, again.stderr);
    assert.match(again.stderr, /already there, so it's left as it is/);
    assert.equal(readFileSync(join(configDir, "agents.json"), "utf8"), "[]");
    assert.equal(JSON.parse(readFileSync(join(configDir, "settings.json"), "utf8")).mode, "local");
  });

  it("reads the tailnet name and login from Tailscale for tailscale mode", () => {
    const { root, configDir, runWith } = setup();
    const fake = join(root, "tailscale");
    writeFileSync(
      fake,
      `#!/bin/sh\necho '{"Self":{"DNSName":"studio.example-tailnet.ts.net.","UserID":7},"User":{"7":{"LoginName":"ana@example.com"}}}'\n`,
    );
    chmodSync(fake, 0o755);
    const init = runWith({ CONNECTORS_TAILSCALE: fake }, "init", "--mode", "tailscale");
    assert.equal(init.status, 0, init.stderr);
    assert.deepEqual(JSON.parse(readFileSync(join(configDir, "settings.json"), "utf8")), {
      mode: "tailscale",
      servePort: 8443,
      publicUrl: "https://studio.example-tailnet.ts.net:8443",
      adminLogins: ["ana@example.com"],
    });
  });

  it("says what to pass when Tailscale can't tell it", () => {
    const { configDir, runWith } = setup();
    const init = runWith({ CONNECTORS_TAILSCALE: "/nonexistent/tailscale" }, "init", "--mode", "tailscale");
    assert.equal(init.status, 2);
    assert.match(init.stderr, /Pass --public-url/);
    assert.ok(!existsSync(join(configDir, "settings.json")));
  });

  it("shows the settings in effect and which files they came from", () => {
    const { configDir, run, runWith } = setup();
    writeFileSync(join(configDir, "settings.json"), JSON.stringify({ port: 8899, ownerName: "Ana" }));
    const shown = JSON.parse(run("settings", "--json").stdout) as {
      settings: { mode: string; port: number; publicUrl: string; ownerName: string };
      files: Record<string, string | null>;
    };
    assert.equal(shown.settings.mode, "local");
    assert.equal(shown.settings.publicUrl, "http://127.0.0.1:8899");
    assert.equal(shown.settings.ownerName, "Ana");
    assert.equal(shown.files.agents, join(configDir, "agents.json"));
    assert.match(shown.files.upstreams!, /config\/upstreams\.example\.json$/);
    const env = JSON.parse(runWith({ CONNECTORS_PORT: "9100" }, "settings", "--json").stdout) as { settings: { port: number } };
    assert.equal(env.settings.port, 9100);
  });

  it("prints a one-time sign-in link for local mode", () => {
    const { home, run } = setup();
    const opened = run("open", "/admin/connect/notion", "--print");
    assert.equal(opened.status, 0, opened.stderr);
    const url = new URL(opened.stdout.trim());
    assert.equal(url.origin, "http://127.0.0.1:8795");
    assert.equal(url.pathname, "/admin/login");
    assert.equal(url.searchParams.get("next"), "/admin/connect/notion");
    const code = url.searchParams.get("code")!;
    assert.match(code, /^[A-Za-z0-9_-]{32}$/);
    const store = new Store(join(home, "state", "connectors.sqlite"));
    try {
      assert.ok(store.takeLoginCode(code, Date.now()));
      assert.ok(!store.takeLoginCode(code, Date.now()), "a code works once");
    } finally {
      store.close();
    }
    // Anywhere but the admin pages becomes /admin.
    const elsewhere = new URL(run("open", "https://evil.example/", "--print").stdout.trim());
    assert.equal(elsewhere.searchParams.get("next"), "/admin");
  });

  it("prints help and its version", () => {
    const { run } = setup();
    assert.match(run("help").stdout, /connectors agent add <id>/);
    assert.match(run("--version").stdout, /^\d+\.\d+\.\d+\n$/);
  });
});
