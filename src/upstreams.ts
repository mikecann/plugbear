// Connections to upstream MCP servers: remote HTTP (OAuth, static bearer or
// no auth) and local stdio servers. Each upstream connects in the
// background, caches its tool list, refreshes it on list_changed and every
// ten minutes, and reconnects with backoff after a failure. A down or
// signed-out upstream contributes no tools; it never breaks the others.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

import {
  Client,
  SdkError,
  SdkErrorCode,
  SdkHttpError,
  StreamableHTTPClientTransport,
  UnauthorizedError,
  auth,
  type Tool,
  type Transport,
  type jsonSchemaValidator,
} from "@modelcontextprotocol/client";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/client/stdio";

import type {
  AgentConfig,
  GoogleUpstreamConfig,
  HttpUpstreamConfig,
  StdioUpstreamConfig,
  UpstreamConfig,
} from "./config.ts";
import { agentCanUse } from "./access.ts";
import { GoogleAccount, NeedsSetupError, SERVICE_NAMES, SERVICE_SCOPES, type GoogleEndpoints } from "./google/account.ts";
import { AUTH_META_KEY, TOKEN_META_KEY } from "./google/api.ts";
import type { Layout } from "./layout.ts";
import { type Logger, errorMessage, silentLogger } from "./log.ts";
import { type Separator, SEPARATORS, nameTools } from "./naming.ts";
import { FileOAuthProvider, NeedsSignInError, deleteTokens, singleFlightAuth } from "./oauth.ts";
import { readSecretFile, secretPath } from "./secretFiles.ts";
import { BlockedRequestError, type GuardedFetch } from "./ssrf.ts";
import type { ToolResult } from "./approvals.ts";
import { VERSION } from "./version.ts";

export type UpstreamState =
  | "disabled"
  | "idle"
  | "connecting"
  | "ready"
  | "needs_sign_in"
  // Can't sign in yet: the OAuth client file is missing (Google).
  | "needs_setup"
  | "error";

/**
 * What /health says about an upstream. Threadbear reads this, so keep the
 * shape and the state names stable. No secrets or emails.
 */
export type HealthState = "connected" | "connecting" | "signed_out" | "needs_setup" | "error" | "disabled";
export type UpstreamStatus = {
  id: string;
  title: string;
  state: HealthState;
  message: string;
  // The page where the owner signs in to (or retries) just this upstream.
  connectUrl: string;
  tools: number;
};

const HEALTH_STATES: Record<UpstreamState, HealthState> = {
  disabled: "disabled",
  idle: "connecting",
  connecting: "connecting",
  ready: "connected",
  needs_sign_in: "signed_out",
  needs_setup: "needs_setup",
  error: "error",
};

/** States that show a <prefix>__sign_in tool instead of the upstream's tools. */
export function showsSignInStub(state: UpstreamState): boolean {
  return state === "needs_sign_in" || state === "needs_setup";
}

/**
 * The built-in Google server's script. In the deployed bundle every module
 * is dist/connectors.mjs and the server is built next to it as
 * dist/google-mcp.mjs; in the repo (tests, dev) it runs from source.
 */
export function googleServerScript(): string {
  const here = fileURLToPath(import.meta.url);
  return here.endsWith(".mjs") ? join(dirname(here), "google-mcp.mjs") : join(dirname(here), "google", "server.ts");
}

export type ExposedTool = {
  name: string;
  title?: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
};

// One upstream's tools as agents of one naming style see them, with the
// map from exposed names back to the upstream's own names.
type ToolView = { tools: ExposedTool[]; names: Map<string, string> };

function emptyViews(): Record<Separator, ToolView> {
  return { __: { tools: [], names: new Map() }, _: { tools: [], names: new Map() } };
}

export type UpstreamDeps = {
  layout: Layout;
  publicUrl: string;
  fetch: GuardedFetch;
  log?: Logger;
  connectTimeoutMs?: number;
  // Called when an upstream's state or tool list changes.
  onChange?: () => void;
  // Tests only: a fake Google sign-in and API on loopback.
  googleEndpoints?: GoogleEndpoints;
  googleApiBase?: string;
};

const DEFAULT_CALL_TIMEOUT_MS = 120_000;
const LIST_TIMEOUT_MS = 30_000;
const REFRESH_INTERVAL_MS = 10 * 60_000;
const MIN_BACKOFF_MS = 15_000;
const MAX_BACKOFF_MS = 10 * 60_000;
// Several upstreams connecting at once make one tools/list_changed.
const TOOLS_CHANGED_DEBOUNCE_MS = 300;

// Results pass through untouched, so don't let the SDK reject an upstream's
// structured output against its own schema; the agent's client can decide.
const passThroughValidator = {
  getValidator: () => (input: unknown) => ({ valid: true, data: input, errorMessage: undefined }),
} as unknown as jsonSchemaValidator;

// Keeps the built-in Google servers small; they hold a few API responses
// at a time.
const GOOGLE_SERVER_HEAP_MB = 64;

function isAuthError(error: unknown): boolean {
  if (error instanceof NeedsSignInError || error instanceof UnauthorizedError) return true;
  if (error instanceof SdkHttpError && (error.status === 401 || error.status === 403)) return true;
  if (error instanceof SdkError && error.code === SdkErrorCode.ClientHttpAuthentication) return true;
  const name = (error as Error | undefined)?.name ?? "";
  return name === "OAuthError" || name === "InvalidGrantError";
}

// The upstream forgot our session (it restarted): its GET stream now gets
// 404s, and the SDK's reconnects give up. Nothing would notice until the
// next call, so tool changes would be missed in the meantime.
// Errors from posting a request don't count: the call that made them
// already reconnects and retries (isSafeToRetry).
function streamLost(error: Error): boolean {
  if (error instanceof SdkHttpError) {
    return error.code === SdkErrorCode.ClientHttpFailedToOpenStream && error.status === 404;
  }
  return (
    (/Failed to reconnect SSE stream/.test(error.message) && /Not Found|\b404\b/i.test(error.message)) ||
    /Maximum reconnection attempts/.test(error.message)
  );
}

// A request that never reached the upstream (session gone, not connected)
// is safe to retry after reconnecting. Anything else might have run.
function isSafeToRetry(error: unknown): boolean {
  if (error instanceof SdkHttpError && error.status === 404) return true;
  if (error instanceof SdkError && error.code === SdkErrorCode.NotConnected) return true;
  return false;
}

/** "Notion (Work)" becomes "(Notion, Work)". */
export function describeSuffix(title: string): string {
  const match = /^(.*?)\s*\((.+)\)$/.exec(title);
  return match ? `(${match[1]}, ${match[2]})` : `(${title})`;
}

function baseTitle(title: string): string {
  return title.replace(/\s*\(.*\)$/, "").trim().toLowerCase();
}

export class UpstreamConnection {
  readonly config: UpstreamConfig;
  lastError?: string;
  readyAt?: number;
  refreshedAt?: number;
  lastAttemptAt?: number;
  // Set once the first connect attempt has finished, either way.
  settled = false;
  descriptionSuffix?: string;

  private readonly deps: UpstreamDeps;
  private readonly log: Logger;
  private views = emptyViews();
  private client?: Client;
  private connecting?: Promise<void>;
  private backoffMs = MIN_BACKOFF_MS;
  private retryTimer?: NodeJS.Timeout;
  private stopped = false;
  private generation = 0;
  private currentState: UpstreamState;
  // Calls in flight, and whether the session was lost while they ran.
  private calls = 0;
  private sessionLost = false;
  // A hash of the tool list, so a refresh that changes nothing isn't news.
  toolsHash = "";
  // The shared Google sign-in, for "google" upstreams.
  readonly account?: GoogleAccount;

  constructor(config: UpstreamConfig, deps: UpstreamDeps, account?: GoogleAccount) {
    this.config = config;
    this.deps = deps;
    this.log = deps.log ?? silentLogger;
    this.currentState = config.enabled ? "idle" : "disabled";
    if (!config.enabled) this.settled = true;
    this.account = account;
    // A sign-in or sign-out from any upstream on the account applies to all of them.
    account?.listen({
      signedIn: () => {
        this.backoffMs = MIN_BACKOFF_MS;
        void this.connect();
      },
      signedOut: (reason) => this.markSignedOut(reason),
    });
  }

  get id(): string {
    return this.config.id;
  }

  /** Whether the owner signs in to this upstream from the admin page. */
  get signsIn(): boolean {
    return this.config.type === "google" || (this.config.type === "http" && this.config.auth.type === "oauth");
  }

  /** The page where the owner signs in to (or retries) just this upstream. */
  get connectUrl(): string {
    return new URL(`/admin/connect/${encodeURIComponent(this.id)}`, this.deps.publicUrl).toString();
  }

  /** The Google account's email, for the admin pages only. */
  get accountEmail(): string | undefined {
    return this.account?.isSignedIn() ? this.account.email() : undefined;
  }

  status(): UpstreamStatus {
    const state = HEALTH_STATES[this.state];
    const messages: Record<HealthState, string> = {
      connected: `Connected, ${this.tools.length} tools.`,
      connecting: "Connecting.",
      // These come from the gateway's own code, never from an upstream.
      signed_out: this.lastError ?? "Needs sign-in.",
      needs_setup: this.lastError ?? "Needs setting up.",
      // Upstream errors can say anything, so they stay on the admin page.
      error: "Not reachable. The admin page has the details.",
      disabled: "Turned off.",
    };
    return {
      id: this.id,
      title: this.config.title,
      state,
      message: messages[state],
      connectUrl: this.connectUrl,
      tools: this.state === "ready" ? this.tools.length : 0,
    };
  }

  get state(): UpstreamState {
    return this.currentState;
  }

  set state(next: UpstreamState) {
    if (next === this.currentState) return;
    this.currentState = next;
    this.deps.onChange?.();
  }

  /** The cached tools in the default <prefix>__<tool> style. */
  get tools(): ExposedTool[] {
    return this.views.__.tools;
  }

  toolsFor(separator: Separator): ExposedTool[] {
    return this.views[separator].tools;
  }

  private clearTools(): void {
    this.views = emptyViews();
    this.toolsHash = "";
    this.deps.onChange?.();
  }

  /** Connects (or reconnects) and loads the tool list. One at a time. */
  connect(): Promise<void> {
    if (!this.config.enabled || this.stopped) return Promise.resolve();
    this.connecting ??= this.doConnect().finally(() => {
      this.connecting = undefined;
    });
    return this.connecting;
  }

  private async doConnect(): Promise<void> {
    clearTimeout(this.retryTimer);
    const generation = ++this.generation;
    await this.closeClient();
    this.state = "connecting";
    this.lastAttemptAt = Date.now();
    const client = new Client(
      { name: "connectors", version: VERSION },
      {
        capabilities: {},
        jsonSchemaValidator: passThroughValidator,
        listChanged: {
          tools: {
            onChanged: (error, tools) => {
              if (generation !== this.generation) return;
              if (error) {
                this.log.warn(`${this.id}: refreshing tools after list_changed failed: ${errorMessage(error)}`);
              } else if (tools) {
                this.applyTools(tools);
                this.log.info(`${this.id}: tool list changed, now ${this.tools.length} tools`);
              }
            },
          },
        },
      },
    );
    try {
      const transport = await this.makeTransport();
      client.onerror = (error) => {
        if (generation !== this.generation || this.stopped || this.state !== "ready") return;
        if (!streamLost(error)) return;
        // Reconnecting closes the old client, which would fail calls still
        // in flight on it. Those get a 404 and reconnect by themselves; if
        // they don't, the last one to finish reconnects.
        if (this.calls > 0) {
          this.sessionLost = true;
          return;
        }
        this.log.warn(`${this.id}: lost the session (${errorMessage(error)}), reconnecting`);
        void this.connect();
      };
      client.onclose = () => {
        if (generation !== this.generation || this.stopped) return;
        if (this.state === "ready") {
          this.state = "error";
          this.lastError = "The connection closed.";
          this.log.warn(`${this.id}: connection closed`);
          this.scheduleRetry();
        }
      };
      await client.connect(transport, { timeout: this.deps.connectTimeoutMs ?? 30_000 });
      // Stopped, signed out or reconnected while this was starting: close
      // it, or a stdio child outlives the gateway (seen under heavy load).
      if (generation !== this.generation || this.stopped) {
        await client.close().catch(() => {});
        return;
      }
      this.client = client;
      const { tools } = await client.listTools(undefined, { timeout: LIST_TIMEOUT_MS });
      if (generation !== this.generation || this.stopped) {
        if (this.client === client) this.client = undefined;
        await client.close().catch(() => {});
        return;
      }
      this.applyTools(tools);
      this.state = "ready";
      this.lastError = undefined;
      this.readyAt = Date.now();
      this.backoffMs = MIN_BACKOFF_MS;
      this.log.info(`${this.id}: ready with ${this.tools.length} tools`);
    } catch (error) {
      await client.close().catch(() => {});
      if (generation !== this.generation) return;
      this.client = undefined;
      this.clearTools();
      if (error instanceof NeedsSetupError) {
        this.state = "needs_setup";
        this.lastError = error.message;
        this.log.warn(`${this.id}: ${error.message}`);
      } else if (isAuthError(error)) {
        this.state = "needs_sign_in";
        this.lastError = (error instanceof NeedsSignInError && error.reason) || "Needs sign-in.";
        this.log.warn(`${this.id}: needs sign-in`);
      } else {
        this.state = "error";
        this.lastError = errorMessage(error);
        this.log.warn(`${this.id}: connect failed: ${this.lastError}`);
        this.scheduleRetry();
      }
    } finally {
      this.settled = true;
    }
  }

  private async makeTransport(): Promise<Transport> {
    if (this.config.type === "stdio") return this.makeStdioTransport(this.config);
    if (this.config.type === "google") return this.makeGoogleTransport(this.config);
    return this.makeHttpTransport(this.config);
  }

  /**
   * Starts the built-in Google server for this service, but only once the
   * account is set up, signed in with this service's scopes, and its
   * refresh token still works. Until then no process runs at all.
   */
  private async makeGoogleTransport(config: GoogleUpstreamConfig): Promise<Transport> {
    const account = this.account!;
    account.checkClient();
    if (!account.isSignedIn()) throw new NeedsSignInError(this.id);
    const missing = account.missingScopes(SERVICE_SCOPES[config.service]);
    if (missing.length) {
      throw new NeedsSignInError(
        this.id,
        `Google didn't grant access to ${SERVICE_NAMES[config.service]}. Connect again and allow it.`,
      );
    }
    // Signs the account out (every upstream on it) if Google refuses the refresh token.
    await account.accessToken();
    const script = googleServerScript();
    const env: Record<string, string> = { ...getDefaultEnvironment() };
    if (this.deps.googleApiBase) env.CONNECTORS_GOOGLE_API_BASE = this.deps.googleApiBase;
    this.log.info(`${this.id}: starting the built-in Google server for ${config.service}`);
    return this.watchStderr(
      new StdioClientTransport({
        command: process.execPath,
        args: [`--max-old-space-size=${GOOGLE_SERVER_HEAP_MB}`, script, config.service],
        env,
        stderr: "pipe",
      }),
    );
  }

  private watchStderr(transport: StdioClientTransport): StdioClientTransport {
    const stderr = transport.stderr;
    if (stderr) {
      const lines = createInterface({ input: stderr as NodeJS.ReadableStream });
      lines.on("line", (line) => {
        if (line.trim()) this.log.info(`${this.id} stderr: ${line.slice(0, 500)}`);
      });
    }
    return transport;
  }

  private makeHttpTransport(config: HttpUpstreamConfig): Transport {
    const headers: Record<string, string> = {};
    let authProvider: FileOAuthProvider | undefined;
    if (config.auth.type === "bearer") {
      const token = readSecretFile(secretPath(this.deps.layout.secrets, `upstream-tokens/${config.id}`))?.trim();
      if (!token) throw new NeedsSignInError(config.id);
      headers.Authorization = `Bearer ${token}`;
    } else if (config.auth.type === "oauth") {
      authProvider = this.oauthProvider();
      if (!authProvider.hasTokens()) throw new NeedsSignInError(config.id);
    }
    return new StreamableHTTPClientTransport(new URL(config.url), {
      fetch: this.deps.fetch,
      authProvider: authProvider ? singleFlightAuth(authProvider) : undefined,
      requestInit: { headers },
    });
  }

  private makeStdioTransport(config: StdioUpstreamConfig): Transport {
    const env: Record<string, string> = { ...getDefaultEnvironment() };
    for (const [key, value] of Object.entries(config.env)) {
      env[key] =
        typeof value === "string"
          ? value
          : readFileSync(secretPath(this.deps.layout.secrets, value.secretFile), "utf8").trim();
    }
    // Commands only ever come from config, and every launch is logged.
    this.log.info(`${this.id}: starting ${config.command} ${config.args.join(" ")}`.trim());
    return this.watchStderr(
      new StdioClientTransport({
        command: config.command,
        args: config.args,
        env,
        cwd: config.cwd,
        stderr: "pipe",
      }),
    );
  }

  oauthProvider(state?: string): FileOAuthProvider {
    if (this.config.type !== "http" || this.config.auth.type !== "oauth") {
      throw new Error(`${this.id} doesn't use OAuth.`);
    }
    return new FileOAuthProvider({
      upstream: this.config,
      layout: this.deps.layout,
      publicUrl: this.deps.publicUrl,
      state,
    });
  }

  private applyTools(tools: Tool[]): void {
    const byOriginal = new Map(tools.map((tool) => [tool.name, tool]));
    const views = emptyViews();
    for (const separator of SEPARATORS) {
      const names = nameTools(this.config.prefix, tools.map((tool) => tool.name), separator);
      const exposed: ExposedTool[] = [];
      for (const [name, original] of names) {
        const tool = byOriginal.get(original)!;
        const description = [tool.description, this.descriptionSuffix].filter(Boolean).join(" ");
        exposed.push({
          name,
          ...(tool.title ? { title: tool.title } : {}),
          ...(description ? { description } : {}),
          inputSchema: tool.inputSchema as Record<string, unknown>,
          ...(tool.outputSchema ? { outputSchema: tool.outputSchema as Record<string, unknown> } : {}),
          ...(tool.annotations ? { annotations: tool.annotations as Record<string, unknown> } : {}),
        });
      }
      views[separator] = { tools: exposed, names };
    }
    this.views = views;
    this.refreshedAt = Date.now();
    this.toolsHash = createHash("sha256").update(JSON.stringify(views.__.tools)).digest("hex");
    this.deps.onChange?.();
  }

  originalName(exposedName: string, separator: Separator = "__"): string | undefined {
    return this.views[separator].names.get(exposedName);
  }

  async refreshTools(): Promise<void> {
    if (this.state !== "ready" || !this.client) return;
    if (this.account) {
      // Notices a revoked Google sign-in within the hour, not at the next call.
      try {
        await this.account.accessToken();
      } catch (error) {
        if (error instanceof NeedsSignInError) return;
        this.log.warn(`${this.id}: refreshing the Google token failed: ${errorMessage(error)}`);
      }
    }
    try {
      const { tools } = await this.client.listTools(undefined, { timeout: LIST_TIMEOUT_MS });
      this.applyTools(tools);
    } catch (error) {
      this.log.warn(`${this.id}: refreshing tools failed: ${errorMessage(error)}`);
      await this.connect();
    }
  }

  /** Calls an upstream tool by its own name. Throws on transport failure. */
  async callTool(
    original: string,
    args: Record<string, unknown>,
    options: { signal?: AbortSignal } = {},
  ): Promise<ToolResult> {
    if (this.state !== "ready" || !this.client) {
      if (this.state === "needs_sign_in") throw new NeedsSignInError(this.id);
      await this.connect();
      // connect() changes the state; TypeScript can't see that.
      const state = this.state as UpstreamState;
      if (state !== "ready" || !this.client) {
        if (showsSignInStub(state)) throw new NeedsSignInError(this.id, this.lastError);
        throw new Error(`${this.config.title} isn't reachable: ${this.lastError ?? this.state}`);
      }
    }
    this.calls += 1;
    const generation = this.generation;
    try {
      return await this.callOnce(original, args, options);
    } finally {
      this.calls -= 1;
      if (this.calls === 0 && this.sessionLost) {
        this.sessionLost = false;
        if (generation === this.generation && this.state === "ready") {
          this.log.warn(`${this.id}: lost the session, reconnecting`);
          void this.connect();
        }
      }
    }
  }

  private async callOnce(
    original: string,
    args: Record<string, unknown>,
    options: { signal?: AbortSignal },
  ): Promise<ToolResult> {
    const request = async (forceRefresh = false) => {
      // The built-in Google server gets a fresh access token with each call.
      const meta = this.account ? { [TOKEN_META_KEY]: await this.account.accessToken(forceRefresh) } : undefined;
      return (await this.client!.callTool(
        { name: original, arguments: args, ...(meta ? { _meta: meta } : {}) },
        {
          timeout: this.config.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS,
          resetTimeoutOnProgress: true,
          signal: options.signal,
        },
      )) as ToolResult;
    };
    try {
      const result = await request();
      // Google refused the token (revoked early, say): refresh and try once more.
      const meta = (result as { _meta?: Record<string, unknown> })._meta;
      if (this.account && meta?.[AUTH_META_KEY] === "unauthorized") return await request(true);
      return result;
    } catch (error) {
      if (isSafeToRetry(error)) {
        this.log.warn(`${this.id}: session lost, reconnecting and retrying once`);
        await this.connect();
        if (this.state === "ready" && this.client) return await request();
      }
      if (isAuthError(error)) {
        this.state = "needs_sign_in";
        this.lastError = (error instanceof NeedsSignInError && error.reason) || "Needs sign-in.";
        this.clearTools();
        throw error instanceof NeedsSignInError ? error : new NeedsSignInError(this.id);
      }
      if (error instanceof BlockedRequestError) {
        this.state = "error";
        this.lastError = error.message;
      }
      throw error;
    }
  }

  private scheduleRetry(): void {
    if (this.stopped) return;
    clearTimeout(this.retryTimer);
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, MAX_BACKOFF_MS);
    this.retryTimer = setTimeout(() => void this.connect(), delay);
    this.retryTimer.unref();
  }

  /**
   * Signed out from elsewhere: Google refused the refresh token, or the owner
   * pressed Disconnect on another upstream on the same account.
   */
  markSignedOut(reason: string): void {
    this.generation += 1;
    clearTimeout(this.retryTimer);
    this.state = "needs_sign_in";
    this.lastError = reason;
    try {
      this.account?.checkClient();
    } catch (error) {
      // Signing in again needs the OAuth client back first.
      this.state = "needs_setup";
      this.lastError = errorMessage(error);
    }
    this.clearTools();
    void this.closeClient();
    this.log.info(`${this.id}: signed out (${reason})`);
  }

  /** Forgets OAuth tokens and drops the connection. */
  async disconnect(): Promise<void> {
    if (this.account) {
      // Every upstream on the account hears about it, this one included.
      this.account.signOut("Signed out.");
      return;
    }
    this.generation += 1;
    clearTimeout(this.retryTimer);
    await this.closeClient();
    deleteTokens(this.deps.layout, this.id);
    this.clearTools();
    this.state = "needs_sign_in";
    this.lastError = "Signed out.";
    this.log.info(`${this.id}: disconnected, tokens deleted`);
  }

  /**
   * Starts an interactive sign-in and returns the provider URL to send
   * the owner's browser to, or null if it was already authorized (a refresh).
   */
  async beginSignIn(state: string): Promise<URL | null> {
    if (this.account) return this.account.authorizationUrl(state);
    const config = this.config as HttpUpstreamConfig;
    const provider = this.oauthProvider(state);
    const result = await auth(provider, {
      serverUrl: config.url,
      scope: config.scopes?.join(" "),
      fetchFn: this.deps.fetch,
      forceReauthorization: true,
    });
    if (result === "REDIRECT") {
      if (!provider.authorizationUrl) throw new Error("The provider didn't give a sign-in URL.");
      return provider.authorizationUrl;
    }
    return null;
  }

  async finishSignIn(code: string, iss: string | undefined): Promise<void> {
    if (this.account) {
      // Connects every upstream on the account, this one included.
      await this.account.finishSignIn(code);
      await this.connect();
      return;
    }
    const config = this.config as HttpUpstreamConfig;
    const provider = this.oauthProvider();
    await auth(provider, {
      serverUrl: config.url,
      authorizationCode: code,
      iss,
      fetchFn: this.deps.fetch,
    });
    this.log.info(`${this.id}: signed in`);
    this.backoffMs = MIN_BACKOFF_MS;
    await this.connect();
  }

  private async closeClient(): Promise<void> {
    const client = this.client;
    this.client = undefined;
    if (client) await client.close().catch(() => {});
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.generation += 1;
    clearTimeout(this.retryTimer);
    await this.closeClient();
  }
}

export class UpstreamManager {
  private readonly connections = new Map<string, UpstreamConnection>();
  private readonly byPrefix = new Map<string, UpstreamConnection>();
  private refreshTimer?: NodeJS.Timeout;
  private readonly log: Logger;
  private startedAt?: number;
  private readonly toolsListeners = new Set<() => void>();
  private toolsTimer?: NodeJS.Timeout;
  private toolsSeen = "";

  constructor(upstreams: readonly UpstreamConfig[], deps: UpstreamDeps) {
    this.log = deps.log ?? silentLogger;
    const accounts = new Map<string, GoogleAccount>();
    for (const config of upstreams) {
      let account: GoogleAccount | undefined;
      if (config.type === "google") {
        account = accounts.get(config.account);
        if (!account) {
          account = new GoogleAccount({
            id: config.account,
            layout: deps.layout,
            publicUrl: deps.publicUrl,
            fetch: deps.fetch,
            endpoints: deps.googleEndpoints,
            log: this.log,
          });
          accounts.set(config.account, account);
        }
        // Turned-off upstreams don't widen the sign-in.
        if (config.enabled) account.addScopes(SERVICE_SCOPES[config.service]);
      }
      const connection = new UpstreamConnection(config, { ...deps, onChange: () => this.toolsMayHaveChanged() }, account);
      this.connections.set(config.id, connection);
      this.byPrefix.set(config.prefix, connection);
    }
    // Two upstreams for the same service (two Notion workspaces) get a
    // suffix on their descriptions so an agent can tell them apart.
    for (const connection of this.connections.values()) {
      const twins = [...this.connections.values()].filter(
        (other) =>
          other !== connection &&
          ((other.config.type === "http" &&
            connection.config.type === "http" &&
            other.config.url === connection.config.url) ||
            baseTitle(other.config.title) === baseTitle(connection.config.title)),
      );
      if (twins.length > 0) connection.descriptionSuffix = describeSuffix(connection.config.title);
    }
  }

  /** Connects every enabled upstream in the background. */
  start(): void {
    this.startedAt = Date.now();
    this.toolsSeen = this.toolsFingerprint();
    for (const connection of this.connections.values()) void connection.connect();
    this.refreshTimer = setInterval(() => void this.refreshAll(), REFRESH_INTERVAL_MS);
    this.refreshTimer.unref();
  }

  async refreshAll(): Promise<void> {
    await Promise.all(
      [...this.connections.values()].map(async (connection) => {
        if (connection.state === "ready") await connection.refreshTools();
        // needs_setup: the owner may have put the OAuth client in place since.
        else if (["idle", "error", "needs_setup"].includes(connection.state)) await connection.connect();
      }),
    );
  }

  async stop(): Promise<void> {
    clearInterval(this.refreshTimer);
    clearTimeout(this.toolsTimer);
    this.toolsListeners.clear();
    await Promise.all([...this.connections.values()].map((connection) => connection.stop()));
  }

  /**
   * Calls the listener (debounced) when the tools agents can see change: an
   * upstream comes up or goes down, or its tool list changes.
   */
  onToolsChanged(listener: () => void): () => void {
    this.toolsListeners.add(listener);
    return () => this.toolsListeners.delete(listener);
  }

  // A signed-out upstream lists a sign_in stub, so that's a change too.
  private toolsFingerprint(): string {
    return this.all()
      .map((connection) => {
        const tools =
          connection.state === "ready" ? connection.toolsHash : showsSignInStub(connection.state) ? "sign_in" : "-";
        return `${connection.id}:${tools}`;
      })
      .join(",");
  }

  private toolsMayHaveChanged(): void {
    if (this.toolsTimer) return;
    this.toolsTimer = setTimeout(() => {
      this.toolsTimer = undefined;
      const now = this.toolsFingerprint();
      if (now === this.toolsSeen) return;
      this.toolsSeen = now;
      for (const listener of this.toolsListeners) listener();
    }, TOOLS_CHANGED_DEBOUNCE_MS);
    this.toolsTimer.unref();
  }

  /**
   * Waits until every upstream has made its first attempt, but never past
   * `timeoutMs` after start(): once the gateway has been up that long,
   * nobody waits for a slow upstream.
   */
  async whenSettled(timeoutMs: number): Promise<void> {
    const deadline = (this.startedAt ?? Date.now()) + timeoutMs;
    while (Date.now() < deadline) {
      if ([...this.connections.values()].every((connection) => connection.settled)) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  get(id: string): UpstreamConnection | undefined {
    return this.connections.get(id);
  }

  all(): UpstreamConnection[] {
    return [...this.connections.values()];
  }

  forAgent(agent: AgentConfig): UpstreamConnection[] {
    return this.all().filter((connection) => connectionAllowed(agent, connection));
  }

  /**
   * Finds the upstream and original tool name for an exposed name in one
   * naming style. Prefixes have no "_", so the first separator ends one.
   */
  resolve(
    exposedName: string,
    separator: Separator = "__",
  ): { connection: UpstreamConnection; original: string } | undefined {
    const split = exposedName.indexOf(separator);
    if (split <= 0) return undefined;
    const connection = this.byPrefix.get(exposedName.slice(0, split));
    const original = connection?.originalName(exposedName, separator);
    return connection && original !== undefined ? { connection, original } : undefined;
  }

  /** For /health: every upstream by id. */
  statuses(): Record<string, UpstreamStatus> {
    return Object.fromEntries(this.all().map((connection) => [connection.id, connection.status()]));
  }

  logStatus(): void {
    for (const connection of this.all()) {
      this.log.info(`${connection.id}: ${connection.state}`);
    }
  }
}

function connectionAllowed(agent: AgentConfig, connection: UpstreamConnection): boolean {
  return connection.config.enabled && agentCanUse(agent, connection.config);
}
