// scripts/install-clients.sh against a temporary HOME, with stand-ins for
// the Keychain (`security`), the client CLIs and ssh, and the real
// connectors CLI minting tokens in a temp data folder whose agents.json
// and settings.json are made up. Nothing here touches real configs or the
// real Keychain.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("../", import.meta.url));
const SCRIPT = join(REPO, "scripts", "install-clients.sh");
const STUBS = join(REPO, "test", "fixtures", "bin");
const URL_ = "https://gateway.example.ts.net:8443/mcp";

// One agent per client, three extra Claude config folders (claude-old's
// doesn't exist on this "Mac"), and one agent with no client.
const AGENTS = [
  { id: "claude", title: "Claude", upstreams: ["*"], client: { type: "claude" } },
  { id: "claude-work", title: "Claude (claude-work)", upstreams: ["*"], client: { type: "claude", configDir: "~/accounts/claude-work" } },
  { id: "claude-old", title: "Claude (claude-old)", upstreams: ["*"], client: { type: "claude", configDir: "~/accounts/claude-old" } },
  { id: "claude-team", title: "Claude (claude-team)", upstreams: ["*"], client: { type: "claude", configDir: "~/accounts/claude-team" } },
  { id: "codex", title: "Codex", upstreams: ["*"], client: { type: "codex" } },
  { id: "grok", title: "Grok", upstreams: ["*"], toolSeparator: "_", client: { type: "grok" } },
  { id: "muse", title: "Muse", upstreams: ["*"], client: { type: "muse" } },
  { id: "notes", title: "A phone app", upstreams: ["deepwiki"] },
];

const CODEX_BEFORE = `model = "gpt-6.1-sol"
# A comment Sam wrote
[profiles.fast]
model = "gpt-6-luna"

[mcp_servers.connectors]
url = "https://old.example/mcp"

[mcp_servers.connectors.env]
OLD = "1"

[mcp_servers.other]
command = "other-server"
args = ["--flag"]
`;

const GROK_BEFORE = `[ui]
theme = "dark"
`;

function setup() {
  const root = mkdtempSync(join(tmpdir(), "connectors-install-"));
  const home = join(root, "home");
  const accounts = join(home, "accounts");
  mkdirSync(join(accounts, "claude-work"), { recursive: true });
  mkdirSync(join(accounts, "claude-team"), { recursive: true });
  mkdirSync(join(home, ".codex"), { recursive: true });
  writeFileSync(join(home, ".codex", "config.toml"), CODEX_BEFORE, { mode: 0o600 });
  mkdirSync(join(home, ".grok"), { recursive: true });
  writeFileSync(join(home, ".grok", "config.toml"), GROK_BEFORE);
  mkdirSync(join(home, ".config", "muse"), { recursive: true });
  writeFileSync(join(home, ".config", "muse", "settings.json"), JSON.stringify({ schema_version: 1, tui: { x: true } }), { mode: 0o644 });
  const data = join(root, "data");
  const configDir = join(data, "config");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, "agents.json"), JSON.stringify(AGENTS));
  // The MCP URL comes from the gateway's publicUrl.
  writeFileSync(
    join(configDir, "settings.json"),
    JSON.stringify({ mode: "tailscale", publicUrl: "https://gateway.example.ts.net:8443", adminLogins: ["sam@example.com"] }),
  );
  const keychain = join(root, "keychain.tsv");
  const clientLog = join(root, "clients.log");
  const env = {
    PATH: `${STUBS}:/usr/bin:/bin:/usr/sbin:/sbin`,
    HOME: home,
    CONNECTORS_CLI: `${process.execPath} ${join(REPO, "src", "cli.ts")} --home ${data}`,
    CONNECTORS_SECURITY_BIN: join(STUBS, "security"),
    FAKE_KEYCHAIN: keychain,
    FAKE_CLIENT_LOG: clientLog,
  };
  const run = (args: string[], extra: Record<string, string> = {}) => {
    const result = spawnSync("/bin/bash", [SCRIPT, ...args], { env: { ...env, ...extra }, encoding: "utf8" });
    return { ...result, all: `${result.stdout}${result.stderr}` };
  };
  // PATH with only some of the stub CLIs, as on a Mac without the others.
  const pathWithout = (...missing: string[]) => {
    const dir = join(root, `bin-without-${missing.join("-")}`);
    mkdirSync(dir, { recursive: true });
    for (const name of readdirSync(STUBS)) {
      if (!missing.includes(name)) cpSync(join(STUBS, name), join(dir, name));
    }
    return `${dir}:/usr/bin:/bin:/usr/sbin:/sbin`;
  };
  const tokens = () => {
    const map = new Map<string, string>();
    if (!existsSync(keychain)) return map;
    for (const line of readFileSync(keychain, "utf8").split("\n").filter(Boolean)) {
      const [service, account, token] = line.split("\t");
      if (service === "connectors") map.set(account!, token!);
    }
    return map;
  };
  return { root, home, data, keychain, clientLog, run, tokens, pathWithout };
}

const mode = (path: string) => statSync(path).mode & 0o777;

describe("install-clients.sh", () => {
  const t = setup();
  const first = t.run([]);

  it("wires every installed client and never prints a token", () => {
    assert.equal(first.status, 0, first.all);
    const tokens = t.tokens();
    assert.deepEqual([...tokens.keys()].sort(), ["claude", "claude-team", "claude-work", "codex", "grok", "muse"]);
    for (const [agent, token] of tokens) {
      assert.match(token, new RegExp(`^cn_${agent}_[0-9a-f]{64}$`));
      assert.ok(!first.all.includes(token), `${agent}'s token was printed`);
    }
    // claude-old's folder isn't there, and notes has no client, so they get nothing.
    assert.match(first.all, /claude-old\n {2}skipped: .*accounts\/claude-old doesn't exist/);
    assert.match(first.all, /notes\n {2}skipped: agents\.json gives notes no client/);
    assert.match(first.all, /Done: claude claude-work claude-team codex grok muse\. Skipped: claude-old notes\. Failed: none\./);
    // Tokens went into the Keychain through stdin, never as arguments.
    const argv = existsSync(`${t.keychain}.argv`) ? readFileSync(`${t.keychain}.argv`, "utf8") : "";
    assert.ok(!argv.includes("cn_"));
  });

  it("writes a headers helper that reads the Keychain", () => {
    const headers = join(t.home, ".config", "connectors", "headers.sh");
    assert.equal(mode(headers), 0o700);
    const printed = spawnSync("/bin/sh", [headers, "codex"], {
      env: { PATH: "/usr/bin:/bin", FAKE_KEYCHAIN: t.keychain },
      encoding: "utf8",
    });
    assert.equal(printed.status, 0, printed.stderr);
    assert.deepEqual(JSON.parse(printed.stdout), { Authorization: `Bearer ${t.tokens().get("codex")}` });
  });

  it("adds connectors to each Claude config folder with headersHelper", () => {
    const log = readFileSync(t.clientLog, "utf8");
    const headers = join(t.home, ".config", "connectors", "headers.sh");
    const adds = log.split("\n").filter((line) => line.includes("mcp add-json"));
    assert.equal(adds.length, 3);
    assert.ok(adds[0]!.startsWith("claude dir=<unset> mcp add-json --scope user connectors "));
    assert.ok(adds[0]!.includes(`"headersHelper":"${headers} claude"`));
    assert.ok(adds[1]!.includes(`dir=${join(t.home, "accounts", "claude-work")} mcp add-json`));
    assert.ok(adds[1]!.includes(`"headersHelper":"${headers} claude-work"`));
    assert.ok(adds[2]!.includes(`"url":"${URL_}"`));
    assert.ok(!log.includes("cn_"));
  });

  it("replaces Codex's connectors table, keeps everything else and backs it up", () => {
    const config = readFileSync(join(t.home, ".codex", "config.toml"), "utf8");
    assert.equal(config.match(/\[mcp_servers\.connectors\]/g)?.length, 1);
    assert.ok(!config.includes("old.example"));
    assert.ok(!config.includes("[mcp_servers.connectors.env]"));
    assert.ok(config.includes('# A comment Sam wrote\n[profiles.fast]\nmodel = "gpt-6-luna"'));
    assert.ok(config.includes('[mcp_servers.other]\ncommand = "other-server"'));
    assert.ok(config.includes(`url = "${URL_}"`));
    assert.ok(config.includes(`http_headers_helper = "${join(t.home, ".config", "connectors", "headers.sh")} codex"`));
    assert.ok(config.includes("tool_timeout_sec = 300"));
    assert.ok(!config.includes("cn_"));
    assert.equal(mode(join(t.home, ".codex", "config.toml")), 0o600);
    const backups = readdirSync(join(t.home, ".codex")).filter((name) => name.startsWith("config.toml.bak-connectors-"));
    assert.equal(backups.length, 1);
    assert.equal(readFileSync(join(t.home, ".codex", backups[0]!), "utf8"), CODEX_BEFORE);
  });

  it("points Grok at a 0600 token file", () => {
    const config = readFileSync(join(t.home, ".grok", "config.toml"), "utf8");
    const tokenFile = join(t.home, ".config", "connectors", "grok.token");
    assert.ok(config.startsWith(GROK_BEFORE));
    assert.ok(config.includes(`[mcp_servers.connectors]\nurl = "${URL_}"\nbearer_token_file = "${tokenFile}"`));
    assert.equal(readFileSync(tokenFile, "utf8").trim(), t.tokens().get("grok"));
    assert.equal(mode(tokenFile), 0o600);
  });

  it("gives Muse a literal header and makes its settings 0600", () => {
    const path = join(t.home, ".config", "muse", "settings.json");
    const settings = JSON.parse(readFileSync(path, "utf8"));
    assert.equal(settings.schema_version, 1);
    assert.deepEqual(settings.tui, { x: true });
    assert.deepEqual(settings.mcpServers.connectors, {
      type: "http",
      url: URL_,
      headers: { Authorization: `Bearer ${t.tokens().get("muse")}` },
    });
    assert.equal(mode(path), 0o600);
  });

  it("is safe to run again: same tokens, one table each", () => {
    const before = t.tokens();
    const again = t.run([]);
    assert.equal(again.status, 0, again.all);
    assert.deepEqual(t.tokens(), before);
    assert.match(again.all, /token: already in the Keychain/);
    const codex = readFileSync(join(t.home, ".codex", "config.toml"), "utf8");
    assert.equal(codex.match(/\[mcp_servers\.connectors\]/g)?.length, 1);
    const grok = readFileSync(join(t.home, ".grok", "config.toml"), "utf8");
    assert.equal(grok.match(/\[mcp_servers\.connectors\]/g)?.length, 1);
  });

  it("changes nothing on a dry run", () => {
    const codex = readFileSync(join(t.home, ".codex", "config.toml"), "utf8");
    const keychain = readFileSync(t.keychain, "utf8");
    const dry = t.run(["--dry-run", "--rotate"]);
    assert.equal(dry.status, 0, dry.all);
    assert.match(dry.all, /Dry run: nothing changed\./);
    assert.equal(readFileSync(join(t.home, ".codex", "config.toml"), "utf8"), codex);
    assert.equal(readFileSync(t.keychain, "utf8"), keychain);
  });

  it("rotates tokens on the gateway and in the Keychain", () => {
    const before = t.tokens();
    const rotated = t.run(["--rotate", "--only", "codex,grok"]);
    assert.equal(rotated.status, 0, rotated.all);
    const after = t.tokens();
    assert.notEqual(after.get("codex"), before.get("codex"));
    assert.notEqual(after.get("grok"), before.get("grok"));
    assert.equal(after.get("muse"), before.get("muse"));
    assert.equal(readFileSync(join(t.home, ".config", "connectors", "grok.token"), "utf8").trim(), after.get("grok"));
    const secrets = JSON.parse(readFileSync(join(t.data, "secrets", "agents.json"), "utf8"));
    assert.ok(secrets.agents.codex.rotatedAt);
  });

  it("replaces the gateway's token when this Mac lost its copy", () => {
    const keychain = readFileSync(t.keychain, "utf8").split("\n").filter((line) => !line.startsWith("connectors\tmuse\t"));
    writeFileSync(t.keychain, keychain.join("\n"));
    const again = t.run(["--only", "muse"]);
    assert.equal(again.status, 0, again.all);
    assert.match(again.all, /The gateway already has a token for muse that this Mac doesn't; replacing it/);
    assert.match(t.tokens().get("muse") ?? "", /^cn_muse_/);
  });

  it("puts Codex's config back when Codex rejects it", () => {
    const u = setup();
    const result = u.run(["--only", "codex"], { FAKE_CODEX_REJECT: "1" });
    assert.notEqual(result.status, 0);
    assert.match(result.all, /Codex didn't accept the new config/);
    assert.equal(readFileSync(join(u.home, ".codex", "config.toml"), "utf8"), CODEX_BEFORE);
  });

  it("refuses a connectors entry it can't edit safely", () => {
    const u = setup();
    const inline = `${CODEX_BEFORE}\n[mcp_servers]\nconnectors = { url = "x" }\n`;
    writeFileSync(join(u.home, ".codex", "config.toml"), inline);
    const result = u.run(["--only", "codex"]);
    assert.equal(result.status, 1);
    assert.match(result.all, /sets connectors in a form this script doesn't edit/);
    assert.ok(!result.all.includes("Codex: [mcp_servers.connectors] set"));
    assert.match(result.all, /Failed: codex\./);
    assert.equal(readFileSync(join(u.home, ".codex", "config.toml"), "utf8"), inline);
  });

  it("says Codex failed, not that it's wired, when it refuses an edit and codex isn't on PATH", () => {
    const u = setup();
    const inline = `${CODEX_BEFORE}\n[mcp_servers]\nconnectors = { url = "x" }\n`;
    writeFileSync(join(u.home, ".codex", "config.toml"), inline);
    const result = u.run(["--only", "codex"], { PATH: u.pathWithout("codex") });
    assert.equal(result.status, 1, result.all);
    assert.ok(!result.all.includes("Codex: [mcp_servers.connectors] set"));
    assert.equal(readFileSync(join(u.home, ".codex", "config.toml"), "utf8"), inline);
  });

  it("refuses Grok's inline form without writing anything, and still wires the others", () => {
    const u = setup();
    const inline = `${GROK_BEFORE}\n[mcp_servers]\nconnectors = { url = "x" }\n`;
    writeFileSync(join(u.home, ".grok", "config.toml"), inline);
    const result = u.run(["--only", "grok,muse"]);
    assert.equal(result.status, 1, result.all);
    assert.match(result.all, /sets connectors in a form this script doesn't edit/);
    assert.ok(!result.all.includes("Grok: [mcp_servers.connectors] set"));
    assert.equal(readFileSync(join(u.home, ".grok", "config.toml"), "utf8"), inline);
    assert.ok(!existsSync(join(u.home, ".config", "connectors", "grok.token")));
    assert.ok(!u.tokens().has("grok"), "a token was minted for a config that can't be wired");
    // Muse came after Grok and was still wired.
    assert.match(result.all, /Muse: mcpServers\.connectors set/);
    assert.match(result.all, /Done: muse\. Skipped: none\. Failed: grok\./);
  });

  it("puts Grok's config back when Grok can't read it", () => {
    const u = setup();
    const result = u.run(["--only", "grok"], { FAKE_GROK_REJECT: "1" });
    assert.equal(result.status, 1, result.all);
    assert.match(result.all, /Grok didn't accept the new config/);
    assert.equal(readFileSync(join(u.home, ".grok", "config.toml"), "utf8"), GROK_BEFORE);
  });

  it("leaves a Muse settings file that isn't plain JSON alone, with a clear message", () => {
    const u = setup();
    const jsonc = '{\n  // Sam\'s comment\n  "schema_version": 1\n}\n';
    writeFileSync(join(u.home, ".config", "muse", "settings.json"), jsonc);
    const result = u.run(["--only", "muse"]);
    assert.equal(result.status, 1, result.all);
    assert.match(result.all, /settings\.json isn't plain JSON .*change it by hand/);
    assert.ok(!result.all.includes("Traceback"));
    assert.ok(!result.all.includes("Muse: mcpServers.connectors set"));
    assert.equal(readFileSync(join(u.home, ".config", "muse", "settings.json"), "utf8"), jsonc);
    assert.ok(!u.tokens().has("muse"));
  });

  it("mints no token for a client that isn't on this Mac", () => {
    const u = setup();
    rmSync(join(u.home, ".grok"), { recursive: true });
    rmSync(join(u.home, ".config", "muse"), { recursive: true });
    const result = u.run(["--only", "codex,grok,muse"], { PATH: u.pathWithout("grok", "muse") });
    assert.equal(result.status, 0, result.all);
    assert.deepEqual([...u.tokens().keys()], ["codex"]);
    assert.match(result.all, /grok\n {2}skipped: grok isn't installed/);
    assert.match(result.all, /Skipped: grok muse\./);
    const secrets = JSON.parse(readFileSync(join(u.data, "secrets", "agents.json"), "utf8"));
    assert.deepEqual(Object.keys(secrets.agents), ["codex"]);
  });

  it("takes everything out again with --remove", () => {
    const removed = t.run(["--remove"]);
    assert.equal(removed.status, 0, removed.all);
    assert.equal(t.tokens().size, 0);
    const codex = readFileSync(join(t.home, ".codex", "config.toml"), "utf8");
    assert.ok(!codex.includes("connectors"));
    assert.ok(codex.includes("[mcp_servers.other]"));
    assert.ok(!readFileSync(join(t.home, ".grok", "config.toml"), "utf8").includes("connectors"));
    assert.ok(!existsSync(join(t.home, ".config", "connectors", "grok.token")));
    const muse = JSON.parse(readFileSync(join(t.home, ".config", "muse", "settings.json"), "utf8"));
    assert.equal(muse.mcpServers, undefined);
    assert.ok(readFileSync(t.clientLog, "utf8").includes("mcp remove --scope user connectors"));
  });

  it("never reaches a real host", () => {
    const log = existsSync(t.clientLog) ? readFileSync(t.clientLog, "utf8") : "";
    assert.ok(!log.includes("fake ssh"));
  });
});
