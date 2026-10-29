// What happens to each tools/list and tools/call from an agent: the
// agent's allowlist, the policy (allow, ask, deny), holding "ask" calls for
// the owner's approval, the built-in connectors__* tools, and the call log.
// The owner is whoever approves calls: settings.json's ownerName ("Sam"),
// or "the user".

import { agentCanUse } from "./access.ts";
import {
  ApprovalTooLargeError,
  MAX_PENDING_PER_AGENT,
  type Approvals,
  type ToolResult,
  expiredAfterApproval,
} from "./approvals.ts";
import { type AgentConfig, type Config, BUILTIN_PREFIX } from "./config.ts";
import type { ApprovalRecord, Decision, Store } from "./db.ts";
import { type Logger, errorMessage, silentLogger } from "./log.ts";
import { type Separator, policyName } from "./naming.ts";
import type { Notifier } from "./notify.ts";
import { NeedsSignInError } from "./oauth.ts";
import { type PolicyInput, alwaysDenies, decide, mayAsk } from "./policy.ts";
import { looksLikeBug, reportError } from "./sentry.ts";
import { type Owner, ownerWords } from "./settings.ts";
import { type ExposedTool, type UpstreamConnection, type UpstreamManager, showsSignInStub } from "./upstreams.ts";

// Right after a start, give upstreams up to this long (from the start) to
// connect before answering a tools/list, so agents don't start with an
// empty list. Keep it short: Codex 0.164.0 starts its turn without a
// server's tools when tools/list is slow, and then has none of them for the
// whole session (with a 2.5 s wait it lost them in one of two runs; with
// 1 s it kept them in three of three). Upstreams that come up later reach
// 2026-07-28 clients as list_changed.
export const FIRST_LIST_WAIT_MS = 1_000;
// Tool calls (including held ones) one agent id may have running at once.
// Every Claude thread on one account shares an id, so this is generous; it
// is there to stop a runaway loop from exhausting the gateway's memory.
export const MAX_CALLS_IN_FLIGHT_PER_AGENT = 32;
// Bigger results become an error instead of being copied through: no agent
// can use 10 MB of tool output, and the LaunchAgent caps the heap at 384 MB.
export const MAX_RESULT_BYTES = 10 * 1024 * 1024;

/** connectors__await_approval, or connectors_await_approval for "_" agents. */
export function builtinName(tool: "await_approval" | "status", separator: Separator = "__"): string {
  return `${BUILTIN_PREFIX}${separator}${tool}`;
}

export function instructionsFor(
  agent: Pick<AgentConfig, "toolSeparator">,
  owner: Owner = ownerWords(),
  services: readonly string[] = [],
): string {
  const sep = agent.toolSeparator;
  const list = services.length ? ` (${services.join(", ")})` : "";
  return (
    `Connectors gives you ${owner.possessive} services${list} through one server. ` +
    `Tools are named <service>${sep}<tool>. Some calls, like sending or deleting things, wait for ${owner.name} to approve them: ` +
    `if a call says "Waiting for ${owner.name}", tell ${owner.name}, then call ${builtinName("await_approval", sep)} with the id it gives. ` +
    `Never try to approve a call yourself. A service that isn't signed in has only a <service>${sep}sign_in tool, ` +
    `whose description has the link to give ${owner.name}. Call ${builtinName("status", sep)} to see which services are signed in.`
  );
}

/** The one tool a signed-out upstream lists: gmail__sign_in, or gmail_sign_in for "_" agents. */
export function signInToolName(prefix: string, separator: Separator = "__"): string {
  return `${prefix}${separator}sign_in`;
}

/** What a signed-out upstream's stub tool says, in its description and when called. */
export function signInText(connection: UpstreamConnection, owner: Owner = ownerWords()): string {
  const title = connection.config.title;
  return connection.state === "needs_setup"
    ? `${title} isn't set up yet, so its tools aren't available. Ask ${owner.name} to open ${connection.connectUrl} to finish setting it up, then list tools again.`
    : `${title} is signed out, so its tools aren't available. Ask ${owner.name} to open ${connection.connectUrl} and sign in, then list tools again.`;
}

function signInTool(connection: UpstreamConnection, separator: Separator, owner: Owner): ExposedTool {
  return {
    name: signInToolName(connection.config.prefix, separator),
    title: `Sign in to ${connection.config.title}`,
    description: signInText(connection, owner),
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
  };
}

function builtinTools(separator: Separator, owner: Owner): ExposedTool[] {
  return [
    {
      name: builtinName("await_approval", separator),
      title: `Wait for ${owner.possessive} approval`,
      description:
        `Waits up to 45 seconds for ${owner.name} to approve or decline a held call. If it was approved, runs it and returns its result. ` +
        `Pass the id from the "Waiting for ${owner.name}" message.`,
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string", description: "The approval id, which starts with ap_" },
        },
        required: ["id"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    {
      name: builtinName("status", separator),
      title: "Connectors status",
      description:
        `Lists the services you can use through Connectors and whether each one is signed in, so you can tell ${owner.name} what to connect.`,
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
  ];
}

export type CallContext = {
  agent: AgentConfig;
  tailscaleLogin: string | null;
  signal?: AbortSignal;
};

export type GatewayDeps = {
  config: Config;
  manager: UpstreamManager;
  approvals: Approvals;
  store: Store;
  notify: Notifier;
  publicUrl: string;
  // Who approves calls, as agents should call them (default "the user").
  ownerName?: string;
  holdMs: number;
  log?: Logger;
  // Tests lower this; see MAX_CALLS_IN_FLIGHT_PER_AGENT.
  maxCallsInFlightPerAgent?: number;
};

function withoutOutputSchema(tool: ExposedTool): ExposedTool {
  const { outputSchema: _outputSchema, ...rest } = tool;
  return rest;
}

function textResult(text: string, isError = false): ToolResult {
  return { content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) };
}

function resultBytes(result: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(result));
  } catch {
    return 0;
  }
}

/**
 * Whether the arguments have a "__proto__" key anywhere. JSON keeps it as an
 * ordinary key, but a JavaScript upstream that merges it into an object
 * changes that object's prototype, so a value the owner never saw could ride
 * along. No real tool needs one, so such calls are refused.
 */
export function hasProtoKey(value: unknown): boolean {
  const stack: unknown[] = [value];
  while (stack.length) {
    const item = stack.pop();
    if (!item || typeof item !== "object") continue;
    if (Array.isArray(item)) {
      // One at a time: spreading a huge array into push() would overflow.
      for (const element of item) stack.push(element);
      continue;
    }
    for (const key of Object.keys(item)) {
      if (key === "__proto__") return true;
      stack.push((item as Record<string, unknown>)[key]);
    }
  }
  return false;
}

export class Gateway {
  private readonly deps: GatewayDeps;
  private readonly log: Logger;
  private readonly inFlight = new Map<string, number>();
  private readonly idleWaiters = new Set<() => void>();

  constructor(deps: GatewayDeps) {
    this.deps = deps;
    this.log = deps.log ?? silentLogger;
  }

  /** Tool calls running now, across all agents. */
  callsInFlight(): number {
    let total = 0;
    for (const count of this.inFlight.values()) total += count;
    return total;
  }

  /** Waits until no tool call is running, or the time is up. */
  async drain(timeoutMs: number): Promise<void> {
    if (this.callsInFlight() === 0) return;
    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.idleWaiters.delete(done);
        resolve();
      };
      const timer = setTimeout(done, timeoutMs);
      this.idleWaiters.add(done);
    });
  }

  get owner(): Owner {
    return ownerWords(this.deps.ownerName);
  }

  private approvedButExpired(): string {
    return `${this.owner.Name} approved this call, but it wasn't picked up within an hour, so it didn't run. Make the call again if it's still needed.`;
  }

  /** Titles of the services an agent can use, for the server instructions. */
  serviceTitles(agent: AgentConfig): string[] {
    return this.deps.manager
      .forAgent(agent)
      .filter((connection) => connection.state !== "disabled")
      .map((connection) => connection.config.title);
  }

  adminUrl(): string {
    return new URL("/admin", this.deps.publicUrl).toString();
  }

  approvalUrl(id: string): string {
    return new URL(`/approvals/${encodeURIComponent(id)}`, this.deps.publicUrl).toString();
  }

  agent(id: string): AgentConfig | undefined {
    return this.deps.config.agents.find((agent) => agent.id === id);
  }

  async listTools(agent: AgentConfig): Promise<ExposedTool[]> {
    await this.deps.manager.whenSettled(FIRST_LIST_WAIT_MS);
    const separator = agent.toolSeparator;
    const tools = builtinTools(separator, this.owner);
    for (const connection of this.deps.manager.forAgent(agent)) {
      // A signed-out service still shows up, so an agent looking for it
      // finds out what to ask for instead of finding nothing.
      if (showsSignInStub(connection.state)) tools.push(signInTool(connection, separator, this.owner));
      if (connection.state !== "ready") continue;
      for (const tool of this.visibleTools(agent, connection)) {
        tools.push(this.mayBeHeld(agent, connection, tool) ? withoutOutputSchema(tool) : tool);
      }
    }
    this.log.info(`tools/list agent=${agent.id} tools=${tools.length}`);
    return tools;
  }

  /**
   * A connection's tools in the agent's naming, minus the ones the policy
   * always refuses for it. Every listed tool costs the agent's model context
   * and is one more to choose from, so a refused tool isn't worth listing.
   * Calling one by name is still refused in dispatch.
   */
  private visibleTools(agent: AgentConfig, connection: UpstreamConnection): ExposedTool[] {
    return connection
      .toolsFor(agent.toolSeparator)
      .filter((tool) => !alwaysDenies(this.deps.config.policy, this.policyTarget(agent, connection, tool)));
  }

  /** Who and what a policy rule is matched against for this tool. */
  private policyTarget(agent: AgentConfig, connection: UpstreamConnection, tool: ExposedTool): Omit<PolicyInput, "args"> {
    const original = connection.originalName(tool.name, agent.toolSeparator) ?? tool.name;
    return {
      agentId: agent.id,
      upstreamId: connection.id,
      toolName: policyName(connection.config.prefix, original),
    };
  }

  /**
   * Whether the policy could hold this tool for this agent. A held call
   * answers "Waiting for <owner>" with no structured content, which Claude Code
   * and the MCP SDK clients reject for a tool that declared an outputSchema,
   * so such tools are listed without one. Their results still carry
   * structuredContent.
   */
  private mayBeHeld(agent: AgentConfig, connection: UpstreamConnection, tool: ExposedTool): boolean {
    if (!tool.outputSchema) return false;
    return mayAsk(this.deps.config.policy, this.policyTarget(agent, connection, tool));
  }

  async callTool(ctx: CallContext, name: string, rawArgs: unknown): Promise<ToolResult> {
    const separator = ctx.agent.toolSeparator;
    if (name === builtinName("status", separator)) return this.status(ctx);
    const running = this.inFlight.get(ctx.agent.id) ?? 0;
    if (running >= (this.deps.maxCallsInFlightPerAgent ?? MAX_CALLS_IN_FLIGHT_PER_AGENT)) {
      this.log.warn(`call ${ctx.agent.id} ${name} refused: ${running} calls already running`);
      return textResult(
        `You have ${running} Connectors calls running at once, which is the limit. Wait for some to finish, then try again.`,
        true,
      );
    }
    this.inFlight.set(ctx.agent.id, running + 1);
    try {
      return await this.dispatch(ctx, name, rawArgs);
    } finally {
      const left = (this.inFlight.get(ctx.agent.id) ?? 1) - 1;
      if (left > 0) this.inFlight.set(ctx.agent.id, left);
      else this.inFlight.delete(ctx.agent.id);
      if (this.inFlight.size === 0) for (const done of [...this.idleWaiters]) done();
    }
  }

  private async dispatch(ctx: CallContext, name: string, rawArgs: unknown): Promise<ToolResult> {
    const args =
      rawArgs && typeof rawArgs === "object" && !Array.isArray(rawArgs)
        ? (rawArgs as Record<string, unknown>)
        : {};
    const separator = ctx.agent.toolSeparator;
    if (name === builtinName("await_approval", separator)) return this.awaitApproval(ctx, args);

    const resolved = this.deps.manager.resolve(name, separator);
    if (!resolved) {
      const stub = this.signInStub(ctx, name);
      if (stub) return stub;
    }
    if (!resolved || !agentCanUse(ctx.agent, resolved.connection.config)) {
      this.deps.store.logCall({
        agent: ctx.agent.id,
        tailscaleLogin: ctx.tailscaleLogin,
        tool: name,
        args,
        decision: "deny",
        ok: false,
        error: "Unknown tool",
      });
      return textResult(
        `Unknown tool: ${name}. Call tools/list (or ${builtinName("status", separator)}) to see what's available.`,
        true,
      );
    }
    const { connection, original } = resolved;
    // Policy, the call log, approvals and pushes all use <prefix>__<tool>
    // with the upstream's own tool name, whatever style this agent sees.
    const canonical = policyName(connection.config.prefix, original);
    if (hasProtoKey(args)) {
      this.deps.store.logCall({
        agent: ctx.agent.id,
        tailscaleLogin: ctx.tailscaleLogin,
        upstream: connection.id,
        tool: canonical,
        args,
        decision: "deny",
        ok: false,
        error: "Arguments with a __proto__ key are refused",
      });
      this.log.warn(`call ${ctx.agent.id} ${canonical} refused: __proto__ in the arguments`);
      return textResult(`Connectors refuses arguments with a "__proto__" key. Send the call without it.`, true);
    }
    const decision = decide(this.deps.config.policy, {
      agentId: ctx.agent.id,
      upstreamId: connection.id,
      toolName: canonical,
      args,
    });

    if (decision.action === "deny") {
      this.deps.store.logCall({
        agent: ctx.agent.id,
        tailscaleLogin: ctx.tailscaleLogin,
        upstream: connection.id,
        tool: canonical,
        args,
        decision: "deny",
        ok: false,
        error: "Blocked by policy",
      });
      this.log.info(`call ${ctx.agent.id} ${canonical} denied by policy`);
      return textResult(`Connectors policy doesn't allow ${name}. Ask ${this.owner.name} if you need it.`, true);
    }

    if (decision.action === "allow") {
      return this.run(ctx, connection, canonical, original, args, "allow", null, ctx.signal);
    }

    // ask. Don't ask the owner about a call that can't run anyway.
    if (showsSignInStub(connection.state)) {
      this.log.info(`call ${ctx.agent.id} ${canonical} not held: ${connection.id} needs sign-in`);
      return this.needsSignIn(connection);
    }
    const waiting = this.deps.approvals.pendingFor(ctx.agent.id);
    if (waiting >= MAX_PENDING_PER_AGENT) {
      this.log.warn(`call ${ctx.agent.id} ${canonical} refused: ${waiting} calls already waiting for approval`);
      return textResult(
        `${waiting} of your calls are already waiting for ${this.owner.name}, which is the limit. ` +
          `Ask ${this.owner.name} to answer those at ${this.adminUrl()} before you make more.`,
        true,
      );
    }
    let approval: ApprovalRecord;
    try {
      approval = this.deps.approvals.create({
        agent: ctx.agent.id,
        upstream: connection.id,
        tool: canonical,
        upstreamTool: original,
        args,
        tailscaleLogin: ctx.tailscaleLogin,
      });
    } catch (error) {
      if (error instanceof ApprovalTooLargeError) return textResult(error.message, true);
      throw error;
    }
    void this.deps.notify({
      title: `${ctx.agent.title} wants to run ${canonical}`,
      clickUrl: this.approvalUrl(approval.id),
    });
    const current = await this.deps.approvals.wait(approval.id, this.deps.holdMs, ctx.signal);
    return this.settle(ctx, current ?? approval);
  }

  private async awaitApproval(ctx: CallContext, args: Record<string, unknown>): Promise<ToolResult> {
    const id = typeof args.id === "string" ? args.id.trim() : "";
    if (!id) return textResult("Pass the approval id, which starts with ap_.", true);
    const record = this.deps.approvals.get(id);
    if (!record) return textResult(`There's no approval with id ${id}.`, true);
    if (record.agent !== ctx.agent.id) {
      return textResult("That approval belongs to another agent, so you can't wait on it or run it.", true);
    }
    const current =
      record.status === "pending"
        ? await this.deps.approvals.wait(id, this.deps.holdMs, ctx.signal)
        : record;
    return this.settle(ctx, current ?? record);
  }

  /** Turns an approval's state into what the agent sees. */
  private async settle(ctx: CallContext, record: ApprovalRecord): Promise<ToolResult> {
    switch (record.status) {
      case "pending":
        return textResult(
          `Waiting for ${this.owner.name} to approve this at ${this.approvalUrl(record.id)}. ` +
            `Tell ${this.owner.name}, then call ${builtinName("await_approval", ctx.agent.toolSeparator)} with id ${record.id}. ` +
            "Don't try to approve it yourself.",
        );
      case "declined":
        return textResult(
          `${this.owner.Name} declined this call.${record.note ? ` ${this.owner.Name}'s note: ${record.note}` : ""}`,
          true,
        );
      case "expired":
        return textResult(
          expiredAfterApproval(record)
            ? this.approvedButExpired()
            : `This call expired before ${this.owner.name} approved it, so it didn't run. Ask ${this.owner.name} again if it's still needed.`,
          true,
        );
      case "approved":
      case "ran": {
        const connection = this.deps.manager.get(record.upstream);
        if (!connection || !agentCanUse(ctx.agent, connection.config)) {
          return textResult(`${record.upstream} isn't available to you any more, so the call didn't run.`, true);
        }
        const outcome = await this.deps.approvals.runApproved(record, (args) =>
          // An approved call runs to the end even if the agent hangs up.
          this.run(ctx, connection, record.tool, record.upstreamTool, args, "approved", record.id),
        );
        if (outcome.kind === "result") return outcome.result;
        if (outcome.kind === "expired") {
          return textResult(this.approvedButExpired(), true);
        }
        const when = outcome.ranAt ? new Date(outcome.ranAt).toISOString() : "an earlier time";
        return textResult(`This call already ran at ${when}. Its result is no longer available.`);
      }
    }
  }

  private async run(
    ctx: CallContext,
    connection: UpstreamConnection,
    name: string,
    original: string,
    args: Record<string, unknown>,
    decision: Extract<Decision, "allow" | "approved">,
    approvalId: string | null,
    signal?: AbortSignal,
  ): Promise<ToolResult> {
    const started = Date.now();
    try {
      const upstreamResult = await connection.callTool(original, args, { signal });
      const bytes = resultBytes(upstreamResult);
      const tooBig = bytes > MAX_RESULT_BYTES;
      const result = tooBig
        ? textResult(
            `${connection.config.title} returned ${Math.round(bytes / 1024 / 1024)} MB, over Connectors' ` +
              `${MAX_RESULT_BYTES / 1024 / 1024} MB limit for one result. Ask for less, for example with a filter or a page size.`,
            true,
          )
        : upstreamResult;
      const ok = result.isError !== true;
      this.deps.store.logCall({
        ts: started,
        agent: ctx.agent.id,
        tailscaleLogin: ctx.tailscaleLogin,
        upstream: connection.id,
        tool: name,
        args,
        decision,
        approvalId,
        durationMs: Date.now() - started,
        ok,
        error: tooBig ? `Result too large (${bytes} bytes)` : ok ? null : "The tool returned an error",
        resultBytes: bytes,
      });
      this.log.info(`call ${ctx.agent.id} ${name} ${decision} ok=${ok} ${Date.now() - started}ms`);
      return result;
    } catch (error) {
      const message = errorMessage(error);
      this.deps.store.logCall({
        ts: started,
        agent: ctx.agent.id,
        tailscaleLogin: ctx.tailscaleLogin,
        upstream: connection.id,
        tool: name,
        args,
        decision,
        approvalId,
        durationMs: Date.now() - started,
        ok: false,
        error: message,
      });
      this.log.warn(`call ${ctx.agent.id} ${name} failed: ${message}`);
      // Upstream failures are expected and show on the admin page; a
      // TypeError and the like is ours. The error only, never args or result.
      if (looksLikeBug(error)) reportError(error, "tool-call", { upstream: connection.id });
      if (error instanceof NeedsSignInError) return this.needsSignIn(connection);
      return textResult(`${connection.config.title} failed: ${message}`, true);
    }
  }

  private needsSignIn(connection: UpstreamConnection): ToolResult {
    return textResult(
      `${connection.config.title} needs signing in again. Ask ${this.owner.name} to open ${connection.connectUrl} and sign in.`,
      true,
    );
  }

  /** A call to <prefix>__sign_in, the stub a signed-out upstream lists. */
  private signInStub(ctx: CallContext, name: string): ToolResult | undefined {
    const connection = this.deps.manager
      .forAgent(ctx.agent)
      .find((candidate) => signInToolName(candidate.config.prefix, ctx.agent.toolSeparator) === name);
    if (!connection) return undefined;
    this.deps.store.logCall({
      agent: ctx.agent.id,
      tailscaleLogin: ctx.tailscaleLogin,
      upstream: connection.id,
      tool: policyName(connection.config.prefix, "sign_in"),
      args: {},
      decision: "allow",
      ok: !showsSignInStub(connection.state),
      error: showsSignInStub(connection.state) ? "Not signed in" : null,
    });
    if (showsSignInStub(connection.state)) return textResult(signInText(connection, this.owner));
    if (connection.state === "ready") {
      return textResult(`${connection.config.title} is signed in now. List tools again to see its tools.`);
    }
    return textResult(`${connection.config.title} isn't reachable right now. Call ${builtinName("status", ctx.agent.toolSeparator)} for details.`, true);
  }

  private status(ctx: CallContext): ToolResult {
    const lines = this.deps.manager.forAgent(ctx.agent).map((connection) => {
      const label = `${connection.config.title} (tools start with ${connection.config.prefix}${ctx.agent.toolSeparator})`;
      switch (connection.state) {
        case "ready":
          return `- ${label}: signed in, ${this.visibleTools(ctx.agent, connection).length} tools`;
        case "needs_sign_in":
          return `- ${label}: needs sign-in. Ask ${this.owner.name} to open ${connection.connectUrl}`;
        case "needs_setup":
          return `- ${label}: not set up yet. Ask ${this.owner.name} to open ${connection.connectUrl}`;
        case "connecting":
        case "idle":
          return `- ${label}: connecting`;
        case "disabled":
          return `- ${label}: turned off`;
        case "error":
          return `- ${label}: not reachable (${connection.lastError ?? "unknown error"})`;
      }
    });
    const pending = this.deps.approvals.pending().filter((record) => record.agent === ctx.agent.id);
    const text = [
      `You are ${ctx.agent.title} (${ctx.agent.id}).`,
      lines.length ? "Services:" : "No services are set up for you yet.",
      ...lines,
      ...(pending.length
        ? ["", `Calls waiting for ${this.owner.name}:`, ...pending.map((record) => `- ${record.tool}: ${record.id}`)]
        : []),
    ].join("\n");
    return textResult(text);
  }
}
