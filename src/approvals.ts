// "Ask first": a held call becomes a pending approval. The owner approves
// or declines it on /approvals/<id>; the held call (or a later
// connectors__await_approval from the same agent) then runs it exactly once.
//
// States: pending -> approved -> ran, pending -> declined, pending -> expired,
// and approved -> expired when no agent picks an approved call up within an
// hour (so an old approval can't be replayed days later). The approved ->
// ran step is a single conditional UPDATE, so only one caller can ever run a
// call, and a crash mid-run leaves it "ran" rather than running it twice.

import { randomBytes } from "node:crypto";

import type { ApprovalRecord, Store } from "./db.ts";
import { type Logger, silentLogger } from "./log.ts";

export const HOLD_MS = 45_000;
export const APPROVAL_TTL_MS = 24 * 60 * 60 * 1000;
// Once the owner approves, the agent has this long to pick the call up.
export const APPROVED_RUN_WINDOW_MS = 60 * 60 * 1000;
// More than this many calls from one agent waiting for approval is a loop, not work.
export const MAX_PENDING_PER_AGENT = 20;
// Arguments are kept in full until the call runs; refuse to hold huge ones.
export const MAX_APPROVAL_ARGS_BYTES = 1024 * 1024;
// How long a finished run's result stays available to a repeated await.
const RESULT_TTL_MS = 10 * 60 * 1000;

export type ToolResult = {
  content: unknown[];
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
  [key: string]: unknown;
};

export type NewApproval = {
  agent: string;
  upstream: string;
  tool: string;
  upstreamTool: string;
  args: Record<string, unknown>;
  tailscaleLogin?: string | null;
};

export type RunOutcome =
  | { kind: "result"; result: ToolResult }
  | { kind: "already_ran"; ranAt: number | null }
  | { kind: "expired" };

export class ApprovalTooLargeError extends Error {}

/** An expired approval the owner had approved, which no agent ran in time. */
export function expiredAfterApproval(record: ApprovalRecord): boolean {
  // Expiring a pending approval sets decidedAt to the expiry time; an
  // approved one keeps the time it was approved, before its deadline.
  return record.status === "expired" && record.decidedAt !== null && record.decidedAt < record.expiresAt;
}

export function newApprovalId(): string {
  return `ap_${randomBytes(12).toString("base64url")}`;
}

export class Approvals {
  private readonly store: Store;
  private readonly now: () => number;
  private readonly log: Logger;
  private readonly waiters = new Map<string, Set<() => void>>();
  private readonly runs = new Map<string, Promise<ToolResult>>();
  // Set while the server shuts down: holds end at once.
  private released = false;

  constructor(store: Store, options: { now?: () => number; log?: Logger } = {}) {
    this.store = store;
    this.now = options.now ?? Date.now;
    this.log = options.log ?? silentLogger;
  }

  create(input: NewApproval): ApprovalRecord {
    const argsJson = JSON.stringify(input.args);
    if (Buffer.byteLength(argsJson) > MAX_APPROVAL_ARGS_BYTES) {
      throw new ApprovalTooLargeError(
        "This call's arguments are too large to hold for approval (over 1 MB).",
      );
    }
    const now = this.now();
    const record: ApprovalRecord = {
      id: newApprovalId(),
      agent: input.agent,
      upstream: input.upstream,
      tool: input.tool,
      upstreamTool: input.upstreamTool,
      argsJson,
      status: "pending",
      note: null,
      tailscaleLogin: input.tailscaleLogin ?? null,
      createdAt: now,
      expiresAt: now + APPROVAL_TTL_MS,
      decidedAt: null,
      ranAt: null,
    };
    this.store.insertApproval(record);
    this.log.info(`approval ${record.id} pending: ${record.agent} wants ${record.tool}`);
    return record;
  }

  /** The current record, expiring it first if its time is up. */
  get(id: string): ApprovalRecord | undefined {
    const record = this.store.getApproval(id);
    if ((record?.status === "pending" || record?.status === "approved") && record.expiresAt <= this.now()) {
      this.expireDue();
      return this.store.getApproval(id);
    }
    return record;
  }

  pending(): ApprovalRecord[] {
    return this.store.pendingApprovals(this.now());
  }

  decide(
    id: string,
    decision: "approved" | "declined",
    note?: string | null,
  ):
    | { ok: true; record: ApprovalRecord }
    | { ok: false; reason: "not_found" | "already_decided"; record?: ApprovalRecord } {
    const before = this.get(id);
    if (!before) return { ok: false, reason: "not_found" };
    const cleanNote = note?.trim() ? note.trim().slice(0, 2000) : null;
    const now = this.now();
    const runBy = decision === "approved" ? now + APPROVED_RUN_WINDOW_MS : undefined;
    if (!this.store.decideApproval(id, decision, cleanNote, now, runBy)) {
      return { ok: false, reason: "already_decided", record: before };
    }
    const record = this.store.getApproval(id)!;
    this.log.info(`approval ${id} ${decision}`);
    if (decision === "declined") {
      this.logOutcome(record, "declined", "Declined on the approval page.");
    }
    this.wake(id);
    return { ok: true, record };
  }

  /**
   * Expires every pending approval past its time, and every approved call
   * no agent ran within its window. Run on a timer too.
   */
  expireDue(): ApprovalRecord[] {
    const expired = this.store.expireApprovals(this.now());
    for (const record of expired) {
      const approved = expiredAfterApproval(record);
      this.log.info(`approval ${record.id} expired${approved ? " after it was approved, without running" : ""}`);
      this.logOutcome(
        record,
        "expired",
        approved ? "Approved, but no agent ran it in time." : "The approval expired.",
      );
      this.wake(record.id);
    }
    return expired;
  }

  /** How many calls from this agent are waiting for approval. */
  pendingFor(agent: string): number {
    return this.pending().filter((record) => record.agent === agent).length;
  }

  /**
   * Ends every hold now and makes later ones return at once, so held calls
   * answer with their approval id before the server shuts down.
   */
  release(): void {
    this.released = true;
    for (const id of [...this.waiters.keys()]) this.wake(id);
  }

  /**
   * Waits until the approval leaves "pending", the timeout passes or the
   * signal aborts, then returns the current record.
   */
  wait(id: string, timeoutMs: number, signal?: AbortSignal): Promise<ApprovalRecord | undefined> {
    const first = this.get(id);
    if (!first || first.status !== "pending" || signal?.aborted || this.released) return Promise.resolve(first);
    return new Promise((resolve) => {
      let set = this.waiters.get(id);
      if (!set) {
        set = new Set();
        this.waiters.set(id, set);
      }
      const waiters = set;
      const finish = () => {
        clearTimeout(timer);
        waiters.delete(finish);
        if (waiters.size === 0) this.waiters.delete(id);
        signal?.removeEventListener("abort", finish);
        resolve(this.get(id));
      };
      // Wake at the expiry too, so a hold never outlives its approval.
      const untilExpiry = Math.max(0, first.expiresAt - this.now()) + 5;
      const timer = setTimeout(finish, Math.min(timeoutMs, untilExpiry));
      waiters.add(finish);
      signal?.addEventListener("abort", finish, { once: true });
    });
  }

  /**
   * Runs an approved call exactly once. Callers that arrive while it runs,
   * or within ten minutes after, get the same result.
   */
  async runApproved(
    record: ApprovalRecord,
    execute: (args: Record<string, unknown>) => Promise<ToolResult>,
  ): Promise<RunOutcome> {
    const existing = this.runs.get(record.id);
    if (existing) return { kind: "result", result: await existing };
    if (!this.store.claimApprovalRun(record.id, this.now())) {
      const current = this.get(record.id);
      if (current?.status === "expired") return { kind: "expired" };
      return { kind: "already_ran", ranAt: current?.ranAt ?? null };
    }
    const args = JSON.parse(record.argsJson) as Record<string, unknown>;
    const run = execute(args).catch(
      (error: unknown): ToolResult => ({
        content: [{ type: "text", text: `The call failed: ${(error as Error)?.message ?? error}` }],
        isError: true,
      }),
    );
    this.runs.set(record.id, run);
    try {
      return { kind: "result", result: await run };
    } finally {
      this.store.scrubApprovalArgs(record.id, args);
      setTimeout(() => this.runs.delete(record.id), RESULT_TTL_MS).unref();
    }
  }

  private wake(id: string): void {
    for (const finish of [...(this.waiters.get(id) ?? [])]) finish();
  }

  private logOutcome(record: ApprovalRecord, decision: "declined" | "expired", error: string): void {
    let args: unknown = {};
    try {
      args = JSON.parse(record.argsJson);
    } catch {
      // Already scrubbed and truncated; log it as text.
      args = { truncated: record.argsJson };
    }
    this.store.logCall({
      agent: record.agent,
      tailscaleLogin: record.tailscaleLogin,
      upstream: record.upstream,
      tool: record.tool,
      args,
      decision,
      approvalId: record.id,
      ok: false,
      error,
    });
    this.store.scrubApprovalArgs(record.id, args);
  }
}
