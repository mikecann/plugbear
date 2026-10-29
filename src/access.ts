// Which upstreams an agent may use. Each entry in an agent's `upstreams`
// is an upstream id or glob ("*"), "tag:<tag>", or either of those with a
// leading "!" to exclude. An upstream is allowed when at least one positive
// entry matches and no "!" entry does, so the order doesn't matter.

import type { AgentConfig, UpstreamConfig } from "./config.ts";
import { globMatch } from "./glob.ts";

function entryMatches(entry: string, upstream: UpstreamConfig): boolean {
  if (entry.startsWith("tag:")) {
    const tag = entry.slice("tag:".length);
    return upstream.tags.some((candidate) => globMatch(tag, candidate));
  }
  return globMatch(entry, upstream.id);
}

export function agentCanUse(agent: AgentConfig, upstream: UpstreamConfig): boolean {
  let allowed = false;
  for (const entry of agent.upstreams) {
    if (entry.startsWith("!")) {
      if (entryMatches(entry.slice(1), upstream)) return false;
    } else if (entryMatches(entry, upstream)) {
      allowed = true;
    }
  }
  return allowed;
}

export function upstreamsFor(
  agent: AgentConfig,
  upstreams: readonly UpstreamConfig[],
): UpstreamConfig[] {
  return upstreams.filter((upstream) => agentCanUse(agent, upstream));
}
