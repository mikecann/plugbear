// Real-client checks: `npm run test:clients [-- --only claude,codex] [-- --approvals]`.
//
// With --approvals, each client also makes a call the policy holds for
// approval (fake__send_report, which declares an outputSchema like DeepWiki's
// tools do). This script approves it 50 seconds later, after the 45-second
// hold has answered "Waiting for Sam", so the client has to call
// connectors__await_approval to get the result.
//
// Starts a local gateway on 127.0.0.1 with a temp data folder, the fake stdio
// upstream and DeepWiki, gives each client its own temporary agent token,
// and asks each installed CLI to list the tools, call fake__echo and call a
// DeepWiki tool. The call log is the evidence; the client's own reply is
// kept for the record. Nothing here touches the clients' real configs:
// Claude gets --strict-mcp-config, Codex -c overrides, Grok a project
// .grok/config.toml and Muse a project .mcp.json in temp folders. Claude
// runs with CLIENTS_CLAUDE_CONFIG_DIR as CLAUDE_CONFIG_DIR if it's set (a
// login you don't mind spending on), else your default ~/.claude.

import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const REPO = fileURLToPath(new URL("../../", import.meta.url));
const CLI = join(REPO, "src", "cli.ts");
const FAKE_STDIO = join(REPO, "test", "fixtures", "fakeStdioServer.ts");
const CLAUDE_ENV: Record<string, string> = process.env.CLIENTS_CLAUDE_CONFIG_DIR
  ? { CLAUDE_CONFIG_DIR: process.env.CLIENTS_CLAUDE_CONFIG_DIR }
  : {};
const RUN_TIMEOUT_MS = 6 * 60_000;
const DEEPWIKI_REPO = "modelcontextprotocol/typescript-sdk";
// Longer than the gateway's 45-second hold, so the agent must await.
const APPROVE_AFTER_MS = 50_000;

type Ctx = {
  work: string;
  url: string;
  token: string;
  agent: string;
  prompt: string;
  dir: string;
  headersScript: string;
};

type Variant = {
  name: string;
  bin: string;
  describe: string;
  // Tool naming style for this client's agent (config/agents.json).
  separator?: "__" | "_";
  prepare(ctx: Ctx): { args: string[]; env?: Record<string, string> };
  cleanup?(ctx: Ctx): void;
};

type Result = {
  variant: string;
  client: string;
  version: string;
  config: string;
  exitCode: number | null;
  seconds: number;
  listed: number | null;
  protocols: string[];
  echoOk: boolean;
  deepwikiOk: boolean;
  deepwikiTool: string | null;
  replyHasNonce: boolean;
  approval?: { ok: boolean; seconds: number; approvedAfterMs: number | null; reply: boolean };
  pass: boolean;
  skipped?: string;
};

const VARIANTS: Variant[] = [
  {
    name: "claude",
    bin: "claude",
    describe: "--mcp-config with a literal Authorization header",
    prepare: (ctx) => {
      const file = join(ctx.dir, "mcp.json");
      writeSecret(file, JSON.stringify({
        mcpServers: { connectors: { type: "http", url: `${ctx.url}/mcp`, headers: { Authorization: `Bearer ${ctx.token}` } } },
      }));
      return {
        args: ["-p", ctx.prompt, "--model", "claude-haiku-5-5", "--strict-mcp-config", "--mcp-config", file, "--allowedTools", "mcp__connectors"],
        env: CLAUDE_ENV,
      };
    },
  },
  {
    name: "claude-helper",
    bin: "claude",
    describe: "--mcp-config with headersHelper (the shape install-clients.sh writes)",
    prepare: (ctx) => {
      const file = join(ctx.dir, "mcp.json");
      writeSecret(file, JSON.stringify({
        mcpServers: { connectors: { type: "http", url: `${ctx.url}/mcp`, headersHelper: `${ctx.headersScript} ${ctx.agent}` } },
      }));
      return {
        args: ["-p", ctx.prompt, "--model", "claude-haiku-5-5", "--strict-mcp-config", "--mcp-config", file, "--allowedTools", "mcp__connectors"],
        env: CLAUDE_ENV,
      };
    },
  },
  {
    name: "codex",
    bin: "codex",
    describe: "-c mcp_servers.connectors.url and bearer_token_env_var",
    prepare: (ctx) => ({
      args: [
        "exec", "--skip-git-repo-check", "-m", "gpt-6-luna", "-c", 'model_reasoning_effort="low"', "-s", "read-only",
        "-c", 'approval_policy="never"',
        "-c", `mcp_servers.connectors.url="${ctx.url}/mcp"`,
        "-c", 'mcp_servers.connectors.bearer_token_env_var="CONNECTORS_TEST_TOKEN"',
        "-c", 'mcp_servers.connectors.default_tools_approval_mode="approve"',
        ctx.prompt,
      ],
      env: { CONNECTORS_TEST_TOKEN: ctx.token },
    }),
  },
  {
    name: "codex-helper",
    bin: "codex",
    describe: "-c mcp_servers.connectors.http_headers_helper (the shape install-clients.sh writes)",
    prepare: (ctx) => ({
      args: [
        "exec", "--skip-git-repo-check", "-m", "gpt-6-luna", "-c", 'model_reasoning_effort="low"', "-s", "read-only",
        "-c", 'approval_policy="never"',
        "-c", `mcp_servers.connectors.url="${ctx.url}/mcp"`,
        "-c", `mcp_servers.connectors.http_headers_helper="${ctx.headersScript} ${ctx.agent}"`,
        "-c", 'mcp_servers.connectors.default_tools_approval_mode="approve"',
        ctx.prompt,
      ],
    }),
  },
  {
    name: "grok",
    bin: "grok",
    describe: "project .grok/config.toml with bearer_token_file",
    // Grok drops tools whose <server>__<tool> name has a second "__".
    separator: "_",
    prepare: (ctx) => {
      const tokenFile = join(ctx.dir, "token");
      writeSecret(tokenFile, ctx.token);
      mkdirSync(join(ctx.dir, ".grok"), { recursive: true });
      writeFileSync(
        join(ctx.dir, ".grok", "config.toml"),
        `[mcp_servers.connectors]\nurl = "${ctx.url}/mcp"\nbearer_token_file = "${tokenFile}"\n`,
      );
      return {
        args: [
          "-p", ctx.prompt, "-m", "grok-4.7-build-fast", "--always-approve",
          // Our own leader, so Sam's running Grok sessions aren't involved.
          "--leader-socket", join(ctx.dir, "leader.sock"), "--cwd", ctx.dir,
        ],
        // Grok only starts a project's .grok/config.toml servers in a trusted
        // folder. `--trust` would record this temp folder in
        // ~/.grok/trusted_folders.toml; turning the gate off for this one
        // process leaves Sam's Grok config alone.
        env: { GROK_FOLDER_TRUST: "0" },
      };
    },
    cleanup: (ctx) => {
      // Stop the leader this run started (and only that one).
      spawnSync("pkill", ["-f", join(ctx.dir, "leader.sock")]);
    },
  },
  {
    name: "muse",
    bin: "muse",
    describe: "project .mcp.json with a literal headers value, --trust-workspace",
    prepare: (ctx) => {
      writeSecret(join(ctx.dir, ".mcp.json"), JSON.stringify({
        mcpServers: { connectors: { type: "http", url: `${ctx.url}/mcp`, headers: { Authorization: `Bearer ${ctx.token}` } } },
      }));
      return { args: ["exec", "--trust-workspace", "--reasoning-effort", "low", ctx.prompt] };
    },
  },
];

function writeSecret(path: string, contents: string): void {
  writeFileSync(path, contents, { mode: 0o600 });
  chmodSync(path, 0o600);
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

function which(bin: string): string | null {
  const found = spawnSync("/bin/sh", ["-c", `command -v ${bin}`], { encoding: "utf8" });
  return found.status === 0 ? found.stdout.trim() : null;
}

function version(bin: string): string {
  const result = spawnSync(bin, ["--version"], { encoding: "utf8", timeout: 30_000 });
  return (result.stdout || result.stderr).trim().split("\n")[0] ?? "unknown";
}

function runClient(bin: string, args: string[], cwd: string, env: Record<string, string>, logFile: string) {
  return new Promise<{ code: number | null; output: string; seconds: number }>((resolve) => {
    const started = Date.now();
    const child = spawn(bin, args, { cwd, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
    const timer = setTimeout(() => child.kill("SIGTERM"), RUN_TIMEOUT_MS);
    child.on("close", (code) => {
      clearTimeout(timer);
      writeFileSync(logFile, output);
      resolve({ code, output, seconds: Math.round((Date.now() - started) / 1000) });
    });
  });
}

async function waitForHealth(url: string): Promise<Record<string, string>> {
  const deadline = Date.now() + 60_000;
  let last: Record<string, string> = {};
  while (Date.now() < deadline) {
    try {
      const health = (await (await fetch(`${url}/health`)).json()) as { upstreams: Record<string, string> };
      last = health.upstreams;
      if (health.upstreams.fake === "ready" && health.upstreams.deepwiki === "ready") return last;
    } catch {
      // Not up yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Gateway upstreams never became ready: ${JSON.stringify(last)}`);
}

function listMuseConfig(): string {
  const dir = join(homedir(), ".config", "muse");
  try {
    return readdirSync(dir).map((name) => `${name}:${statSync(join(dir, name)).mtimeMs}`).join("\n");
  } catch {
    return "";
  }
}

/**
 * Approves the agent's next pending approval APPROVE_AFTER_MS after it was
 * made, through the approval page like Sam would. Returns how long after
 * it was made the approval went in, or null if none turned up.
 */
async function approveLater(url: string, home: string, agent: string, until: { done: boolean }): Promise<number | null> {
  const dbPath = join(home, "state", "connectors.sqlite");
  while (!until.done) {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    const row = db.prepare("SELECT id, createdAt FROM approvals WHERE agent = ? AND status = 'pending' ORDER BY createdAt LIMIT 1")
      .get(agent) as { id: string; createdAt: number } | undefined;
    db.close();
    if (row) {
      const wait = row.createdAt + APPROVE_AFTER_MS - Date.now();
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
      const headers = { "Tailscale-User-Login": "test@example.com" };
      const page = await (await fetch(`${url}/approvals/${row.id}`, { headers })).text();
      const csrf = /name="csrf" value="([^"]+)"/.exec(page)?.[1] ?? "";
      await fetch(`${url}/approvals/${row.id}`, {
        method: "POST",
        headers: { ...headers, "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ csrf, action: "approve" }).toString(),
        redirect: "manual",
      });
      return Date.now() - row.createdAt;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return null;
}

async function main(): Promise<number> {
  const { values } = parseArgs({ options: { only: { type: "string" }, approvals: { type: "boolean", default: false } } });
  const only = (values.only ?? process.env.CLIENTS ?? "").split(",").map((name) => name.trim()).filter(Boolean);
  const variants = VARIANTS.filter((variant) => only.length === 0 || only.includes(variant.name) || only.includes(variant.bin));

  const work = mkdtempSync(join(tmpdir(), "connectors-clients-"));
  const configDir = join(work, "config");
  mkdirSync(configDir);
  writeFileSync(join(configDir, "upstreams.json"), JSON.stringify([
    { id: "fake", title: "Fake stdio", prefix: "fake", type: "stdio", command: process.execPath, args: [FAKE_STDIO] },
    { id: "deepwiki", title: "DeepWiki", prefix: "deepwiki", type: "http", url: "https://mcp.deepwiki.com/mcp", auth: { type: "none" } },
  ], null, 2));
  writeFileSync(join(configDir, "agents.json"), JSON.stringify(
    VARIANTS.map((variant) => ({
      id: `test-${variant.name}`, title: `Test ${variant.name}`, upstreams: ["*"], toolSeparator: variant.separator ?? "__",
    })), null, 2,
  ));
  copyFileSync(join(REPO, "config", "policy.json"), join(configDir, "policy.json"));
  const home = join(work, "data");

  // The helper the *-helper variants call, standing in for install-clients.sh's
  // Keychain-backed headers.sh: prints {"Authorization":"Bearer <token>"}.
  const headersDir = join(work, "headers");
  mkdirSync(headersDir, { mode: 0o700 });
  const headersScript = join(work, "headers.sh");
  writeFileSync(headersScript, `#!/bin/sh\nexec cat "${headersDir}/$1.json"\n`, { mode: 0o700 });

  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const serverLog = join(work, "server.log");
  const server = spawn(process.execPath, [CLI, "serve", "--home", home, "--config-dir", configDir, "--port", String(port)], {
    env: { ...process.env, CONNECTORS_PUBLIC_URL: url, CONNECTORS_DEBUG_MCP: "1", CONNECTORS_ADMIN_LOGINS: "test@example.com" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let serverOutput = "";
  server.stdout.on("data", (chunk: Buffer) => (serverOutput += chunk.toString()));
  server.stderr.on("data", (chunk: Buffer) => (serverOutput += chunk.toString()));
  const results: Result[] = [];
  try {
    await waitForHealth(url);
    process.stdout.write(`Gateway at ${url}, work folder ${work}\n`);
    const museBefore = listMuseConfig();

    for (const variant of variants) {
      const agent = `test-${variant.name}`;
      const base: Omit<Result, "pass"> = {
        variant: variant.name, client: variant.bin, version: "", config: variant.describe, exitCode: null, seconds: 0,
        listed: null, protocols: [], echoOk: false, deepwikiOk: false, deepwikiTool: null, replyHasNonce: false,
      };
      if (!which(variant.bin)) {
        results.push({ ...base, pass: false, skipped: `${variant.bin} isn't installed` });
        continue;
      }
      const added = spawnSync(process.execPath, [CLI, "agent", "add", agent, "--home", home, "--config-dir", configDir], { encoding: "utf8" });
      const token = added.stdout.trim();
      if (added.status !== 0 || !token) throw new Error(`agent add ${agent} failed: ${added.stderr}`);
      writeSecret(join(headersDir, `${agent}.json`), JSON.stringify({ Authorization: `Bearer ${token}` }));
      const nonce = `ping-${randomBytes(4).toString("hex")}`;
      const sep = variant.separator ?? "__";
      const prompt =
        `Use the tools from the MCP server named "connectors". ` +
        `1) Call its fake${sep}echo tool with text "${nonce}". ` +
        `2) Call its deepwiki${sep}read_wiki_structure tool with repoName "${DEEPWIKI_REPO}". ` +
        `Then reply with the exact echo result on the first line and the first DeepWiki topic on the second line. Use no other tools.`;
      const dir = join(work, variant.name);
      mkdirSync(dir);
      const ctx: Ctx = { work, url, token, agent, prompt, dir, headersScript };
      const { args, env } = variant.prepare(ctx);
      process.stdout.write(`Running ${variant.name} (${variant.describe})...\n`);
      const linesBefore = serverOutput.length;
      const run = await runClient(variant.bin, args, dir, env ?? {}, join(dir, "output.log"));
      variant.cleanup?.(ctx);

      const db = new DatabaseSync(join(home, "state", "connectors.sqlite"), { readOnly: true });
      const calls = db.prepare("SELECT tool, ok, argsJson FROM calls WHERE agent = ?").all(agent) as {
        tool: string; ok: number; argsJson: string;
      }[];
      db.close();
      const serverLines = serverOutput.slice(linesBefore).split("\n");
      const listedLine = serverLines.find((line) => line.includes(`tools/list agent=${agent} `));
      const protocols = [...new Set(serverLines
        .filter((line) => line.includes(`mcp POST agent=${agent} `))
        .map((line) => /protocol=(\S+)/.exec(line)?.[1] ?? "?"))];
      const deepwiki = calls.find((call) => call.tool.startsWith("deepwiki__") && call.ok === 1);
      const result: Result = {
        ...base,
        version: version(variant.bin),
        exitCode: run.code,
        seconds: run.seconds,
        listed: listedLine ? Number(/tools=(\d+)/.exec(listedLine)?.[1]) : null,
        protocols,
        echoOk: calls.some((call) => call.tool === "fake__echo" && call.ok === 1 && call.argsJson.includes(nonce)),
        deepwikiOk: Boolean(deepwiki),
        deepwikiTool: deepwiki?.tool ?? null,
        replyHasNonce: run.output.includes(`stdio echo: ${nonce}`) || run.output.includes(nonce),
        pass: false,
      };
      result.pass = result.listed !== null && result.echoOk && result.deepwikiOk;
      results.push(result);
      process.stdout.write(`  ${result.pass ? "PASS" : "FAIL"} in ${run.seconds}s: listed=${result.listed} echo=${result.echoOk} deepwiki=${result.deepwikiOk} protocols=${protocols.join(",")}\n`);

      if (values.approvals && result.pass) {
        const sendNonce = `hello-${randomBytes(4).toString("hex")}`;
        const approvalPrompt =
          `Use the MCP server named "connectors". Call its fake${sep}send_report tool with to "ana" and title "${sendNonce}". ` +
          `It may answer that it is waiting for Sam's approval and give an id. If it does, call its ` +
          `connectors${sep}await_approval tool with that id, again if it is still waiting, until it returns a result. ` +
          `Then reply with the final result text only.`;
        const approvalDir = join(dir, "approval");
        mkdirSync(approvalDir);
        const approvalCtx: Ctx = { ...ctx, prompt: approvalPrompt, dir: approvalDir };
        const prepared = variant.prepare(approvalCtx);
        process.stdout.write(`  ${variant.name}: held call, approved after ${APPROVE_AFTER_MS / 1000}s...\n`);
        const until = { done: false };
        const approver = approveLater(url, home, agent, until);
        const held = await runClient(variant.bin, prepared.args, approvalDir, prepared.env ?? {}, join(approvalDir, "output.log"));
        until.done = true;
        variant.cleanup?.(approvalCtx);
        const approvedAfterMs = await approver;
        const heldDb = new DatabaseSync(join(home, "state", "connectors.sqlite"), { readOnly: true });
        const sent = heldDb.prepare("SELECT ok FROM calls WHERE agent = ? AND tool = 'fake__send_report' AND decision = 'approved'")
          .all(agent) as { ok: number }[];
        heldDb.close();
        result.approval = {
          ok: sent.length === 1 && sent[0]!.ok === 1,
          seconds: held.seconds,
          approvedAfterMs,
          // Claude Code hands the model the structuredContent, so its reply
          // can be {"sent":true,"to":"ana"} rather than the text.
          reply: held.output.includes("sent to ana") || held.output.includes('"sent":true'),
        };
        result.pass = result.pass && result.approval.ok;
        process.stdout.write(
          `  ${result.approval.ok ? "PASS" : "FAIL"} in ${held.seconds}s: ran once after approval=${result.approval.ok} ` +
            `approved at ${Math.round((approvedAfterMs ?? 0) / 1000)}s reply=${result.approval.reply}\n`,
        );
      }
    }

    if (variants.some((variant) => variant.bin === "muse") && listMuseConfig() !== museBefore) {
      process.stdout.write("WARNING: ~/.config/muse changed during the run\n");
    }
  } finally {
    server.kill("SIGTERM");
    writeFileSync(serverLog, serverOutput);
  }

  const resultsFile = join(work, "results.json");
  writeFileSync(resultsFile, `${JSON.stringify(results, null, 2)}\n`);
  process.stdout.write(`\n${"variant".padEnd(14)} ${"version".padEnd(34)} ${"result".padEnd(7)} protocols\n`);
  for (const result of results) {
    process.stdout.write(
      `${result.variant.padEnd(14)} ${(result.version || "-").slice(0, 34).padEnd(34)} ${(result.skipped ? "SKIP" : result.pass ? "PASS" : "FAIL").padEnd(7)} ${result.protocols.join(", ")}\n`,
    );
  }
  process.stdout.write(`\nResults: ${resultsFile}\nClient output and server log: ${work}\n`);
  return results.every((result) => result.pass || result.skipped) ? 0 : 1;
}

process.exitCode = await main();
