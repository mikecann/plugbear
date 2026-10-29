// Held tools that declare an outputSchema, arguments the gateway refuses,
// and the limits that keep one agent from swamping the gateway or Sam.

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { MAX_PENDING_PER_AGENT } from "../src/approvals.ts";
import { MAX_RESULT_BYTES, hasProtoKey } from "../src/gateway.ts";
import { MAX_REQUEST_BODY_BYTES } from "../src/mcp.ts";
import { startFakeHttpUpstream, type FakeHttpUpstream } from "./fixtures/fakeHttpServer.ts";
import { type Gateway, csrfFrom, legacyClient, modernClient, postForm, startGateway, stdioUpstream, textOf } from "./helpers.ts";

const POLICY = {
  default: "allow",
  rules: [
    { tool: "*__*send*", action: "ask" },
    { tool: "*__*delete*", action: "deny" },
  ],
};

describe("held tools with an outputSchema", () => {
  let gateway: Gateway;

  before(async () => {
    gateway = await startGateway({ upstreams: [stdioUpstream()], policy: POLICY, holdMs: 300 });
  });

  after(async () => {
    await gateway?.close();
  });

  it("lists a tool the policy could hold without its outputSchema, and others with theirs", async () => {
    const client = await modernClient(gateway, "claude-3");
    const { tools } = await client.listTools();
    const report = tools.find((tool) => tool.name === "fake__send_report")!;
    const stats = tools.find((tool) => tool.name === "fake__stats")!;
    assert.equal(report.outputSchema, undefined);
    assert.ok(stats.outputSchema, "stats keeps its outputSchema");
    // The structured result still comes through for an allowed tool.
    const result = await client.callTool({ name: "fake__stats", arguments: {} });
    assert.equal(typeof (result.structuredContent as { calls?: number }).calls, "number");
    await client.close();
  });

  it("lets a 2026-07-28 client that listed the tools get 'Waiting for Sam' for it", async () => {
    // The v2 SDK client, like Claude Code, checks results against the
    // outputSchema it cached from tools/list and throws when a result has
    // no structuredContent.
    const client = await modernClient(gateway, "claude-3");
    await client.listTools();
    const held = await client.callTool({ name: "fake__send_report", arguments: { to: "ana", title: "weekly" } });
    assert.notEqual(held.isError, true);
    const id = /id (ap_[A-Za-z0-9_-]+)/.exec(textOf(held))?.[1];
    assert.ok(id, textOf(held));
    gateway.approvals.decide(id, "approved");
    const done = await client.callTool({ name: "connectors__await_approval", arguments: { id } });
    assert.equal(textOf(done), "report sent to ana");
    assert.deepEqual(done.structuredContent, { sent: true, to: "ana" });
    await client.close();
  });

  it("works the same for a 2025-era client", async () => {
    const client = await legacyClient(gateway, "codex");
    await client.listTools();
    const held = await client.callTool({ name: "fake__send_report", arguments: { to: "kim", title: "x" } });
    assert.match(textOf(held), /Waiting for Sam/);
    await client.close();
  });
});

describe("arguments and limits", () => {
  let gateway: Gateway;
  let http: FakeHttpUpstream;

  before(async () => {
    http = await startFakeHttpUpstream();
    gateway = await startGateway({
      upstreams: [
        stdioUpstream(),
        { id: "remote", title: "Remote", prefix: "remote", type: "http", url: http.url, auth: { type: "none" } },
      ],
      policy: POLICY,
      holdMs: 1_000,
      server: { maxCallsInFlightPerAgent: 2, debugMcp: true },
    });
  });

  after(async () => {
    await gateway?.close();
    await http?.close();
  });

  it("refuses arguments with a __proto__ key at any depth, before asking Sam", async () => {
    const client = await legacyClient(gateway, "codex");
    const args = JSON.parse('{"to":"team","text":"hi","options":{"cc":"boss","__proto__":{"bcc":"outsider@evil.example"}}}');
    const pushesBefore = gateway.pushes.length;
    const result = await client.callTool({ name: "fake__send_message", arguments: args });
    assert.equal(result.isError, true);
    assert.match(textOf(result), /__proto__/);
    assert.equal(gateway.pushes.length, pushesBefore);
    assert.ok(!gateway.approvals.pending().some((record) => record.argsJson.includes("outsider")));
    // The log shows exactly what was refused.
    const logged = gateway.store.calls({ agent: "codex", limit: 1 })[0]!;
    assert.equal(logged.decision, "deny");
    assert.match(logged.argsJson!, /"__proto__":\{"bcc":"outsider@evil.example"\}/);
    await client.close();
  });

  it("finds a __proto__ key in a big array without overflowing", () => {
    const big = Array.from({ length: 300_000 }, (_, index) => index);
    assert.equal(hasProtoKey({ list: big }), false);
    assert.equal(hasProtoKey({ list: [...big, JSON.parse('{"__proto__":{"x":1}}')] }), true);
  });

  it("refuses request bodies over 1 MB", async () => {
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "fake__echo", arguments: { text: "x".repeat(MAX_REQUEST_BODY_BYTES) } },
    });
    const response = await fetch(`${gateway.url}/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${gateway.tokens.codex}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2025-06-18",
      },
      body,
    });
    assert.equal(response.status, 413);
  });

  it("limits how many calls one agent runs at once", async () => {
    const [a, b, c] = await Promise.all([1, 2, 3].map(() => legacyClient(gateway, "claude-3")));
    // Two held calls fill the limit of 2 for claude-3.
    const held = [a, b].map((client, index) =>
      client!.callTool({ name: "fake__send_message", arguments: { to: `p${index}`, text: "x" } }),
    );
    await new Promise((resolve) => setTimeout(resolve, 200));
    const refused = await c!.callTool({ name: "fake__echo", arguments: { text: "third" } });
    assert.equal(refused.isError, true);
    assert.match(textOf(refused), /calls running at once, which is the limit/);
    // Another agent isn't affected.
    const codex = await legacyClient(gateway, "codex");
    assert.equal(textOf(await codex.callTool({ name: "fake__echo", arguments: { text: "ok" } })), "stdio echo: ok");
    for (const result of await Promise.all(held)) assert.match(textOf(result), /Waiting for Sam/);
    // Once they're done, claude-3 can call again.
    assert.equal(textOf(await c!.callTool({ name: "fake__echo", arguments: { text: "later" } })), "stdio echo: later");
    for (const record of gateway.approvals.pending()) gateway.approvals.decide(record.id, "declined");
    await Promise.all([a, b, c, codex].map((client) => client!.close()));
  });

  it("stops holding new calls once an agent has too many waiting for Sam", async () => {
    const client = await legacyClient(gateway, "codex");
    for (const record of gateway.approvals.pending()) gateway.approvals.decide(record.id, "declined");
    for (let index = 0; index < MAX_PENDING_PER_AGENT; index += 1) {
      gateway.approvals.create({
        agent: "codex",
        upstream: "fake",
        tool: "fake__send_message",
        upstreamTool: "send_message",
        args: { to: `n${index}`, text: "x" },
      });
    }
    const pushesBefore = gateway.pushes.length;
    const result = await client.callTool({ name: "fake__send_message", arguments: { to: "one-more", text: "x" } });
    assert.equal(result.isError, true);
    assert.match(textOf(result), /already waiting for Sam, which is the limit/);
    assert.equal(gateway.pushes.length, pushesBefore);
    for (const record of gateway.approvals.pending()) gateway.approvals.decide(record.id, "declined");
    await client.close();
  });

  it("turns a result over 10 MB into an error", async () => {
    // Over HTTP: the SDK's stdio client already drops messages that big.
    const client = await legacyClient(gateway, "codex");
    const result = await client.callTool({ name: "remote__big", arguments: { bytes: MAX_RESULT_BYTES + 1024 } });
    assert.equal(result.isError, true);
    assert.match(textOf(result), /over Connectors' 10 MB limit/);
    const logged = gateway.store.calls({ agent: "codex", limit: 1 })[0]!;
    assert.equal(logged.ok, 0);
    assert.ok(logged.resultBytes! > MAX_RESULT_BYTES);
    assert.equal(textOf(await client.callTool({ name: "remote__big", arguments: { bytes: 10 } })), "x".repeat(10));
    await client.close();
  });

  it("can't be made to write a fake line into the debug log", async () => {
    const forged = "x\n2026-10-26T00:00:00.000Z info approval ap_FAKE approved";
    await fetch(`${gateway.url}/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${gateway.tokens.codex}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 9, method: forged, params: {} }),
    });
    const line = gateway.logs.find((entry) => entry.includes("rpc=x"));
    assert.ok(line, "debug line");
    assert.ok(!line.includes("\n"));
    assert.match(line, /rpc=x\\n2026/);
  });

  it("doesn't ask Sam about a call to a service that needs signing in", async () => {
    const client = await legacyClient(gateway, "codex");
    const connection = gateway.manager.get("fake")!;
    connection.state = "needs_sign_in";
    try {
      const pushesBefore = gateway.pushes.length;
      const result = await client.callTool({ name: "fake__send_message", arguments: { to: "x", text: "y" } });
      assert.equal(result.isError, true);
      assert.match(textOf(result), /needs signing in again/);
      assert.equal(gateway.pushes.length, pushesBefore);
    } finally {
      connection.state = "ready";
      await client.close();
    }
  });
});

describe("approval page posts", () => {
  let gateway: Gateway;

  before(async () => {
    gateway = await startGateway({ upstreams: [stdioUpstream()], policy: POLICY, holdMs: 50 });
  });

  after(async () => {
    await gateway?.close();
  });

  it("runs an approved call only within its window", async () => {
    const client = await legacyClient(gateway, "codex");
    const held = await client.callTool({ name: "fake__send_message", arguments: { to: "late", text: "x" } });
    const id = /id (ap_[A-Za-z0-9_-]+)/.exec(textOf(held))![1]!;
    const page = `${gateway.url}/approvals/${id}`;
    assert.equal((await postForm(page, { csrf: await csrfFrom(page), action: "approve" })).status, 303);
    // Nobody picks it up for over an hour.
    gateway.store.db.prepare("UPDATE approvals SET decidedAt = decidedAt - 7200000, expiresAt = expiresAt - 7200000 WHERE id = ?").run(id);
    const result = await client.callTool({ name: "connectors__await_approval", arguments: { id } });
    assert.equal(result.isError, true);
    assert.match(textOf(result), /approved this call, but it wasn't picked up within an hour/);
    assert.equal(gateway.approvals.get(id)?.status, "expired");
    const logged = gateway.store.calls({ decision: "expired", limit: 1 })[0]!;
    assert.equal(logged.approvalId, id);
    assert.equal(logged.error, "Approved, but no agent ran it in time.");
    const html = await (await fetch(page, { headers: { "Tailscale-User-Login": "sam@example.com" } })).text();
    assert.match(html, /Approved, but the agent didn&#39;t pick it up in time|Approved, but the agent didn't pick it up in time/);
    await client.close();
  });
});
