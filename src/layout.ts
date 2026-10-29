// Where Connectors keeps its files: everything lives under one data folder,
// ~/Library/Application Support/Connectors by default (see docs/plan.md,
// "Where it runs"). Tests and local runs point CONNECTORS_HOME at a temp
// folder.

import { chmodSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export type Layout = {
  root: string;
  secrets: string;
  // Token hashes for each agent.
  agentsSecrets: string;
  // oauth/<upstream>.json: client registration, tokens, PKCE verifier.
  oauthDir: string;
  // clients/<upstream>.json: statically configured OAuth clients.
  clientsDir: string;
  // upstream-tokens/<upstream>: static bearer tokens.
  upstreamTokensDir: string;
  ntfyTopic: string;
  // HMAC key for the admin pages' CSRF tokens.
  csrfKey: string;
  // Local mode: the key behind the admin pages' sign-in cookie.
  adminKey: string;
  state: string;
  db: string;
  // This install's own config, without secrets: settings.json,
  // upstreams.json, agents.json, policy.json. Any of them may be missing.
  configDir: string;
  // The examples that ship with the app (config/<name>.example.json), used
  // for any file configDir doesn't have.
  examplesDir: string;
  settingsFile: string;
};

export function defaultRoot(): string {
  return join(homedir(), "Library", "Application Support", "Connectors");
}

// config/ sits next to src/ in the repo and next to dist/ in a deployed
// app, so the same relative path works for both.
export function defaultExamplesDir(): string {
  return fileURLToPath(new URL("../config/", import.meta.url));
}

export function makeLayout(
  options: { root?: string; configDir?: string; examplesDir?: string } = {},
): Layout {
  const root = options.root ?? (process.env.CONNECTORS_HOME || defaultRoot());
  const secrets = join(root, "secrets");
  const state = join(root, "state");
  const configDir = options.configDir ?? (process.env.CONNECTORS_CONFIG_DIR || join(root, "config"));
  return {
    root,
    secrets,
    agentsSecrets: join(secrets, "agents.json"),
    oauthDir: join(secrets, "oauth"),
    clientsDir: join(secrets, "clients"),
    upstreamTokensDir: join(secrets, "upstream-tokens"),
    ntfyTopic: join(secrets, "ntfy-topic"),
    csrfKey: join(secrets, "csrf-key"),
    adminKey: join(secrets, "admin-key"),
    state,
    db: join(state, "connectors.sqlite"),
    configDir,
    examplesDir: options.examplesDir ?? defaultExamplesDir(),
    settingsFile: join(configDir, "settings.json"),
  };
}

/** Creates the data folders. secrets/ and everything under it is 0700. */
export function ensureLayout(layout: Layout): void {
  mkdirSync(layout.root, { recursive: true, mode: 0o700 });
  for (const dir of [layout.secrets, layout.oauthDir]) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    // mkdir's mode only applies to folders it creates.
    chmodSync(dir, 0o700);
  }
  mkdirSync(layout.state, { recursive: true, mode: 0o700 });
}
