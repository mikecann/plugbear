// Shared setup for the integration tests: a gateway on a random loopback
// port with a temp data folder, plus MCP clients of both protocol eras.

import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  Client as ModernClient,
  StreamableHTTPClientTransport as ModernTransport,
  type ClientOptions,
} from "@modelcontextprotocol/client";
import { Client as LegacyClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport as LegacyTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { parseAgents, parsePolicy, parseUpstreams, type Config } from "../src/config.ts";
import { makeLayout, ensureLayout, type Layout } from "../src/layout.ts";
import { memoryLogger } from "../src/log.ts";
import type { Notifier } from "../src/notify.ts";
import { startServer, type RunningServer, type ServerOptions } from "../src/server.ts";
import { issueToken } from "../src/tokens.ts";

export const FAKE_STDIO_SERVER = fileURLToPath(new URL("./fixtures/fakeStdioServer.ts", import.meta.url));
export const LOGIN = "sam@example.com";

export type Gateway = RunningServer & {
  layout: Layout;
  tokens: Record<string, string>;
  pushes: { title: string; clickUrl: string }[];
  logs: string[];
};

export async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

export function tempLayout(): Layout {
  const root = mkdtempSync(join(tmpdir(), "connectors-test-"));
  const layout = makeLayout({ root, configDir: join(root, "config") });
  ensureLayout(layout);
  return layout;
}

export async function startGateway(options: {
  upstreams: unknown[];
  agents?: unknown[];
  policy?: unknown;
  holdMs?: number;
  layout?: Layout;
  beforeStart?: (layout: Layout) => void;
  server?: Partial<ServerOptions>;
  // false: return as soon as it listens, without waiting for upstreams.
  waitForUpstreams?: boolean;
}): Promise<Gateway> {
  const layout = options.layout ?? tempLayout();
  const config: Config = {
    upstreams: parseUpstreams(options.upstreams, { allowLoopbackHttp: true }),
    agents: parseAgents(
      options.agents ?? [
        { id: "claude-3", title: "Claude (claude-3)", upstreams: ["*"] },
        { id: "codex", title: "Codex", upstreams: ["*"] },
        // Grok needs <prefix>_<tool> names (docs/client-compat.md).
        { id: "grok", title: "Grok", upstreams: ["*", "!tag:work"], toolSeparator: "_" },
      ],
    ),
    policy: parsePolicy(
      options.policy ?? {
        default: "allow",
        rules: [
          { tool: "*__*send*", action: "ask" },
          { tool: "*__*delete*", action: "deny" },
        ],
      },
    ),
  };
  const tokens: Record<string, string> = {};
  for (const agent of config.agents) {
    tokens[agent.id] = issueToken(layout.agentsSecrets, agent.id, { rotate: false });
  }
  options.beforeStart?.(layout);
  const pushes: { title: string; clickUrl: string }[] = [];
  const notify: Notifier = async (message) => {
    pushes.push(message);
  };
  const log = memoryLogger();
  const port = await freePort();
  const server = await startServer({
    layout,
    config,
    port,
    publicUrl: `http://127.0.0.1:${port}`,
    holdMs: options.holdMs ?? 300,
    allowLoopbackUpstreams: true,
    // Most tests use tailscale mode with a made-up login; local mode has
    // its own tests (test/local-admin.test.ts).
    mode: "tailscale",
    adminLogins: [LOGIN],
    ownerName: "Sam",
    log,
    notify,
    ...options.server,
  });
  if (options.waitForUpstreams !== false) await server.manager.whenSettled(15_000);
  return Object.assign(server, { layout, tokens, pushes, logs: log.lines });
}

export function stdioUpstream(extra: Record<string, unknown> = {}) {
  return {
    id: "fake",
    title: "Fake stdio",
    prefix: "fake",
    type: "stdio",
    command: process.execPath,
    args: [FAKE_STDIO_SERVER],
    ...extra,
  };
}

/** A 2025-era client (v1 SDK), like Codex, Grok and Muse. */
export async function legacyClient(gateway: Gateway, agentId: string): Promise<LegacyClient> {
  const client = new LegacyClient({ name: "legacy-test", version: "1.0.0" });
  await client.connect(
    new LegacyTransport(new URL(`${gateway.url}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${gateway.tokens[agentId]}`, "Tailscale-User-Login": LOGIN } },
    }),
  );
  return client;
}

/** A 2026-07-28 client (v2 SDK pinned to the stateless protocol), like Claude Code. */
export async function modernClient(
  gateway: Gateway,
  agentId: string,
  options: Omit<ClientOptions, "versionNegotiation"> = {},
): Promise<ModernClient> {
  const client = new ModernClient(
    { name: "modern-test", version: "1.0.0" },
    { ...options, versionNegotiation: { mode: { pin: "2026-07-28" } } },
  );
  await client.connect(
    new ModernTransport(new URL(`${gateway.url}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${gateway.tokens[agentId]}` } },
    }),
  );
  return client;
}

export function textOf(result: unknown): string {
  const content = (result as { content?: { type: string; text?: string }[] }).content ?? [];
  return content.map((block) => block.text ?? "").join("\n");
}

export function adminHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { "Tailscale-User-Login": LOGIN, ...extra };
}

/** Reads the CSRF token out of a page's form. */
export async function csrfFrom(url: string): Promise<string> {
  const page = await fetch(url, { headers: adminHeaders() });
  const html = await page.text();
  const match = /name="csrf" value="([^"]+)"/.exec(html);
  if (!match) throw new Error(`No CSRF token on ${url}`);
  return match[1]!;
}

export async function postForm(url: string, fields: Record<string, string>, headers: Record<string, string> = adminHeaders()) {
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
    body: new URLSearchParams(fields).toString(),
    redirect: "manual",
  });
}

export function writeSecret(layout: Layout, relative: string, value: string): void {
  writeFileSync(join(layout.secrets, relative), value, { mode: 0o600 });
}
