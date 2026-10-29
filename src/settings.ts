// Settings for one install: how the gateway listens, who may use its admin
// pages, and what agents call the person who approves things. They live in
// <data folder>/config/settings.json, outside the repo, and every field is
// optional. Environment variables and command-line flags override the file
// (tests and one-off runs use them).
//
// Two modes:
//   local      the gateway and its admin pages are on this Mac only, at
//              http://127.0.0.1:<port>. The admin pages need a sign-in
//              cookie from `connectors open` (see http.ts).
//   tailscale  `tailscale serve` publishes the gateway on the tailnet, and
//              the admin pages only answer requests it forwarded for one of
//              `adminLogins`.

import { existsSync, readFileSync } from "node:fs";

import { z } from "zod";

export const MODES = ["local", "tailscale"] as const;
export type Mode = (typeof MODES)[number];

export const DEFAULT_PORT = 8795;
export const DEFAULT_HOST = "127.0.0.1";
export const DEFAULT_SERVE_PORT = 8443;
export const DEFAULT_LAUNCHD_LABEL = "local.connectors";
// What agents call the person who approves calls, unless settings say.
export const DEFAULT_OWNER = "the user";

const portSchema = z.number().int().min(1).max(65535);

export const settingsSchema = z.strictObject({
  mode: z.enum(MODES).optional(),
  host: z.string().min(1).optional(),
  port: portSchema.optional(),
  // Base URL for links agents pass on (approvals, Connect pages) and the
  // OAuth redirect. Local mode: http://127.0.0.1:<port> unless set.
  // Tailscale mode: required, e.g. https://<machine>.<tailnet>.ts.net:8443.
  publicUrl: z.url().optional(),
  // Tailscale mode: the Tailscale logins allowed on the admin pages.
  adminLogins: z.array(z.string().min(1)).optional(),
  // Tailscale mode: the HTTPS port `tailscale serve` publishes on.
  servePort: portSchema.optional(),
  // A first name, so agents say "Waiting for Sam to approve this".
  ownerName: z.string().trim().min(1).max(40).optional(),
  // The LaunchAgent's label, for scripts/deploy.sh.
  launchdLabel: z
    .string()
    .regex(/^[A-Za-z0-9][A-Za-z0-9.-]{0,99}$/, "use letters, digits, dots or dashes")
    .optional(),
  // On the Mac where the agents run: the ssh host the gateway runs on, if
  // not this Mac. scripts/deploy.sh and install-clients.sh use it.
  gatewayHost: z
    .string()
    .regex(/^[A-Za-z0-9._@-]{1,100}$/, "use an ssh host name")
    .optional(),
  // Optional: report the deployed gateway's own bugs to this Sentry
  // project (see sentry.ts). No DSN, no reporting.
  sentryDsn: z.url().optional(),
});

export type SettingsFile = z.infer<typeof settingsSchema>;

export type Settings = {
  mode: Mode;
  host: string;
  port: number;
  publicUrl: string;
  adminLogins: string[];
  servePort: number;
  ownerName: string;
  launchdLabel: string;
  gatewayHost: string | null;
  sentryDsn: string | null;
};

export type SettingsOverrides = Partial<{
  mode: Mode;
  host: string;
  port: number;
  publicUrl: string;
  adminLogins: readonly string[];
  ownerName: string;
}>;

/** Comma-separated logins, as CONNECTORS_ADMIN_LOGINS has them. */
export function parseLogins(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((login) => login.trim().toLowerCase())
    .filter(Boolean);
}

export function isLoopbackHost(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "[::1]" ||
    hostname === "::1" ||
    /^127(\.\d{1,3}){3}$/.test(hostname)
  );
}

export function parseSettingsFile(raw: unknown, file = "settings.json"): SettingsFile {
  const result = settingsSchema.safeParse(raw);
  if (!result.success) throw new Error(`${file} is not valid:\n${z.prettifyError(result.error)}`);
  return result.data;
}

export function readSettingsFile(path: string): SettingsFile {
  if (!existsSync(path)) return {};
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`${path} isn't valid JSON: ${(error as Error).message}`);
  }
  return parseSettingsFile(raw, path);
}

// Empty means unset, so a test can clear a variable by setting it to "".
function fromEnv(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name]?.trim();
  return value ? value : undefined;
}

function envPort(env: NodeJS.ProcessEnv): number | undefined {
  const value = fromEnv(env, "CONNECTORS_PORT");
  if (value === undefined) return undefined;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`CONNECTORS_PORT isn't a port: ${value}`);
  return port;
}

function envMode(env: NodeJS.ProcessEnv): Mode | undefined {
  const value = fromEnv(env, "CONNECTORS_MODE");
  if (value === undefined) return undefined;
  if (!(MODES as readonly string[]).includes(value)) throw new Error(`CONNECTORS_MODE must be local or tailscale, not ${value}`);
  return value as Mode;
}

/**
 * The settings in effect: flags over environment over settings.json over
 * defaults. Throws when they don't make sense together, so `serve` stops
 * before it listens.
 */
export function resolveSettings(
  file: SettingsFile,
  env: NodeJS.ProcessEnv = process.env,
  overrides: SettingsOverrides = {},
): Settings {
  const mode = overrides.mode ?? envMode(env) ?? file.mode ?? "local";
  const host = overrides.host ?? fromEnv(env, "CONNECTORS_HOST") ?? file.host ?? DEFAULT_HOST;
  const port = overrides.port ?? envPort(env) ?? file.port ?? DEFAULT_PORT;
  const envLogins = parseLogins(env.CONNECTORS_ADMIN_LOGINS);
  const adminLogins = (overrides.adminLogins ?? (envLogins.length ? envLogins : undefined) ?? file.adminLogins ?? []).map(
    (login) => login.trim().toLowerCase(),
  );
  let publicUrl = overrides.publicUrl ?? fromEnv(env, "CONNECTORS_PUBLIC_URL") ?? file.publicUrl;
  if (mode === "local") {
    // The gateway listens on loopback only, so nothing on the network can
    // reach it, and the admin pages' host check knows what to expect.
    if (!isLoopbackHost(host)) throw new Error(`In local mode the gateway listens on 127.0.0.1 only, not ${host}.`);
    publicUrl ??= `http://127.0.0.1:${port}`;
    if (!isLoopbackHost(new URL(publicUrl).hostname)) {
      throw new Error(`In local mode publicUrl must be a loopback address like http://127.0.0.1:${port}, not ${publicUrl}.`);
    }
  } else if (!publicUrl) {
    throw new Error(
      "In tailscale mode, set publicUrl in settings.json to the address tailscale serve publishes, " +
        "like https://<machine>.<tailnet>.ts.net:8443.",
    );
  }
  const url = new URL(publicUrl);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(`publicUrl must be http or https: ${publicUrl}`);
  return {
    mode,
    host,
    port,
    // Without a trailing slash, so links join cleanly.
    publicUrl: url.origin,
    adminLogins,
    servePort: file.servePort ?? DEFAULT_SERVE_PORT,
    ownerName: overrides.ownerName ?? fromEnv(env, "CONNECTORS_OWNER") ?? file.ownerName ?? DEFAULT_OWNER,
    launchdLabel: file.launchdLabel ?? DEFAULT_LAUNCHD_LABEL,
    gatewayHost: fromEnv(env, "CONNECTORS_GATEWAY_HOST") ?? file.gatewayHost ?? null,
    sentryDsn: fromEnv(env, "CONNECTORS_SENTRY_DSN") ?? file.sentryDsn ?? null,
  };
}

export function loadSettings(path: string, env: NodeJS.ProcessEnv = process.env, overrides: SettingsOverrides = {}): Settings {
  return resolveSettings(readSettingsFile(path), env, overrides);
}

/** Words for agent-facing messages: "Sam" or "the user", and its forms. */
export type Owner = { name: string; Name: string; possessive: string };

export function ownerWords(name: string = DEFAULT_OWNER): Owner {
  const trimmed = name.trim() || DEFAULT_OWNER;
  return {
    name: trimmed,
    Name: trimmed.charAt(0).toUpperCase() + trimmed.slice(1),
    possessive: `${trimmed}'s`,
  };
}
