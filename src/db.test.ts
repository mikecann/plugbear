import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { ARGS_LOG_LIMIT, CALL_RETENTION_MS, Store, argsForLog, redact, truncateUtf8 } from "./db.ts";

function store(): Store {
  return new Store(join(mkdtempSync(join(tmpdir(), "connectors-db-")), "db.sqlite"));
}

describe("call log", () => {
  it("redacts secret-looking keys at any depth", () => {
    // Through JSON, as the log stores it: redact() builds prototype-free objects.
    const redacted = (value: unknown) => JSON.parse(JSON.stringify(redact(value)));
    assert.deepEqual(
      redacted({
        to: "a",
        password: "p",
        nested: { apiKey: "k", api_key: "k2", headers: { Authorization: "Bearer x", Cookie: "c" } },
        list: [{ access_token: "t", value: 1 }],
        client_secret: "s",
      }),
      {
        to: "a",
        password: "[redacted]",
        nested: { apiKey: "[redacted]", api_key: "[redacted]", headers: { Authorization: "[redacted]", Cookie: "[redacted]" } },
        list: [{ access_token: "[redacted]", value: 1 }],
        client_secret: "[redacted]",
      },
    );
  });

  it("keeps a nested __proto__ key visible instead of making it a prototype", () => {
    const args = JSON.parse('{"to":"team","options":{"cc":"boss","__proto__":{"bcc":"outsider"}}}');
    const logged = JSON.parse(argsForLog(args).argsJson);
    assert.ok(Object.hasOwn(logged.options, "__proto__"));
    assert.equal(logged.options.__proto__.bcc, "outsider");
    assert.match(argsForLog(args).argsJson, /"__proto__":\{"bcc":"outsider"\}/);
  });

  it("truncates arguments to 16 KB without splitting characters", () => {
    const big = { text: "é".repeat(20_000) };
    const { argsJson, argsSha256 } = argsForLog(big);
    assert.ok(Buffer.byteLength(argsJson) <= ARGS_LOG_LIMIT);
    assert.match(argsJson, /\[truncated \d+ bytes\]$/);
    assert.ok(!argsJson.includes("�"));
    // The hash covers the full, unredacted arguments.
    assert.equal(argsSha256, createHash("sha256").update(JSON.stringify(big)).digest("hex"));
    assert.equal(truncateUtf8("short", 100), "short");
  });

  it("keeps text with NUL characters intact", () => {
    const db = store();
    db.logCall({ agent: "codex", tool: "x__y", args: { text: "a\u0000b" }, decision: "allow", ok: true });
    assert.equal(db.calls()[0]?.argsJson, JSON.stringify({ text: "a\u0000b" }));
  });

  it("stores calls and filters them", () => {
    const db = store();
    db.logCall({ agent: "codex", upstream: "notion", tool: "notion__search", args: { q: "x" }, decision: "allow", ok: true, durationMs: 5, resultBytes: 10 });
    db.logCall({ agent: "grok", upstream: "gmail", tool: "gmail__send", args: {}, decision: "declined", ok: false, approvalId: "ap_1" });
    db.logCall({ agent: "codex", upstream: "gmail", tool: "gmail__send", args: {}, decision: "approved", ok: true, approvalId: "ap_2", tailscaleLogin: "sam@example.com" });
    db.logCall({ agent: "codex", upstream: "x", tool: "x__y", decision: "deny", ok: false, error: "Blocked by policy" });
    assert.equal(db.calls().length, 4);
    assert.equal(db.calls({ agent: "codex" }).length, 3);
    assert.equal(db.calls({ upstream: "gmail" }).length, 2);
    assert.equal(db.calls({ decision: "deny" }).length, 1);
    assert.deepEqual(db.calls({ sendsOnly: true }).map((call) => call.approvalId).sort(), ["ap_1", "ap_2"]);
    assert.equal(db.calls({ agent: "codex", sendsOnly: true })[0]?.tailscaleLogin, "sam@example.com");
    assert.equal(db.calls({ limit: 2 }).length, 2);
    const first = db.calls({ upstream: "notion" })[0]!;
    assert.equal(first.ok, 1);
    assert.equal(first.argsJson, '{"q":"x"}');
    assert.equal(first.argsSha256?.length, 64);
    assert.deepEqual(db.distinctCallValues("agent"), ["codex", "grok"]);
  });

  it("prunes calls older than 90 days and finished approvals, but not pending ones", () => {
    const db = store();
    const now = Date.now();
    const old = now - CALL_RETENTION_MS - 1000;
    db.logCall({ ts: old, agent: "codex", tool: "a__b", decision: "allow" });
    db.logCall({ ts: now - 1000, agent: "codex", tool: "a__b", decision: "allow" });
    const approval = {
      agent: "codex", upstream: "u", tool: "u__t", upstreamTool: "t", argsJson: "{}", note: null,
      tailscaleLogin: null, decidedAt: null, ranAt: null,
    };
    db.insertApproval({ ...approval, id: "ap_old_done", status: "declined", createdAt: old, expiresAt: old + 1 });
    db.insertApproval({ ...approval, id: "ap_old_pending", status: "pending", createdAt: old, expiresAt: now + 1000 });
    db.insertApproval({ ...approval, id: "ap_new", status: "ran", createdAt: now, expiresAt: now + 1000 });
    db.insertOAuthState("expired-state", "notion", now - 20 * 60_000, 10 * 60_000);
    db.insertOAuthState("live-state", "notion", now, 10 * 60_000);
    const removed = db.prune(now);
    assert.deepEqual(removed, { calls: 1, approvals: 1, states: 1 });
    assert.equal(db.calls().length, 1);
    assert.equal(db.getApproval("ap_old_done"), undefined);
    assert.ok(db.getApproval("ap_old_pending"));
    assert.ok(db.getApproval("ap_new"));
    assert.equal(db.lastPrune(), now);
  });

  it("uses OAuth states once and only before they expire", () => {
    const db = store();
    const now = Date.now();
    db.insertOAuthState("s1", "notion", now, 10 * 60_000);
    assert.equal(db.takeOAuthState("s1", now + 1000), "notion");
    assert.equal(db.takeOAuthState("s1", now + 1000), undefined);
    db.insertOAuthState("s2", "notion", now, 10 * 60_000);
    assert.equal(db.takeOAuthState("s2", now + 10 * 60_000 + 1), undefined);
    assert.equal(db.takeOAuthState("never", now), undefined);
  });
});
