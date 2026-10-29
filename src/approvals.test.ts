import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { APPROVAL_TTL_MS, ApprovalTooLargeError, Approvals, type ToolResult } from "./approvals.ts";
import { Store } from "./db.ts";

function setup() {
  const store = new Store(join(mkdtempSync(join(tmpdir(), "connectors-approvals-")), "db.sqlite"));
  let now = 1_000_000;
  const approvals = new Approvals(store, { now: () => now });
  return {
    store,
    approvals,
    advance(ms: number) {
      now += ms;
    },
  };
}

const request = {
  agent: "claude-3",
  upstream: "gmail",
  tool: "gmail__send_message",
  upstreamTool: "send_message",
  args: { to: "a@example.com", text: "hi", api_token: "secret-value" },
};

const ok = (text: string): ToolResult => ({ content: [{ type: "text", text }] });

describe("approvals", () => {
  it("start pending and expire after 24 hours", () => {
    const { approvals, advance, store } = setup();
    const record = approvals.create(request);
    assert.match(record.id, /^ap_[A-Za-z0-9_-]{16}$/);
    assert.equal(record.status, "pending");
    assert.equal(record.expiresAt - record.createdAt, APPROVAL_TTL_MS);
    assert.equal(approvals.pending().length, 1);
    advance(APPROVAL_TTL_MS + 1);
    assert.equal(approvals.get(record.id)?.status, "expired");
    assert.equal(approvals.pending().length, 0);
    // The expiry is in the call log, without the secret.
    const [call] = store.calls();
    assert.equal(call?.decision, "expired");
    assert.equal(call?.approvalId, record.id);
    assert.ok(!call?.argsJson?.includes("secret-value"));
    // Too late to approve.
    assert.deepEqual(approvals.decide(record.id, "approved").ok, false);
  });

  it("can be declined with a note, which is logged", () => {
    const { approvals, store } = setup();
    const record = approvals.create(request);
    const result = approvals.decide(record.id, "declined", "  not now  ");
    assert.ok(result.ok);
    assert.equal(result.record.status, "declined");
    assert.equal(result.record.note, "not now");
    assert.equal(store.calls()[0]?.decision, "declined");
    // A decision is final.
    assert.equal(approvals.decide(record.id, "approved").ok, false);
    assert.deepEqual(approvals.decide("ap_missing", "approved"), { ok: false, reason: "not_found" });
  });

  it("wake waiters when decided", async () => {
    const { approvals } = setup();
    const record = approvals.create(request);
    const waiting = approvals.wait(record.id, 10_000);
    setTimeout(() => approvals.decide(record.id, "approved"), 20);
    const started = Date.now();
    const result = await waiting;
    assert.equal(result?.status, "approved");
    assert.ok(Date.now() - started < 5000);
  });

  it("stop waiting at the timeout or when the caller hangs up", async () => {
    const { approvals } = setup();
    const record = approvals.create(request);
    assert.equal((await approvals.wait(record.id, 30))?.status, "pending");
    const controller = new AbortController();
    const waiting = approvals.wait(record.id, 10_000, controller.signal);
    controller.abort();
    assert.equal((await waiting)?.status, "pending");
  });

  it("run an approved call exactly once, even when two callers race", async () => {
    const { approvals, store } = setup();
    const record = approvals.create(request);
    approvals.decide(record.id, "approved");
    const approved = approvals.get(record.id)!;
    let runs = 0;
    const execute = async () => {
      runs += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return ok("sent");
    };
    const [a, b] = await Promise.all([
      approvals.runApproved(approved, execute),
      approvals.runApproved(approved, execute),
    ]);
    assert.equal(runs, 1);
    assert.deepEqual(a, { kind: "result", result: ok("sent") });
    assert.deepEqual(b, { kind: "result", result: ok("sent") });
    // Later callers still get the result while it's cached.
    assert.deepEqual(await approvals.runApproved(approved, execute), { kind: "result", result: ok("sent") });
    assert.equal(runs, 1);
    const after = store.getApproval(record.id)!;
    assert.equal(after.status, "ran");
    // Full arguments are dropped once the call has run.
    assert.ok(!after.argsJson.includes("secret-value"));
  });

  it("report a run whose result is gone instead of running it again", async () => {
    const { store } = setup();
    // A fresh Approvals has no cached result, like after a restart.
    const first = new Approvals(store);
    const record = first.create(request);
    first.decide(record.id, "approved");
    await first.runApproved(first.get(record.id)!, async () => ok("sent"));
    const second = new Approvals(store);
    let ran = false;
    const outcome = await second.runApproved(second.get(record.id)!, async () => {
      ran = true;
      return ok("again");
    });
    assert.equal(ran, false);
    assert.equal(outcome.kind, "already_ran");
  });

  it("never runs a pending or declined call", async () => {
    const { approvals } = setup();
    const record = approvals.create(request);
    let ran = false;
    const outcome = await approvals.runApproved(record, async () => {
      ran = true;
      return ok("x");
    });
    assert.equal(ran, false);
    assert.equal(outcome.kind, "already_ran");
    approvals.decide(record.id, "declined");
    await approvals.runApproved(approvals.get(record.id)!, async () => {
      ran = true;
      return ok("x");
    });
    assert.equal(ran, false);
  });

  it("turn a thrown error into an error result", async () => {
    const { approvals } = setup();
    const record = approvals.create(request);
    approvals.decide(record.id, "approved");
    const outcome = await approvals.runApproved(approvals.get(record.id)!, async () => {
      throw new Error("boom");
    });
    assert.equal(outcome.kind, "result");
    assert.equal(outcome.kind === "result" && outcome.result.isError, true);
  });

  it("refuse to hold huge arguments", () => {
    const { approvals } = setup();
    assert.throws(
      () => approvals.create({ ...request, args: { body: "x".repeat(1024 * 1024 + 10) } }),
      ApprovalTooLargeError,
    );
  });
});
