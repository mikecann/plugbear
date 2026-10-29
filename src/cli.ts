// The connectors command:
//   connectors serve
//   connectors init            set up the data folder's config
//   connectors open [path]     open the admin pages in the browser
//   connectors agent add|rotate|remove <id>, connectors agent list
//   connectors settings, connectors status
// `agent add` and `agent rotate` print the new token on stdout and nothing
// else, so scripts can capture it; every other message goes to stderr.

import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

import { upstreamsFor } from "./access.ts";
import { CONFIG_FILES, configFile, loadConfig } from "./config.ts";
import { Store } from "./db.ts";
import { AdminSessions, safeNext } from "./http.ts";
import { ensureLayout, makeLayout, type Layout } from "./layout.ts";
import { consoleLogger, errorMessage } from "./log.ts";
import { flushSentry, initSentry, reportError } from "./sentry.ts";
import { startServer } from "./server.ts";
import {
  MODES,
  type Mode,
  type SettingsFile,
  loadSettings,
  parseLogins,
  parseSettingsFile,
  readSettingsFile,
  resolveSettings,
} from "./settings.ts";
import { TokenExistsError, issueToken, readAgentSecrets, removeToken } from "./tokens.ts";
import type { UpstreamStatus } from "./upstreams.ts";
import { VERSION } from "./version.ts";

const HELP = `connectors ${VERSION}: one MCP gateway for every agent

Usage:
  connectors serve [--port 8795] [--host 127.0.0.1] [--public-url URL]
  connectors init [--mode local|tailscale] [--admin-login LOGIN] [--public-url URL] [--owner NAME]
                                  Write settings.json and agents.json into the config folder if they're missing
  connectors open [PATH] [--print] Open the admin pages (or PATH, like /admin/connect/notion) signed in
  connectors agent add <id>       Make a token for an agent in agents.json and print it once
  connectors agent rotate <id>    Replace an agent's token (the old one stops working) and print it
  connectors agent remove <id>    Delete an agent's token
  connectors agent list [--json]  Show agents, whether each has a token, and what it can use
  connectors settings [--json]    Show the settings in effect and which config files are used
  connectors status [--json]      Show the running server's upstreams, approvals and recent calls

Options for every command:
  --home DIR        Data folder (default ~/Library/Application Support/Connectors, or CONNECTORS_HOME)
  --config-dir DIR  Config folder (default DIR/config, or CONNECTORS_CONFIG_DIR). Files missing
                    there come from the examples that ship with the app.

Environment (each overrides settings.json):
  CONNECTORS_MODE, CONNECTORS_PORT, CONNECTORS_HOST, CONNECTORS_PUBLIC_URL, CONNECTORS_OWNER
  CONNECTORS_ADMIN_LOGINS  Comma-separated Tailscale logins allowed on the admin pages (tailscale mode)
`;

const EXIT_TOKEN_EXISTS = 3;

function allowLoopback(): boolean {
  return process.env.CONNECTORS_ALLOW_LOOPBACK_UPSTREAMS === "1";
}

function stderr(line: string): void {
  process.stderr.write(`${line}\n`);
}

function layoutFrom(values: { home?: string; "config-dir"?: string }): Layout {
  return makeLayout({ root: values.home, configDir: values["config-dir"] });
}

const TAILSCALE_CANDIDATES = [
  "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
  "/opt/homebrew/bin/tailscale",
  "/usr/local/bin/tailscale",
  "tailscale",
];

/** This machine's tailnet name and Tailscale login, from `tailscale status --json`. */
export function tailscaleIdentity(env: NodeJS.ProcessEnv = process.env): { dnsName: string; login: string | null } | null {
  const candidates = env.CONNECTORS_TAILSCALE ? [env.CONNECTORS_TAILSCALE] : TAILSCALE_CANDIDATES;
  for (const candidate of candidates) {
    try {
      const out = execFileSync(candidate, ["status", "--json"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000 });
      const status = JSON.parse(out) as {
        Self?: { DNSName?: string; UserID?: number };
        User?: Record<string, { LoginName?: string }>;
      };
      const dnsName = status.Self?.DNSName?.replace(/\.$/, "");
      if (!dnsName) continue;
      const login = status.User?.[String(status.Self?.UserID)]?.LoginName ?? null;
      return { dnsName, login };
    } catch {
      // Not this one; try the next.
    }
  }
  return null;
}

type InitOptions = { mode?: string; adminLogin?: string; publicUrl?: string; owner?: string; port?: string };

/** Writes settings.json and agents.json if they're missing; never overwrites. */
function initCommand(layout: Layout, options: InitOptions): number {
  ensureLayout(layout);
  mkdirSync(layout.configDir, { recursive: true });
  if (options.mode && !(MODES as readonly string[]).includes(options.mode)) {
    stderr(`--mode must be local or tailscale, not ${options.mode}.`);
    return 2;
  }
  if (existsSync(layout.settingsFile)) {
    readSettingsFile(layout.settingsFile);
    stderr(`${layout.settingsFile} is already there, so it's left as it is.`);
  } else {
    const mode = (options.mode ?? "local") as Mode;
    const settings: SettingsFile = { mode };
    if (options.port) settings.port = Number(options.port);
    if (options.owner) settings.ownerName = options.owner;
    if (mode === "tailscale") {
      const identity = options.publicUrl && options.adminLogin ? null : tailscaleIdentity();
      settings.servePort = 8443;
      settings.publicUrl = options.publicUrl ?? (identity ? `https://${identity.dnsName}:8443` : undefined);
      const logins = options.adminLogin ? parseLogins(options.adminLogin) : identity?.login ? [identity.login] : [];
      settings.adminLogins = logins;
      if (!settings.publicUrl) {
        stderr("Couldn't read this machine's tailnet name from Tailscale. Pass --public-url https://<machine>.<tailnet>.ts.net:8443.");
        return 2;
      }
      if (logins.length === 0) {
        stderr("Couldn't read your Tailscale login. Pass --admin-login you@example.com.");
        return 2;
      }
    } else if (options.publicUrl) {
      settings.publicUrl = options.publicUrl;
    }
    // Checked like `serve` would, before anything is written. The
    // environment is left out: it's for running, not for what init writes.
    resolveSettings(parseSettingsFile(settings), {});
    writeFileSync(layout.settingsFile, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o644 });
    stderr(`Wrote ${layout.settingsFile} (${mode} mode).`);
  }
  const agents = join(layout.configDir, "agents.json");
  if (!existsSync(agents)) {
    copyFileSync(join(layout.examplesDir, "agents.example.json"), agents);
    stderr(`Wrote ${agents} from the example. Edit it to list your agents.`);
  }
  return 0;
}

async function openCommand(layout: Layout, path: string | undefined, print: boolean): Promise<number> {
  const settings = loadSettings(layout.settingsFile);
  const target = safeNext(path ?? "/admin");
  let url: URL;
  if (settings.mode === "local") {
    ensureLayout(layout);
    const store = new Store(layout.db);
    try {
      url = new URL("/admin/login", settings.publicUrl);
      url.searchParams.set("code", AdminSessions.createCode(store));
      url.searchParams.set("next", target);
    } finally {
      store.close();
    }
  } else {
    url = new URL(target, settings.publicUrl);
  }
  if (print) {
    // Local mode: the code works once, within two minutes.
    process.stdout.write(`${url.toString()}\n`);
    return 0;
  }
  execFileSync("/usr/bin/open", [url.toString()], { stdio: "ignore" });
  stderr(`Opened ${new URL(target, settings.publicUrl).toString()}`);
  return 0;
}

function settingsCommand(layout: Layout, json: boolean): number {
  const settings = loadSettings(layout.settingsFile);
  const files: { settings: string | null } & Record<(typeof CONFIG_FILES)[number], string> = {
    settings: existsSync(layout.settingsFile) ? layout.settingsFile : null,
    upstreams: configFile(layout, "upstreams"),
    agents: configFile(layout, "agents"),
    policy: configFile(layout, "policy"),
  };
  if (json) {
    process.stdout.write(`${JSON.stringify({ settings, files, home: layout.root, configDir: layout.configDir }, null, 2)}\n`);
    return 0;
  }
  process.stdout.write(
    [
      `Mode:        ${settings.mode}`,
      `Listens on:  ${settings.host}:${settings.port}`,
      `Public URL:  ${settings.publicUrl}`,
      ...(settings.mode === "tailscale" ? [`Admin logins: ${settings.adminLogins.join(", ") || "none"}`] : []),
      `Owner:       ${settings.ownerName}`,
      `Data folder: ${layout.root}`,
      `Config:      ${files.settings ?? `${layout.settingsFile} (missing, so defaults)`}`,
      ...CONFIG_FILES.map((name) => `             ${files[name]}`),
      "",
    ].join("\n"),
  );
  return 0;
}

async function agentCommand(layout: Layout, args: string[], json: boolean): Promise<number> {
  const [action, id] = args;
  // Same rule as `serve`, so a dev config with loopback upstreams loads here too.
  const config = loadConfig(layout, { allowLoopbackHttp: allowLoopback() });
  if (action === "list") {
    const secrets = readAgentSecrets(layout.agentsSecrets);
    const rows = config.agents.map((agent) => ({
      id: agent.id,
      title: agent.title,
      hasToken: Boolean(secrets.agents[agent.id]),
      createdAt: secrets.agents[agent.id]?.createdAt ?? null,
      rotatedAt: secrets.agents[agent.id]?.rotatedAt ?? null,
      client: agent.client ?? null,
      upstreams: upstreamsFor(agent, config.upstreams).map((upstream) => upstream.id),
    }));
    const orphans = Object.keys(secrets.agents).filter((agentId) => !config.agents.some((agent) => agent.id === agentId));
    if (json) {
      process.stdout.write(`${JSON.stringify({ agents: rows, tokensWithoutConfig: orphans }, null, 2)}\n`);
      return 0;
    }
    for (const row of rows) {
      process.stdout.write(
        `${row.id.padEnd(14)} ${row.hasToken ? "token set " : "no token  "} ${row.title}\n` +
          `${"".padEnd(14)} can use: ${row.upstreams.join(", ") || "nothing"}\n`,
      );
    }
    if (orphans.length) {
      process.stdout.write(`Tokens for agents not in agents.json: ${orphans.join(", ")}\n`);
    }
    return 0;
  }
  if (!id || !["add", "rotate", "remove"].includes(action ?? "")) {
    stderr(HELP);
    return 2;
  }
  ensureLayout(layout);
  if (action === "remove") {
    stderr(removeToken(layout.agentsSecrets, id) ? `Removed the token for ${id}.` : `${id} had no token.`);
    return 0;
  }
  if (!config.agents.some((agent) => agent.id === id)) {
    stderr(`${id} isn't in ${configFile(layout, "agents")}. Add it there first, then run this again.`);
    return 2;
  }
  try {
    const token = issueToken(layout.agentsSecrets, id, { rotate: action === "rotate" });
    process.stdout.write(`${token}\n`);
    stderr(
      action === "rotate"
        ? `Rotated the token for ${id}. The old one no longer works. This is the only time it's shown.`
        : `Made a token for ${id}. This is the only time it's shown.`,
    );
    return 0;
  } catch (error) {
    if (error instanceof TokenExistsError) {
      stderr(error.message);
      return EXIT_TOKEN_EXISTS;
    }
    throw error;
  }
}

async function statusCommand(layout: Layout, url: string, json: boolean): Promise<number> {
  type Health = { ok: boolean; version: string; upstreams: Record<string, UpstreamStatus> };
  let health: Health | null = null;
  try {
    const response = await fetch(new URL("/health", url), { signal: AbortSignal.timeout(3000) });
    if (response.ok) health = (await response.json()) as Health;
  } catch {
    // Not running; say so below.
  }
  let pending = 0;
  let recent = 0;
  if (existsSync(layout.db)) {
    const store = new Store(layout.db);
    try {
      pending = store.pendingApprovals(Date.now()).length;
      recent = (
        store.db.prepare("SELECT COUNT(*) AS n FROM calls WHERE ts > ?").get(Date.now() - 24 * 60 * 60 * 1000) as {
          n: number;
        }
      ).n;
    } finally {
      store.close();
    }
  }
  if (json) {
    process.stdout.write(`${JSON.stringify({ running: Boolean(health), health, pendingApprovals: pending, callsLast24h: recent }, null, 2)}\n`);
    return health ? 0 : 1;
  }
  if (!health) {
    process.stdout.write(`The server isn't answering at ${url}.\n`);
  } else {
    process.stdout.write(`Connectors ${health.version} is running at ${url}.\n`);
    for (const [id, status] of Object.entries(health.upstreams)) {
      process.stdout.write(`  ${id.padEnd(14)} ${status.state.padEnd(12)} ${status.message}\n`);
    }
  }
  process.stdout.write(`Approvals waiting: ${pending}. Calls in the last 24 hours: ${recent}.\n`);
  return health ? 0 : 1;
}

export async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      home: { type: "string" },
      "config-dir": { type: "string" },
      port: { type: "string" },
      host: { type: "string" },
      "public-url": { type: "string" },
      url: { type: "string" },
      mode: { type: "string" },
      "admin-login": { type: "string" },
      owner: { type: "string" },
      print: { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
      version: { type: "boolean", short: "v", default: false },
    },
  });
  if (values.version) {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }
  const [command, ...rest] = positionals;
  if (values.help || !command || command === "help") {
    process.stdout.write(HELP);
    return command || values.help ? 0 : 2;
  }
  const layout = layoutFrom(values);
  const port = values.port === undefined ? undefined : Number(values.port);
  if (port !== undefined && (!Number.isInteger(port) || port < 0 || port > 65535)) {
    stderr(`--port isn't a port: ${values.port}`);
    return 2;
  }
  switch (command) {
    case "serve": {
      // The deployed LaunchAgent only, and only with a DSN; see sentry.ts.
      await initSentry(consoleLogger, loadSettings(layout.settingsFile, process.env, { port, host: values.host }).sentryDsn);
      const server = await startServer({
        layout,
        port,
        host: values.host,
        publicUrl: values["public-url"],
        allowLoopbackUpstreams: allowLoopback(),
      });
      const shutdown = (signal: string) => {
        process.stdout.write(`${new Date().toISOString()} info ${signal}, shutting down\n`);
        // close() drains for up to 3 s; launchd waits 20 s before SIGKILL.
        const force = setTimeout(() => process.exit(0), 8000);
        force.unref();
        void server
          .close()
          .then(() => flushSentry())
          .finally(() => process.exit(0));
      };
      process.once("SIGTERM", () => shutdown("SIGTERM"));
      process.once("SIGINT", () => shutdown("SIGINT"));
      // Keep running until a signal arrives.
      return await new Promise<number>(() => {});
    }
    case "init":
      return initCommand(layout, {
        mode: values.mode,
        adminLogin: values["admin-login"],
        publicUrl: values["public-url"],
        owner: values.owner,
        port: values.port,
      });
    case "open":
      return openCommand(layout, rest[0], values.print);
    case "settings":
      return settingsCommand(layout, values.json);
    case "agent":
      return agentCommand(layout, rest, values.json);
    case "status": {
      const settings = loadSettings(layout.settingsFile, process.env, { port, host: values.host });
      return statusCommand(layout, values.url ?? `http://${settings.host}:${settings.port}`, values.json);
    }
    default:
      stderr(`Unknown command: ${command}\n`);
      stderr(HELP);
      return 2;
  }
}

// Run when executed directly (the bundle, or `node src/cli.ts`).
const invoked = process.argv[1] ?? "";
if (/(?:^|[\\/])(?:cli\.ts|connectors\.mjs|connectors)$/.test(invoked)) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    async (error: unknown) => {
      stderr(`connectors: ${errorMessage(error)}`);
      process.exitCode = 1;
      // A no-op unless `serve` turned Sentry on and then failed to start.
      reportError(error, "startup");
      await flushSentry();
    },
  );
}
