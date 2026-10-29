// Optional error reporting to the owner's own Sentry project, for the
// deployed gateway only. Agents run tests, `npm run dev` and local servers
// all day, and an agent may watch Sentry and act on every issue, so
// anything that isn't the real LaunchAgent must never report. It's on only
// when all of these hold:
//   - settings.json has a sentryDsn (or CONNECTORS_SENTRY_DSN is set); the
//     repo has none, so an install reports nowhere until its owner adds one,
//   - NODE_ENV=production, which only ops/launchd's plist sets,
//   - release.json exists, which only scripts/deploy.sh writes,
//   - not under `node --test`, not with loopback upstreams (tests and dev),
//     and CONNECTORS_SENTRY isn't "0" (the fake launchd in test/deploy sets it).
// Errors only: no tracing, no breadcrumbs, no request data. The gateway
// carries OAuth tokens, agent tokens and tool arguments and results, so
// events keep only the error and its stack, with anything token-shaped
// redacted. Upstream failures (an expired sign-in, a 5xx from Notion) aren't
// reported: they show on the admin page, and they're not gateway bugs.

import type { ErrorEvent } from "@sentry/node";

import type { Logger } from "./log.ts";
import { RELEASE } from "./version.ts";

type Sentry = typeof import("@sentry/node");
let sentry: Sentry | null = null;

export function sentryEnabled(env: NodeJS.ProcessEnv, release: string | null, dsn: string | null): boolean {
  return (
    Boolean(dsn) &&
    env.NODE_ENV === "production" &&
    release !== null &&
    env.NODE_TEST_CONTEXT === undefined &&
    env.CONNECTORS_ALLOW_LOOPBACK_UPSTREAMS !== "1" &&
    env.CONNECTORS_SENTRY !== "0"
  );
}

/** `connectors serve` calls this before starting the server, with settings' sentryDsn. */
export async function initSentry(log: Logger, dsn: string | null, env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  if (!dsn || !sentryEnabled(env, RELEASE, dsn)) return false;
  // Loaded only here, so tests and dev runs never even import the SDK.
  const Sentry = await import("@sentry/node");
  // No default integrations: they'd add request data, console and HTTP
  // breadcrumbs, local variables and source lines, any of which can hold a
  // token or tool arguments. Only the crash handlers and plain error info.
  Sentry.initWithoutDefaultIntegrations({
    dsn,
    environment: "production",
    release: `connectors@${RELEASE}`,
    // v11's replacement for sendDefaultPii: false, with everything off.
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: false,
      httpBodies: [],
      urlQueryParams: false,
      graphQL: { document: false, variables: false },
      genAI: { inputs: false, outputs: false },
      mcp: { inputs: false, outputs: false },
      databaseQueryData: false,
      queues: false,
      stackFrameVariables: false,
      frameContextLines: 0,
    },
    // Left on, the SDK rewrites "fetch failed" messages, which the gateway
    // (and looksLikeBug) read.
    enhanceFetchErrorMessages: false,
    tracesSampleRate: 0,
    maxBreadcrumbs: 0,
    enableRuntimeChannelInjection: false,
    integrations: [
      Sentry.eventFiltersIntegration(),
      Sentry.linkedErrorsIntegration(),
      Sentry.dedupeIntegration(),
      Sentry.nodeContextIntegration(),
      Sentry.onUncaughtExceptionIntegration(),
      // strict keeps Node's default: an unhandled rejection still crashes the
      // process and launchd restarts it, as before Sentry was added.
      Sentry.onUnhandledRejectionIntegration({ mode: "strict" }),
    ],
    initialScope: { tags: { component: "server" } },
    beforeBreadcrumb: () => null,
    beforeSend: scrubEvent,
  });
  sentry = Sentry;
  log.info(`sentry: reporting errors for release ${RELEASE}`);
  return true;
}

/**
 * Reports a gateway bug. `where` is a short fixed label ("http", "prune"),
 * and tags hold ids only, never arguments or results. A no-op unless
 * initSentry turned reporting on.
 */
export function reportError(error: unknown, where: string, tags: Record<string, string> = {}): void {
  sentry?.captureException(error, { level: "error", tags: { where, ...tags } });
}

/**
 * Whether an error thrown by a tool call looks like a bug in the gateway
 * rather than the upstream failing. Upstreams fail with MCP errors, HTTP
 * statuses, sign-in errors and "fetch failed" (a TypeError with a cause), and
 * bad upstream JSON is a SyntaxError, so only plain programming errors count.
 */
export function looksLikeBug(error: unknown): boolean {
  if (error instanceof ReferenceError || error instanceof RangeError) return true;
  return error instanceof TypeError && error.cause === undefined && error.message !== "fetch failed";
}

const REDACTIONS: [RegExp, string][] = [
  // Agent tokens (cn_<agent>_<64 hex>).
  [/\bcn_[a-z0-9-]+_[0-9a-f]{16,}/gi, "[agent token]"],
  [/\b(bearer|basic)\s+[^\s"',;]+/gi, "$1 [redacted]"],
  // Google access and refresh tokens, JWTs.
  [/\bya29\.[\w.-]+/g, "[google token]"],
  [/\b1\/\/[\w-]{20,}/g, "[google token]"],
  [/\beyJ[\w-]+\.[\w-]+\.[\w-]+/g, "[jwt]"],
  // Query strings carry OAuth codes and state.
  [/(https?:\/\/[^\s"'?#]+)\?[^\s"'#]*/g, "$1?[redacted]"],
  [/[\w.+-]+@[\w-]+\.[\w.-]+/g, "[email]"],
  // Anything else long and secret-looking.
  [/\b[A-Za-z0-9_\-]{40,}\b/g, "[redacted]"],
];

export function redact(text: string): string {
  return REDACTIONS.reduce((out, [pattern, replacement]) => out.replace(pattern, replacement), text);
}

/** Keeps the error type, message (redacted) and stack frames; drops the rest. */
export function scrubEvent(event: ErrorEvent): ErrorEvent {
  delete event.request;
  delete event.user;
  delete event.extra;
  delete event.breadcrumbs;
  if (typeof event.message === "string") event.message = redact(event.message);
  if (event.logentry?.message) event.logentry = { message: redact(event.logentry.message) };
  for (const exception of event.exception?.values ?? []) {
    if (exception.value) exception.value = redact(exception.value);
    for (const frame of exception.stacktrace?.frames ?? []) {
      delete frame.vars;
      delete frame.pre_context;
      delete frame.context_line;
      delete frame.post_context;
    }
  }
  return event;
}

/** Sends anything queued before the process exits (on SIGTERM). */
export async function flushSentry(timeoutMs = 2_000): Promise<void> {
  // Reporting must never stop a shutdown.
  await sentry?.close(timeoutMs).catch(() => false);
}
