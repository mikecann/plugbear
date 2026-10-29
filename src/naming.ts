// Exposed tool names are <prefix>__<tool>. Codex and OpenAI function names
// allow only [a-zA-Z0-9_-] and at most 64 characters, so anything else is
// replaced with "_", and a name that is too long (or that collides with
// another after cleaning) is cut short and given a hash of the original.
// The reverse map is how a call finds its way back to the upstream tool.
//
// Grok 1.0.70 names MCP tools <server>__<tool> and drops any tool whose
// full name then has a second "__" (docs/client-compat.md), so an agent can
// ask for the "_" style instead: <prefix>_<tool>, with no "__" anywhere.

import { createHash } from "node:crypto";

export const MAX_TOOL_NAME_LENGTH = 64;
export const SEPARATOR = "__";
export const SEPARATORS = ["__", "_"] as const;
export type Separator = (typeof SEPARATORS)[number];
const HASH_LENGTH = 8;

export function sanitizeToolName(name: string, separator: Separator = SEPARATOR): string {
  const clean = name.replace(/[^a-zA-Z0-9_-]/g, "_");
  return separator === "_" ? clean.replace(/_{2,}/g, "_") : clean;
}

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, HASH_LENGTH);
}

function withHash(base: string, original: string, salt: number, separator: Separator): string {
  const hash = shortHash(salt === 0 ? original : `${original}#${salt}`);
  const room = MAX_TOOL_NAME_LENGTH - HASH_LENGTH - 1;
  let head = base.slice(0, room);
  // "a_" + "_hash" would bring back the "__" this style avoids.
  if (separator === "_") head = head.replace(/_+$/, "");
  return `${head}_${hash}`;
}

/**
 * Names every tool of one upstream. Returns exposed name to original name,
 * in the upstream's order. Prefixes are unique and have no "_", so names
 * from different upstreams can never collide.
 */
export function nameTools(
  prefix: string,
  toolNames: readonly string[],
  separator: Separator = SEPARATOR,
): Map<string, string> {
  const exposed = new Map<string, string>();
  const start = `${prefix}${separator}`;
  for (const original of toolNames) {
    let base = `${start}${sanitizeToolName(original, separator)}`;
    // In the "_" style a tool name that starts with "_" (or with a character
    // that becomes one, like ".hidden") would bring "__" back at the join.
    if (separator === "_") base = base.replace(/_{2,}/g, "_");
    let candidate = base;
    let salt = 0;
    while (
      candidate.length > MAX_TOOL_NAME_LENGTH ||
      exposed.has(candidate) ||
      // Keep a cleaned name from stealing the exact name of a later tool.
      (candidate !== `${start}${original}` && toolNames.includes(candidate.slice(start.length)))
    ) {
      candidate = withHash(base, original, salt, separator);
      salt += 1;
    }
    exposed.set(candidate, original);
  }
  return exposed;
}

/**
 * The name policy rules match against, and the call log and approvals
 * record: prefix plus the upstream's own name, whatever style the agent sees.
 */
export function policyName(prefix: string, original: string): string {
  return `${prefix}${SEPARATOR}${original}`;
}
