// Wires everything together and listens. `connectors serve` calls this; so
// do the integration tests, with a temp data folder and loopback upstreams.

import type { AddressInfo } from "node:net";
import type { Server as HttpServer } from "node:http";

import { serve } from "@hono/node-server";

import { Approvals, HOLD_MS } from "./approvals.ts";
import { type Config, loadConfig } from "./config.ts";
import { Csrf } from "./csrf.ts";
import { Store } from "./db.ts";
import { Gateway } from "./gateway.ts";
import type { GoogleEndpoints } from "./google/account.ts";
import { AdminSessions, createApp } from "./http.ts";
import { type Layout, ensureLayout } from "./layout.ts";
import { type Logger, consoleLogger, errorMessage } from "./log.ts";
import { createMcpEndpoint } from "./mcp.ts";
import { reportError } from "./sentry.ts";
import { type Notifier, createNtfyNotifier } from "./notify.ts";
import { type Mode, type Settings, loadSettings } from "./settings.ts";
import { createGuardedFetch } from "./ssrf.ts";
import { TokenStore } from "./tokens.ts";
import { UpstreamManager } from "./upstreams.ts";
import { VERSION } from "./version.ts";

const PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;
const EXPIRE_INTERVAL_MS = 60_000;
// On shutdown, how long running tool calls get to finish before connections
// are cut. Held calls answer at once with their approval id.
export const DRAIN_MS = 3_000;

export type ServerOptions = {
  layout: Layout;
  config?: Config;
  // Read from the layout's settings.json (and the environment) unless given.
  settings?: Settings;
  // Each of these overrides the matching setting.
  mode?: Mode;
  port?: number;
  host?: string;
  publicUrl?: string;
  ownerName?: string;
  holdMs?: number;
  // Tests only: lets upstreams and OAuth servers live on 127.0.0.1.
  allowLoopbackUpstreams?: boolean;
  log?: Logger;
  notify?: Notifier;
  connectTimeoutMs?: number;
  debugMcp?: boolean;
  // Tailscale mode: logins allowed on the admin pages.
  adminLogins?: readonly string[];
  drainMs?: number;
  maxCallsInFlightPerAgent?: number;
  // Tests only: a fake Google sign-in and API on loopback.
  googleEndpoints?: GoogleEndpoints;
  googleApiBase?: string;
};

export type RunningServer = {
  url: string;
  settings: Settings;
  port: number;
  manager: UpstreamManager;
  approvals: Approvals;
  store: Store;
  gateway: Gateway;
  close(): Promise<void>;
};

export async function startServer(options: ServerOptions): Promise<RunningServer> {
  const log = options.log ?? consoleLogger;
  const layout = options.layout;
  ensureLayout(layout);
  const config =
    options.config ??
    loadConfig(layout, { allowLoopbackHttp: options.allowLoopbackUpstreams });
  const settings =
    options.settings ??
    loadSettings(layout.settingsFile, process.env, {
      mode: options.mode,
      port: options.port,
      host: options.host,
      publicUrl: options.publicUrl,
      adminLogins: options.adminLogins,
      ownerName: options.ownerName,
    });
  const { publicUrl, host, mode } = settings;

  const store = new Store(layout.db);
  const approvals = new Approvals(store, { log });
  const fetchGuarded = createGuardedFetch({ allowLoopback: options.allowLoopbackUpstreams });
  const manager = new UpstreamManager(config.upstreams, {
    layout,
    publicUrl,
    fetch: fetchGuarded,
    log,
    connectTimeoutMs: options.connectTimeoutMs,
    googleEndpoints: options.googleEndpoints,
    googleApiBase: options.googleApiBase,
  });
  const notify = options.notify ?? createNtfyNotifier({ topicFile: layout.ntfyTopic, log });
  const gateway = new Gateway({
    config,
    manager,
    approvals,
    store,
    notify,
    publicUrl,
    ownerName: settings.ownerName,
    holdMs: options.holdMs ?? HOLD_MS,
    log,
    maxCallsInFlightPerAgent: options.maxCallsInFlightPerAgent,
  });
  const mcp = createMcpEndpoint(gateway, log);
  // Open subscriptions/listen streams hear about tool changes.
  manager.onToolsChanged(() => {
    log.info("tools changed, telling listening clients");
    mcp.notify.toolsChanged();
  });
  const adminLogins = settings.adminLogins;
  if (mode === "tailscale" && adminLogins.length === 0) {
    log.warn("adminLogins is empty in settings.json, so the admin and approval pages refuse everyone");
  }
  let closing = false;
  const app = createApp({
    config,
    store,
    approvals,
    manager,
    gateway,
    mcp,
    tokens: new TokenStore(layout.agentsSecrets),
    csrf: Csrf.fromFile(layout.csrfKey),
    publicUrl,
    mode,
    adminLogins,
    // The port the pages answer on, for the local-mode host check.
    port: settings.port,
    sessions: mode === "local" ? AdminSessions.fromFile(layout.adminKey, store) : undefined,
    closing: () => closing,
    log,
    allowLoopbackUpstreams: options.allowLoopbackUpstreams,
    debugMcp: options.debugMcp ?? process.env.CONNECTORS_DEBUG_MCP === "1",
  });

  const server = await new Promise<HttpServer>((resolve, reject) => {
    // overrideGlobalObjects: false keeps the real global Response. Hono's
    // replacement breaks the MCP SDK's `instanceof Response` checks on fetch
    // results (it then misreads OAuth error responses).
    const created = serve(
      { fetch: app.fetch, port: settings.port, hostname: host, overrideGlobalObjects: false },
      () => resolve(created as HttpServer),
    ) as HttpServer;
    created.once("error", reject);
  });
  const port = (server.address() as AddressInfo).port;
  const url = `http://${host}:${port}`;

  const prune = () => {
    try {
      const removed = store.prune(Date.now());
      log.info(`pruned ${removed.calls} calls, ${removed.approvals} approvals, ${removed.states} sign-in states`);
    } catch (error) {
      log.error(`pruning failed: ${errorMessage(error)}`);
      reportError(error, "prune");
    }
  };
  prune();
  const pruneTimer = setInterval(prune, PRUNE_INTERVAL_MS);
  pruneTimer.unref();
  const expireTimer = setInterval(() => approvals.expireDue(), EXPIRE_INTERVAL_MS);
  expireTimer.unref();

  manager.start();
  log.info(
    `connectors ${VERSION} listening on ${url} in ${mode} mode, public URL ${publicUrl}, data in ${layout.root}, config in ${layout.configDir}, ` +
      `${config.upstreams.length} upstreams, ${config.agents.length} agents`,
  );

  return {
    url,
    settings,
    port,
    manager,
    approvals,
    store,
    gateway,
    async close() {
      clearInterval(pruneTimer);
      clearInterval(expireTimer);
      // New /mcp requests get a 503, held calls answer now with their
      // approval id (so the agent can still await it after the restart),
      // and other running calls get a moment to finish.
      closing = true;
      approvals.release();
      await gateway.drain(options.drainMs ?? DRAIN_MS);
      // Let the last responses reach the wire before connections are cut.
      await new Promise((resolve) => setTimeout(resolve, 100));
      await mcp.close();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeIdleConnections?.();
        setTimeout(() => server.closeAllConnections?.(), 500).unref();
      });
      await manager.stop();
      store.close();
    },
  };
}
