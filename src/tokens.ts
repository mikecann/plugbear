// Per-agent bearer tokens: cn_<agentId>_<64 hex>. Only a SHA-256 of each
// token is stored, in secrets/agents.json (0600). The CLI prints a new
// token once; nothing else ever prints or logs one.

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";

import { ID_PATTERN } from "./config.ts";
import { writeSecretFile } from "./secretFiles.ts";

const TOKEN_PATTERN = /^cn_([a-z0-9][a-z0-9-]{0,31})_([0-9a-f]{64})$/;

export type AgentSecret = {
  sha256: string;
  createdAt: string;
  rotatedAt?: string;
};

export type AgentSecrets = {
  version: 1;
  agents: Record<string, AgentSecret>;
};

export function generateToken(agentId: string): string {
  if (!ID_PATTERN.test(agentId)) throw new Error(`Bad agent id: ${agentId}`);
  return `cn_${agentId}_${randomBytes(32).toString("hex")}`;
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function parseToken(token: string): { agentId: string } | null {
  const match = TOKEN_PATTERN.exec(token);
  return match ? { agentId: match[1]! } : null;
}

export function readAgentSecrets(path: string): AgentSecrets {
  if (!existsSync(path)) return { version: 1, agents: {} };
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<AgentSecrets>;
  return { version: 1, agents: parsed.agents ?? {} };
}

export function writeAgentSecrets(path: string, secrets: AgentSecrets): void {
  writeSecretFile(path, `${JSON.stringify(secrets, null, 2)}\n`);
}

/**
 * Makes a token for an agent and stores its hash. With `rotate`, replaces
 * the agent's existing token (which stops working at once); without it, an
 * existing token is an error.
 */
export function issueToken(
  path: string,
  agentId: string,
  options: { rotate: boolean; now?: Date },
): string {
  const secrets = readAgentSecrets(path);
  const existing = secrets.agents[agentId];
  const now = (options.now ?? new Date()).toISOString();
  if (existing && !options.rotate) {
    throw new TokenExistsError(agentId);
  }
  if (!existing && options.rotate) {
    throw new Error(
      `${agentId} has no token yet. Use "connectors agent add ${agentId}".`,
    );
  }
  const token = generateToken(agentId);
  secrets.agents[agentId] = existing
    ? { ...existing, sha256: hashToken(token), rotatedAt: now }
    : { sha256: hashToken(token), createdAt: now };
  writeAgentSecrets(path, secrets);
  return token;
}

export function removeToken(path: string, agentId: string): boolean {
  const secrets = readAgentSecrets(path);
  if (!secrets.agents[agentId]) return false;
  delete secrets.agents[agentId];
  writeAgentSecrets(path, secrets);
  return true;
}

export class TokenExistsError extends Error {
  constructor(agentId: string) {
    super(
      `${agentId} already has a token. Use "connectors agent rotate ${agentId}" to replace it.`,
    );
    this.name = "TokenExistsError";
  }
}

/** Returns the agent id for a valid token, or null. */
export function verifyToken(secrets: AgentSecrets, token: string): string | null {
  const parsed = parseToken(token);
  if (!parsed) return null;
  const stored = secrets.agents[parsed.agentId];
  if (!stored || !/^[0-9a-f]{64}$/.test(stored.sha256)) return null;
  const expected = Buffer.from(stored.sha256, "hex");
  const actual = Buffer.from(hashToken(token), "hex");
  return timingSafeEqual(expected, actual) ? parsed.agentId : null;
}

/**
 * Reads secrets/agents.json again whenever it changes on disk, so
 * `connectors agent add` takes effect without a restart.
 */
export class TokenStore {
  private secrets: AgentSecrets = { version: 1, agents: {} };
  private stamp = "";
  private readonly path: string;

  constructor(path: string) {
    this.path = path;
  }

  current(): AgentSecrets {
    let stamp = "missing";
    try {
      const stat = statSync(this.path);
      stamp = `${stat.mtimeMs}:${stat.size}:${stat.ino}`;
    } catch {
      // No file yet means no agents.
    }
    if (stamp !== this.stamp) {
      this.secrets = readAgentSecrets(this.path);
      this.stamp = stamp;
    }
    return this.secrets;
  }

  verify(token: string): string | null {
    return verifyToken(this.current(), token);
  }

  has(agentId: string): boolean {
    return Boolean(this.current().agents[agentId]);
  }
}
