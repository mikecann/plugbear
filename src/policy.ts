// Policy rules: ordered, first match wins, then the default. A rule matches
// the tool's <prefix>__<upstream tool name>, optionally only for some
// agents or upstreams, and optionally only when one of `ifArgs` is set.

import type { Policy, PolicyAction, PolicyRule } from "./config.ts";
import { globMatch } from "./glob.ts";

export type PolicyInput = {
  agentId: string;
  upstreamId: string;
  // <prefix>__<original tool name>
  toolName: string;
  args: Record<string, unknown>;
};

export type PolicyDecision = {
  action: PolicyAction;
  // Index into policy.rules, or null when the default applied.
  ruleIndex: number | null;
};

export function isNonEmpty(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return true;
}

/** Whether a rule is about this tool, agent and upstream, before ifArgs. */
function ruleTargets(rule: PolicyRule, input: Omit<PolicyInput, "args">): boolean {
  if (!globMatch(rule.tool, input.toolName)) return false;
  if (rule.agents && !rule.agents.some((glob) => globMatch(glob, input.agentId))) {
    return false;
  }
  if (
    rule.upstreams &&
    !rule.upstreams.some((glob) => globMatch(glob, input.upstreamId))
  ) {
    return false;
  }
  return true;
}

export function ruleMatches(rule: PolicyRule, input: PolicyInput): boolean {
  if (!ruleTargets(rule, input)) return false;
  if (rule.ifArgs && !rule.ifArgs.some((name) => isNonEmpty(input.args[name]))) {
    return false;
  }
  return true;
}

/**
 * Whether some arguments could make this tool "ask". A rule with ifArgs
 * might or might not apply, so an ask rule with ifArgs counts, and one with
 * another action is passed over.
 */
export function mayAsk(policy: Policy, input: Omit<PolicyInput, "args">): boolean {
  for (const rule of policy.rules) {
    if (!ruleTargets(rule, input)) continue;
    if (rule.ifArgs) {
      if (rule.action === "ask") return true;
      continue;
    }
    return rule.action === "ask";
  }
  return policy.default === "ask";
}

export function decide(policy: Policy, input: PolicyInput): PolicyDecision {
  for (const [index, rule] of policy.rules.entries()) {
    if (ruleMatches(rule, input)) return { action: rule.action, ruleIndex: index };
  }
  return { action: policy.default, ruleIndex: null };
}
