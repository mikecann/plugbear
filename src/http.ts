// HTTP routes. /mcp takes per-agent bearer tokens; /health is open. Who
// may use the admin, approval and OAuth callback pages depends on the mode:
//   tailscale  requests that came through `tailscale serve`, which adds
//              Tailscale-User-Login, from a login in adminLogins.
//   local      requests to this Mac's loopback address, with the expected
//              Host header (so a DNS-rebinding page can't pose as us), from
//              a browser holding the sign-in cookie that `connectors open`
//              hands out through a one-time code.
// Both check the CSRF token, Origin and Sec-Fetch-Site on every post.
//
// There are deliberately no /.well-known/oauth-* routes and the 401 has no
// WWW-Authenticate: Claude Code ignores a static Authorization header when
// a server advertises OAuth, and not being an OAuth server is what keeps
// the gateway clear of the confused-deputy problem.

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";

import type { McpHttpHandler } from "@modelcontextprotocol/server";
import { Hono, type Context } from "hono";
import { getCookie, setCookie } from "hono/cookie";

import { SETUP_SCRIPT_HASH, adminPage, approvalGroupPage, approvalPage, callsPage, connectPage, messagePage } from "./admin.ts";
import { upstreamsFor } from "./access.ts";
import { type Approvals, MAX_GROUP_SIZE } from "./approvals.ts";
import type { Config } from "./config.ts";
import type { Csrf } from "./csrf.ts";
import type { Store } from "./db.ts";
import type { Gateway } from "./gateway.ts";
import { type Logger, errorMessage, silentLogger } from "./log.ts";
import { callerAuthInfo } from "./mcp.ts";
import { readSecretFile, writeSecretFile } from "./secretFiles.ts";
import { MAX_ATTACHMENT_BYTES, UploadError, readUpload, saveUpload } from "./uploads.ts";
import { reportError } from "./sentry.ts";
import type { Mode } from "./settings.ts";
import { type SetupSummary, setupSteps } from "./setup.ts";
import { checkUrl } from "./ssrf.ts";
import type { TokenStore } from "./tokens.ts";
import type { UpstreamManager } from "./upstreams.ts";
import { RELEASE, VERSION } from "./version.ts";

export const OAUTH_STATE_TTL_MS = 10 * 60_000;
// Local mode: how long a code from `connectors open` works, and how long
// the cookie it buys lasts.
export const LOGIN_CODE_TTL_MS = 2 * 60_000;
const SESSION_MAX_AGE_S = 365 * 24 * 60 * 60;
const LOGIN_HEADER = "tailscale-user-login";
// The CSRF tokens' identity in local mode, where there's no login.
const LOCAL_LOGIN = "local";
const FLASH_TTL_MS = 5 * 60_000;
const MAX_FLASHES = 100;

export type AppDeps = {
  config: Config;
  store: Store;
  approvals: Approvals;
  manager: UpstreamManager;
  gateway: Gateway;
  mcp: McpHttpHandler;
  tokens: TokenStore;
  csrf: Csrf;
  publicUrl: string;
  mode: Mode;
  // Tailscale mode: logins that may use the admin and approval pages.
  // Anyone else on the tailnet (a shared node, another user) gets a 403.
  adminLogins: readonly string[];
  // Local mode: the port the pages answer on, and the sign-in cookie.
  port?: number;
  sessions?: AdminSessions;
  // Set while the server shuts down: /mcp answers 503.
  closing?: () => boolean;
  log?: Logger;
  // Lets tests send the browser to a loopback fake OAuth server.
  allowLoopbackUpstreams?: boolean;
  // Logs one line per /mcp request (CONNECTORS_DEBUG_MCP=1).
  debugMcp?: boolean;
  // Where POST /uploads keeps files. Without it there's no /uploads.
  uploadsDir?: string;
  now?: () => number;
};

type Env = { Bindings: { incoming?: IncomingMessage }; Variables: { login: string } };

/**
 * Local mode's admin sign-in. `connectors open` puts a one-time code in the
 * database and opens /admin/login?code=... in the browser; that page sets
 * a cookie and sends the browser on. The cookie's value is an HMAC from
 * secrets/admin-key, so deleting that file signs every browser out.
 */
export class AdminSessions {
  private readonly key: Buffer;
  private readonly store: Store;

  constructor(key: Buffer, store: Store) {
    if (key.length < 32) throw new Error("The admin key must be at least 32 bytes.");
    this.key = key;
    this.store = store;
  }

  static fromFile(path: string, store: Store): AdminSessions {
    let hex = readSecretFile(path)?.trim();
    if (!hex || !/^[0-9a-f]{64,}$/.test(hex)) {
      hex = randomBytes(32).toString("hex");
      writeSecretFile(path, `${hex}\n`);
    }
    return new AdminSessions(Buffer.from(hex, "hex"), store);
  }

  /** Mints a one-time code, as `connectors open` does. */
  static createCode(store: Store, now = Date.now()): string {
    const code = randomBytes(24).toString("base64url");
    store.insertLoginCode(code, now, LOGIN_CODE_TTL_MS);
    return code;
  }

  cookieValue(): string {
    return createHmac("sha256", this.key).update("admin-session").digest("base64url");
  }

  validCookie(value: string | undefined): boolean {
    if (!value) return false;
    const expected = Buffer.from(this.cookieValue());
    const actual = Buffer.from(value);
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  }

  takeCode(code: string, now: number): boolean {
    return code.length > 0 && code.length <= 64 && this.store.takeLoginCode(code, now);
  }
}

/** Where /admin/login may send the browser: only our own admin pages. */
export function safeNext(next: string | undefined): string {
  if (!next || !/^\/(?:admin|approvals)(?:[/?]|$)/.test(next) || next.includes("\\")) return "/admin";
  return next;
}

function loopbackAddress(address: string | undefined): boolean {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

function unauthorized(): Response {
  return new Response("Unauthorized\n", {
    status: 401,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}

/** "initialize,tools/list" for a POST body, for the debug log. */
async function rpcMethods(request: Request): Promise<string> {
  try {
    const body = JSON.parse(await request.clone().text()) as unknown;
    const messages = Array.isArray(body) ? body : [body];
    return messages
      .map((message) => {
        const { method, id } = (message ?? {}) as { method?: unknown; id?: unknown };
        if (typeof method === "string") return method.slice(0, 64);
        return id === undefined ? "?" : "response";
      })
      .join(",");
  } catch {
    return "unparsed";
  }
}

/**
 * The pages' CSP. Chrome checks form-action on every redirect after a form
 * post, and Connect is a form post that the server answers with a 303 to
 * the service's own sign-in page, so form-action must allow https (and, in
 * tests, the loopback fake). Without it Chrome silently cancels Connect.
 */
export function contentSecurityPolicy(allowLoopback = false): string {
  const formAction = ["'self'", "https:", ...(allowLoopback ? ["http://127.0.0.1:*", "http://localhost:*"] : [])];
  // The one script is the setup checklist's poll, allowed by its hash, and
  // it only fetches from this origin.
  return (
    // img-src data: is for the attachments on an email's approval page.
    `default-src 'none'; style-src 'unsafe-inline'; img-src data:; script-src '${SETUP_SCRIPT_HASH}'; connect-src 'self'; ` +
    `form-action ${formAction.join(" ")}; frame-ancestors 'none'`
  );
}

/**
 * Messages for the admin page's banner, kept here for a few minutes and
 * passed in the redirect by id. Free text in the query string would let any
 * link put its own words in the trusted banner.
 */
class Flashes {
  private readonly messages = new Map<string, { text: string; error: boolean; expiresAt: number }>();

  put(text: string, error: boolean, now: number): string {
    for (const [id, message] of this.messages) {
      if (message.expiresAt <= now || this.messages.size >= MAX_FLASHES) this.messages.delete(id);
    }
    const id = randomBytes(12).toString("base64url");
    this.messages.set(id, { text, error, expiresAt: now + FLASH_TTL_MS });
    return id;
  }

  get(id: string, now: number): { text: string; error: boolean } | undefined {
    const message = this.messages.get(id);
    return message && message.expiresAt > now ? message : undefined;
  }
}

export function createApp(deps: AppDeps): Hono<Env> {
  const log = deps.log ?? silentLogger;
  const now = deps.now ?? Date.now;
  const publicOrigin = new URL(deps.publicUrl).origin;
  const adminLogins = new Set(deps.adminLogins.map((login) => login.trim().toLowerCase()));
  const csp = contentSecurityPolicy(deps.allowLoopbackUpstreams);
  const flashes = new Flashes();
  const app = new Hono<Env>();

  const htmlResponse = (c: Context, body: string, status = 200): Response =>
    c.html(body, status as 200, {
      "cache-control": "no-store",
      "x-frame-options": "DENY",
      "content-security-policy": csp,
    });

  app.get("/health", (c) =>
    c.json({ ok: true, version: VERSION, release: RELEASE, upstreams: deps.manager.statuses() }),
  );

  const restarting = () =>
    new Response("Restarting, try again in a moment\n", {
      status: 503,
      headers: { "content-type": "text/plain; charset=utf-8", "retry-after": "5" },
    });
  const agentFor = (c: Context<Env>) => {
    const header = c.req.header("authorization") ?? "";
    const match = /^Bearer\s+(\S+)\s*$/i.exec(header);
    const agentId = match ? deps.tokens.verify(match[1]!) : null;
    return agentId ? deps.gateway.agent(agentId) : undefined;
  };

  app.all("/mcp", async (c) => {
    if (deps.closing?.()) return restarting();
    const agent = agentFor(c);
    if (!agent) return unauthorized();
    // Recorded in the call log, never used for auth: every device on the
    // tailnet sends the same login. In local mode nothing sets it, so it
    // isn't recorded.
    const tailscaleLogin = deps.mode === "tailscale" ? (c.req.header(LOGIN_HEADER) ?? null) : null;
    // The agent's token goes no further than this function.
    const headers = new Headers(c.req.raw.headers);
    headers.delete("authorization");
    headers.delete("cookie");
    // Rebuilt from its parts: the node adapter's request object isn't a
    // native Request, so it can't be passed to new Request() directly.
    const raw = c.req.raw;
    const hasBody = raw.method !== "GET" && raw.method !== "HEAD";
    const request = new Request(raw.url, {
      method: raw.method,
      headers,
      body: hasBody ? raw.body : null,
      signal: raw.signal,
      duplex: "half",
    } as RequestInit);
    // Only the JSON-RPC method names, never params, so no arguments.
    const methods = deps.debugMcp && hasBody ? await rpcMethods(request) : "";
    const response = await deps.mcp.fetch(request, { authInfo: callerAuthInfo({ agent, tailscaleLogin }) });
    if (deps.debugMcp) {
      // Protocol and transport details per request, for checking clients.
      log.info(
        `mcp ${raw.method} agent=${agent.id} protocol=${c.req.header("mcp-protocol-version") ?? "none"} ` +
          `session=${c.req.header("mcp-session-id") ? "yes" : "no"} rpc=${methods || "none"} status=${response.status} ` +
          `type=${response.headers.get("content-type")?.split(";")[0] ?? "none"}`,
      );
    }
    return response;
  });

  // An email attachment from an agent, so it can pass an uploadId instead of
  // typing a file out as base64 (see uploads.ts). Same token as /mcp. The
  // body is the raw file; ?filename= and Content-Type say what it is.
  app.post("/uploads", async (c) => {
    if (deps.closing?.()) return restarting();
    const agent = agentFor(c);
    if (!agent) return unauthorized();
    if (!deps.uploadsDir) return c.json({ error: "Uploads aren't set up on this gateway." }, 404);
    const declared = Number(c.req.header("content-length") ?? "0");
    const tooBig = () => c.json({ error: `An upload can be at most ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB.` }, 413);
    if (declared > MAX_ATTACHMENT_BYTES) return tooBig();
    // Read with a cap, since Content-Length can be missing or wrong.
    const chunks: Buffer[] = [];
    let size = 0;
    if (c.req.raw.body) {
      for await (const chunk of c.req.raw.body as unknown as AsyncIterable<Uint8Array>) {
        size += chunk.byteLength;
        if (size > MAX_ATTACHMENT_BYTES) return tooBig();
        chunks.push(Buffer.from(chunk));
      }
    }
    const contentType = c.req.header("content-type")?.split(";")[0]?.trim();
    try {
      const meta = saveUpload(
        deps.uploadsDir,
        Buffer.concat(chunks),
        { filename: c.req.query("filename") || undefined, contentType: contentType || undefined, agent: agent.id },
        now(),
      );
      log.info(`upload ${meta.id} from ${agent.id}: ${meta.contentType}, ${meta.size} bytes`);
      return c.json({
        uploadId: meta.id,
        ...(meta.filename ? { filename: meta.filename } : {}),
        contentType: meta.contentType,
        size: meta.size,
        expiresAt: new Date(meta.expiresAt).toISOString(),
      });
    } catch (error) {
      if (error instanceof UploadError) return c.json({ error: error.message }, error.status as 400);
      throw error;
    }
  });

  // Everything below is for the owner's browser only.
  const refuseCrossSite = (c: Context<Env>, allowedOrigins: ReadonlySet<string>): Response | undefined => {
    if (c.req.method !== "POST") return undefined;
    // Belt and braces next to the CSRF token: refuse cross-site posts.
    // Another page on 127.0.0.1 with a different port is same-site but not
    // same-origin, so it's refused too.
    const site = c.req.header("sec-fetch-site");
    if (site && site !== "same-origin" && site !== "none") return c.text("Cross-site request refused\n", 403);
    const origin = c.req.header("origin");
    if (origin && origin !== "null" && !allowedOrigins.has(origin)) return c.text("Cross-site request refused\n", 403);
    return undefined;
  };

  const tailnetOnly = async (c: Context<Env>, next: () => Promise<void>) => {
    const login = c.req.header(LOGIN_HEADER)?.trim();
    if (!login) {
      return c.text(
        `Open this page through Tailscale: ${new URL("/admin", deps.publicUrl).toString()}\n`,
        403,
      );
    }
    if (!adminLogins.has(login.toLowerCase())) {
      log.warn(`admin page refused for Tailscale login ${login}`);
      return c.text(
        adminLogins.size
          ? "Your Tailscale login can't use these pages.\n"
          : "No one can use these pages yet: set adminLogins in settings.json on the server.\n",
        403,
      );
    }
    c.set("login", login);
    const refused = refuseCrossSite(c, new Set([publicOrigin]));
    if (refused) return refused;
    await next();
  };

  // Local mode. The host check stops DNS rebinding: a page on evil.example
  // that points its name at 127.0.0.1 still sends Host: evil.example.
  const localHosts = new Set(
    deps.port === undefined ? [] : ["127.0.0.1", "localhost", "[::1]"].map((name) => `${name}:${deps.port}`),
  );
  localHosts.add(new URL(deps.publicUrl).host);
  const localOrigins = new Set([...localHosts].map((host) => `http://${host}`));
  localOrigins.add(publicOrigin);
  const cookieName = `connectors_admin_${deps.port ?? new URL(deps.publicUrl).port}`;

  const localCheck = (c: Context<Env>): Response | undefined => {
    const host = c.req.header("host")?.toLowerCase() ?? "";
    if (!localHosts.has(host)) return c.text(`These pages only answer at ${deps.publicUrl}\n`, 403);
    if (!loopbackAddress(c.env?.incoming?.socket.remoteAddress)) return c.text("These pages only answer on this Mac.\n", 403);
    return undefined;
  };

  const localOnly = async (c: Context<Env>, next: () => Promise<void>) => {
    // /admin/login is how a browser gets the cookie; it checks its own code.
    if (c.req.path === "/admin/login") return next();
    const refused = localCheck(c);
    if (refused) return refused;
    if (!deps.sessions?.validCookie(getCookie(c, cookieName))) {
      const path = c.req.method === "GET" ? c.req.path : "/admin";
      return htmlResponse(
        c,
        messagePage(
          "Open this page from Terminal",
          `This browser isn't signed in to PlugBear yet. Run "connectors open ${path}" on this Mac, which opens it signed in.`,
        ),
        401,
      );
    }
    c.set("login", LOCAL_LOGIN);
    const crossSite = refuseCrossSite(c, localOrigins);
    if (crossSite) return crossSite;
    await next();
  };

  const adminOnly = deps.mode === "local" ? localOnly : tailnetOnly;
  app.use("/admin", adminOnly);
  app.use("/admin/*", adminOnly);
  app.use("/approvals/*", adminOnly);
  app.use("/oauth/*", adminOnly);

  if (deps.mode === "local") {
    app.get("/admin/login", (c) => {
      const refused = localCheck(c);
      if (refused) return refused;
      if (!deps.sessions?.takeCode(c.req.query("code") ?? "", now())) {
        return htmlResponse(
          c,
          messagePage("Link expired", 'This sign-in link has expired or was already used. Run "connectors open" again.'),
          403,
        );
      }
      // Lax, not Strict: the browser comes back from a service's sign-in
      // page to /oauth/callback, a cross-site navigation, and must still
      // send the cookie. Cross-site posts don't get it.
      setCookie(c, cookieName, deps.sessions.cookieValue(), {
        path: "/",
        httpOnly: true,
        sameSite: "Lax",
        maxAge: SESSION_MAX_AGE_S,
      });
      c.header("referrer-policy", "no-referrer");
      c.header("cache-control", "no-store");
      return c.redirect(safeNext(c.req.query("next")), 303);
    });
  }

  const csrfFor = (c: Context<Env>) => (action: string) => deps.csrf.token(c.get("login"), action);

  const checkCsrf = async (c: Context<Env>, action: string): Promise<Record<string, string> | null> => {
    const form = await c.req.parseBody();
    const fields: Record<string, string> = {};
    for (const [key, value] of Object.entries(form)) {
      if (typeof value === "string") fields[key] = value;
    }
    return deps.csrf.check(c.get("login"), action, fields.csrf) ? fields : null;
  };

  // Read-only: everything here is already on the admin page.
  const setupSummary = (): SetupSummary => {
    const lastCalls = deps.store.lastCallByAgent();
    return setupSteps({
      services: deps.manager.all().map((connection) => ({
        id: connection.id,
        title: connection.config.title,
        state: connection.state,
        signsIn: connection.signsIn,
        google: connection.config.type === "google",
        accountEmail: connection.accountEmail,
        lastError: connection.lastError,
      })),
      agents: deps.config.agents.map((agent) => ({
        id: agent.id,
        title: agent.title,
        clientType: agent.client?.type,
        hasToken: deps.tokens.has(agent.id),
        lastCall: lastCalls.get(agent.id),
      })),
      mcpUrl: new URL("/mcp", deps.publicUrl).toString(),
    });
  };

  // Polled by the setup checklist on /admin; same login checks as the page.
  app.get("/admin/setup.json", (c) => {
    const setup = setupSummary();
    return c.json(
      {
        heading: setup.heading,
        todo: setup.todo,
        steps: setup.steps.map((step) => ({ id: step.id, done: step.done, line: step.line })),
      },
      200,
      { "cache-control": "no-store", "x-content-type-options": "nosniff" },
    );
  });

  app.get("/admin", (c) => {
    const lastCalls = deps.store.lastCallByAgent();
    const connected = deps.manager.get(c.req.query("connected") ?? "");
    const stored = flashes.get(c.req.query("flash") ?? "", now());
    const flash = stored
      ? stored
      : connected
        ? { text: `Signed in to ${connected.config.title}.` }
        : undefined;
    return htmlResponse(
      c,
      adminPage({
        setup: setupSummary(),
        connections: deps.manager.all(),
        agents: deps.config.agents.map((agent) => ({
          agent,
          hasToken: deps.tokens.has(agent.id),
          upstreams: upstreamsFor(agent, deps.config.upstreams).map((upstream) => upstream.id),
          lastCall: lastCalls.get(agent.id),
        })),
        pending: deps.approvals.pending(),
        agentTitles: new Map(deps.config.agents.map((agent) => [agent.id, agent.title])),
        flash,
        csrf: csrfFor(c),
      }),
    );
  });

  // A deep link to sign in to one service (Threadbear links here). Same
  // login checks as /admin; Connect is still a CSRF-protected POST.
  app.get("/admin/connect/:id", (c) => {
    const connection = deps.manager.get(c.req.param("id"));
    if (!connection) return htmlResponse(c, messagePage("Not found", "There's no service with that name."), 404);
    return htmlResponse(c, connectPage({ connection, csrf: csrfFor(c) }));
  });

  app.get("/admin/calls", (c) => {
    const sends = c.req.query("view") === "sends";
    const filter = {
      agent: c.req.query("agent") || undefined,
      upstream: c.req.query("upstream") || undefined,
      decision: c.req.query("decision") || undefined,
    };
    return htmlResponse(
      c,
      callsPage({
        calls: deps.store.calls({ ...filter, sendsOnly: sends, limit: 200 }),
        sends,
        filter,
        options: {
          agents: deps.store.distinctCallValues("agent"),
          upstreams: deps.store.distinctCallValues("upstream"),
          decisions: deps.store.distinctCallValues("decision"),
        },
      }),
    );
  });

  const backToAdmin = (c: Context, params: { connected?: string; error?: string } = {}) => {
    const url = new URL("/admin", "http://x");
    if (params.connected) url.searchParams.set("connected", params.connected);
    if (params.error) url.searchParams.set("flash", flashes.put(params.error, true, now()));
    return c.redirect(`${url.pathname}${url.search}`, 303);
  };

  app.post("/admin/upstreams/:id/connect", async (c) => {
    const id = c.req.param("id");
    const connection = deps.manager.get(id);
    if (!connection || !connection.signsIn) {
      return htmlResponse(c, messagePage("Not found", "There's no service with that name that signs in."), 404);
    }
    if (!(await checkCsrf(c, `connect:${id}`))) return c.text("Bad or missing CSRF token\n", 403);
    const state = randomBytes(24).toString("base64url");
    deps.store.insertOAuthState(state, id, now(), OAUTH_STATE_TTL_MS);
    try {
      const url = await connection.beginSignIn(state);
      if (!url) {
        void connection.connect();
        return backToAdmin(c, { connected: id });
      }
      // The owner's browser goes here, not us, but it should still be a
      // real https sign-in page.
      checkUrl(url, { allowLoopback: deps.allowLoopbackUpstreams });
      log.info(`${id}: sign-in started`);
      return c.redirect(url.toString(), 303);
    } catch (error) {
      log.warn(`${id}: starting sign-in failed: ${errorMessage(error)}`);
      return backToAdmin(c, { error: `Couldn't start signing in to ${connection.config.title}: ${errorMessage(error)}` });
    }
  });

  app.post("/admin/upstreams/:id/disconnect", async (c) => {
    const id = c.req.param("id");
    const connection = deps.manager.get(id);
    if (!connection) return htmlResponse(c, messagePage("Not found", "There's no service with that name."), 404);
    if (!(await checkCsrf(c, `disconnect:${id}`))) return c.text("Bad or missing CSRF token\n", 403);
    await connection.disconnect();
    return backToAdmin(c);
  });

  app.post("/admin/upstreams/:id/retry", async (c) => {
    const id = c.req.param("id");
    const connection = deps.manager.get(id);
    if (!connection) return htmlResponse(c, messagePage("Not found", "There's no service with that name."), 404);
    if (!(await checkCsrf(c, `retry:${id}`))) return c.text("Bad or missing CSRF token\n", 403);
    await connection.connect();
    return backToAdmin(c);
  });

  app.get("/oauth/callback", async (c) => {
    const state = c.req.query("state") ?? "";
    const upstreamId = state ? deps.store.takeOAuthState(state, now()) : undefined;
    if (!upstreamId) {
      return htmlResponse(
        c,
        messagePage("Sign-in link expired", "This sign-in link has expired or was already used. Start again from the admin page."),
        400,
      );
    }
    const connection = deps.manager.get(upstreamId)!;
    const providerError = c.req.query("error");
    if (providerError) {
      const description = c.req.query("error_description");
      return backToAdmin(c, {
        error: `${connection.config.title} didn't sign in: ${providerError}${description ? ` (${description})` : ""}`,
      });
    }
    const code = c.req.query("code");
    if (!code) return backToAdmin(c, { error: `${connection.config.title} sent no sign-in code.` });
    try {
      await connection.finishSignIn(code, c.req.query("iss"));
      return backToAdmin(c, { connected: upstreamId });
    } catch (error) {
      log.warn(`${upstreamId}: finishing sign-in failed: ${errorMessage(error)}`);
      return backToAdmin(c, { error: `Signing in to ${connection.config.title} failed: ${errorMessage(error)}` });
    }
  });

  // Several calls approved with one press. The form names the calls its page
  // showed and its CSRF token covers that exact list, so a call that came in
  // after the page loaded can't be swept up: it stays waiting, on the admin
  // page this lands on. decide() still refuses any that were decided or
  // expired in the meantime.
  app.post("/approvals/batch", async (c) => {
    const form = await c.req.parseBody();
    const list = typeof form.ids === "string" ? form.ids : "";
    const fields = await checkCsrf(c, `approvals:${list}`);
    if (!fields || !list) return c.text("Bad or missing CSRF token\n", 403);
    const action = fields.action;
    if (action !== "approve" && action !== "deny") return c.text("Choose approve or deny\n", 400);
    const ids = list.split(",");
    const decided = ids.filter(
      (id) => deps.approvals.decide(id, action === "approve" ? "approved" : "declined", fields.note).ok,
    ).length;
    const skipped = ids.length - decided;
    const text =
      (action === "approve"
        ? `Approved ${decided} ${decided === 1 ? "call" : "calls"}. The agent runs each one when it next checks.`
        : `Declined ${decided} ${decided === 1 ? "call" : "calls"}.`) +
      (skipped ? ` ${skipped} had already been answered or had expired, so ${skipped === 1 ? "it" : "they"} didn't change.` : "");
    return c.redirect(`/admin?flash=${flashes.put(text, false, now())}`, 303);
  });

  // So a held email's approval page can show the attached screenshots.
  const uploads = (id: string) => (deps.uploadsDir ? readUpload(deps.uploadsDir, id, now()) : undefined);

  app.get("/approvals/:id", (c) => {
    const record = deps.approvals.get(c.req.param("id"));
    if (!record) return htmlResponse(c, messagePage("Not found", "There's no approval with that id."), 404);
    const agentTitle = deps.gateway.agent(record.agent)?.title ?? record.agent;
    const upstreamTitle = deps.manager.get(record.upstream)?.config.title ?? record.upstream;
    const waiting = record.status === "pending" ? deps.approvals.waitingWith(record) : [record];
    if (waiting.length > 1 && waiting.length <= MAX_GROUP_SIZE) {
      return htmlResponse(
        c,
        approvalGroupPage({
          records: waiting,
          agentTitle,
          upstreamTitle,
          csrf: csrfFor(c),
          batchCsrf: csrfFor(c)(`approvals:${waiting.map((call) => call.id).join(",")}`),
          uploads,
        }),
      );
    }
    return htmlResponse(
      c,
      approvalPage({
        record,
        agentTitle,
        upstreamTitle,
        csrf: csrfFor(c)(`approval:${record.id}`),
        now: now(),
        tooManyToGroup: waiting.length > 1 ? waiting.length : undefined,
        uploads,
      }),
    );
  });

  app.post("/approvals/:id", async (c) => {
    const id = c.req.param("id");
    const fields = await checkCsrf(c, `approval:${id}`);
    if (!fields) return c.text("Bad or missing CSRF token\n", 403);
    const action = fields.action;
    if (action !== "approve" && action !== "deny") return c.text("Choose approve or deny\n", 400);
    const before = deps.approvals.get(id);
    const others = before?.status === "pending" ? deps.approvals.waitingWith(before).filter((call) => call.id !== id) : [];
    const result = deps.approvals.decide(id, action === "approve" ? "approved" : "declined", fields.note);
    if (!result.ok && result.reason === "not_found") {
      return htmlResponse(c, messagePage("Not found", "There's no approval with that id."), 404);
    }
    // On to the next one like it, so answering one doesn't lose the rest.
    const next = result.ok ? (others[0]?.id ?? id) : id;
    return c.redirect(`/approvals/${encodeURIComponent(next)}`, 303);
  });

  app.notFound((c) => c.text("Not found\n", 404));
  app.onError((error, c) => {
    log.error(`${c.req.method} ${c.req.path}: ${errorMessage(error)}`);
    // The route pattern, not the path, so approval ids and the like stay out.
    reportError(error, "http", { route: `${c.req.method} ${c.req.routePath}` });
    return c.text("Something went wrong\n", 500);
  });

  return app;
}
