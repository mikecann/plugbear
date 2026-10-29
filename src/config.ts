// Loads and checks upstreams.json, agents.json and policy.json. Each comes
// from the install's own config folder if it has one, otherwise from the
// example that ships with the app (config/<name>.example.json). These files
// hold no secrets: tokens and OAuth data live in secrets/.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { z } from "zod";

import { SEPARATORS } from "./naming.ts";
import { isLoopbackHost } from "./settings.ts";

export const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;
export const PREFIX_PATTERN = /^[a-z0-9]{1,10}$/;
// Built-in tools use this prefix, so no upstream may.
export const BUILTIN_PREFIX = "connectors";

const idSchema = z
  .string()
  .regex(ID_PATTERN, "use 1 to 32 lowercase letters, digits or dashes");

// Env values for stdio servers: plain strings for non-secret settings, or a
// file under secrets/ for anything secret. Never inline a secret here.
const envValueSchema = z.union([
  z.string(),
  z.strictObject({ secretFile: z.string().min(1) }),
]);

const upstreamCommon = {
  id: idSchema,
  title: z.string().min(1).max(80),
  prefix: z
    .string()
    .regex(PREFIX_PATTERN, "use 1 to 10 lowercase letters or digits"),
  enabled: z.boolean().default(true),
  tags: z.array(z.string().regex(/^[a-z0-9-]{1,32}$/)).default([]),
  timeoutMs: z.number().int().min(1000).max(15 * 60_000).optional(),
};

const httpAuthSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("none") }),
  z.strictObject({ type: z.literal("bearer") }),
  z.strictObject({
    type: z.literal("oauth"),
    // "static" reads secrets/clients/<id>.json instead of registering.
    client: z.enum(["static", "dynamic"]).optional(),
  }),
]);

const httpUpstreamSchema = z.strictObject({
  ...upstreamCommon,
  type: z.literal("http"),
  url: z.url(),
  auth: httpAuthSchema,
  scopes: z.array(z.string().min(1)).optional(),
});

const stdioUpstreamSchema = z.strictObject({
  ...upstreamCommon,
  type: z.literal("stdio"),
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  env: z.record(z.string(), envValueSchema).default({}),
  cwd: z.string().optional(),
});

// Gmail or Google Calendar through the built-in stdio server
// (src/google/server.ts), signed in with the user's own Google OAuth client.
// Upstreams with the same account share one sign-in: the client is in
// secrets/clients/<account>.json and the tokens in secrets/oauth/<account>.json.
const googleUpstreamSchema = z.strictObject({
  ...upstreamCommon,
  type: z.literal("google"),
  service: z.enum(["gmail", "calendar"]),
  account: idSchema.default("google"),
});

export const upstreamSchema = z.discriminatedUnion("type", [
  httpUpstreamSchema,
  stdioUpstreamSchema,
  googleUpstreamSchema,
]);

export type UpstreamConfig = z.infer<typeof upstreamSchema>;
export type HttpUpstreamConfig = z.infer<typeof httpUpstreamSchema>;
export type StdioUpstreamConfig = z.infer<typeof stdioUpstreamSchema>;
export type GoogleUpstreamConfig = z.infer<typeof googleUpstreamSchema>;

// The MCP clients scripts/install-clients.sh knows how to wire.
export const CLIENT_TYPES = ["claude", "codex", "grok", "muse"] as const;

export const agentSchema = z.strictObject({
  id: idSchema,
  title: z.string().min(1).max(80),
  // Upstream ids or globs, "tag:<tag>", and "!..." to exclude.
  upstreams: z.array(z.string().min(1)).default([]),
  // "__" gives <prefix>__<tool>. "_" gives <prefix>_<tool> for clients
  // that refuse a second "__" in a tool name (Grok).
  toolSeparator: z.enum(SEPARATORS).default("__"),
  // Which client on the agents' Mac uses this agent's token, for
  // install-clients.sh. The gateway itself ignores it. configDir is the
  // client's config folder (CLAUDE_CONFIG_DIR, CODEX_HOME, GROK_HOME or
  // Muse's settings folder) when it isn't the default; "~/" is the home
  // folder of whoever runs install-clients.sh.
  client: z
    .strictObject({
      type: z.enum(CLIENT_TYPES),
      configDir: z.string().min(1).optional(),
    })
    .optional(),
});

export type AgentConfig = z.infer<typeof agentSchema>;

const actionSchema = z.enum(["allow", "ask", "deny"]);
export type PolicyAction = z.infer<typeof actionSchema>;

export const policyRuleSchema = z.strictObject({
  tool: z.string().min(1),
  action: actionSchema,
  agents: z.array(z.string().min(1)).optional(),
  upstreams: z.array(z.string().min(1)).optional(),
  ifArgs: z.array(z.string().min(1)).optional(),
});

export type PolicyRule = z.infer<typeof policyRuleSchema>;

export const policySchema = z.strictObject({
  default: actionSchema.default("allow"),
  rules: z.array(policyRuleSchema).default([]),
});

export type Policy = z.infer<typeof policySchema>;

export type Config = {
  upstreams: UpstreamConfig[];
  agents: AgentConfig[];
  policy: Policy;
};

export type ConfigOptions = {
  // Lets tests use http://127.0.0.1 upstreams. Never set in production.
  allowLoopbackHttp?: boolean;
};

function fail(file: string, error: z.ZodError | string): never {
  const detail =
    typeof error === "string" ? error : z.prettifyError(error);
  throw new Error(`${file} is not valid:\n${detail}`);
}

export function parseUpstreams(
  raw: unknown,
  options: ConfigOptions = {},
  file = "upstreams.json",
): UpstreamConfig[] {
  const result = z.array(upstreamSchema).safeParse(raw);
  if (!result.success) fail(file, result.error);
  const upstreams = result.data;
  const ids = new Set<string>();
  const prefixes = new Set<string>();
  for (const upstream of upstreams) {
    if (ids.has(upstream.id)) fail(file, `Two upstreams use the id "${upstream.id}".`);
    ids.add(upstream.id);
    if (upstream.prefix === BUILTIN_PREFIX) {
      fail(file, `The prefix "${BUILTIN_PREFIX}" is kept for built-in tools.`);
    }
    if (prefixes.has(upstream.prefix)) {
      fail(file, `Two upstreams use the prefix "${upstream.prefix}".`);
    }
    prefixes.add(upstream.prefix);
    if (upstream.type === "http") {
      const url = new URL(upstream.url);
      const loopbackOk =
        options.allowLoopbackHttp &&
        url.protocol === "http:" &&
        isLoopbackHost(url.hostname);
      if (url.protocol !== "https:" && !loopbackOk) {
        fail(file, `${upstream.id}: upstream URLs must use https.`);
      }
      if (url.username || url.password) {
        fail(file, `${upstream.id}: put credentials in secrets/, not in the URL.`);
      }
    }
  }
  // A Google account's files are secrets/oauth/<account>.json and
  // secrets/clients/<account>.json, so it can't share an id with an
  // upstream that keeps its own files there.
  for (const upstream of upstreams) {
    if (upstream.type !== "google") continue;
    const clash = upstreams.find((other) => other.type !== "google" && other.id === upstream.account);
    if (clash) fail(file, `${upstream.id}: the Google account "${upstream.account}" has the same id as another upstream.`);
  }
  return upstreams;
}

export function parseAgents(raw: unknown, file = "agents.json"): AgentConfig[] {
  const result = z.array(agentSchema).safeParse(raw);
  if (!result.success) fail(file, result.error);
  const ids = new Set<string>();
  for (const agent of result.data) {
    if (ids.has(agent.id)) fail(file, `Two agents use the id "${agent.id}".`);
    ids.add(agent.id);
  }
  return result.data;
}

export function parsePolicy(raw: unknown, file = "policy.json"): Policy {
  const result = policySchema.safeParse(raw);
  if (!result.success) fail(file, result.error);
  return result.data;
}

function readJson(path: string): unknown {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    throw new Error(`Can't read ${path}: ${(error as Error).message}`);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${path} isn't valid JSON: ${(error as Error).message}`);
  }
}

export type ConfigDirs = { configDir: string; examplesDir: string };
export const CONFIG_FILES = ["upstreams", "agents", "policy"] as const;
export type ConfigName = (typeof CONFIG_FILES)[number];

/** The install's own <name>.json if it exists, else the shipped example. */
export function configFile(dirs: ConfigDirs, name: ConfigName): string {
  const own = join(dirs.configDir, `${name}.json`);
  return existsSync(own) ? own : join(dirs.examplesDir, `${name}.example.json`);
}

export function loadConfig(
  dirs: ConfigDirs,
  options: ConfigOptions = {},
): Config {
  const upstreamsFile = configFile(dirs, "upstreams");
  const agentsFile = configFile(dirs, "agents");
  const policyFile = configFile(dirs, "policy");
  return {
    upstreams: parseUpstreams(readJson(upstreamsFile), options, upstreamsFile),
    agents: parseAgents(readJson(agentsFile), agentsFile),
    policy: parsePolicy(readJson(policyFile), policyFile),
  };
}
