// Upstreams changing while agents are connected: tool list changes reaching
// clients, the refresh paths, an upstream that forgets our session, a slow
// upstream at start, and a restart in the middle of a held call.

import assert from "node:assert/strict";
import { createServer, type Socket } from "node:net";
import { after, before, describe, it } from "node:test";

import { FIRST_LIST_WAIT_MS } from "../src/gateway.ts";
import { startFakeHttpUpstream, type FakeHttpUpstream } from "./fixtures/fakeHttpServer.ts";
import { type Gateway, freePort, legacyClient, modernClient, startGateway, stdioUpstream, textOf } from "./helpers.ts";

async function until(check: () => boolean | Promise<boolean>, timeoutMs = 10_000, what = "condition"): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

describe("tool list changes", () => {
  let gateway: Gateway;
  let http: FakeHttpUpstream;

  before(async () => {
    http = await startFakeHttpUpstream();
    gateway = await startGateway({
      upstreams: [
        stdioUpstream(),
        { id: "remote", title: "Remote", prefix: "remote", type: "http", url: http.url, auth: { type: "none" } },
      ],
    });
  });

  after(async () => {
    await gateway?.close();
    await http?.close();
  });

  it("refreshes its cache when an upstream sends list_changed, and tells 2026-07-28 clients", async () => {
    const seen: string[][] = [];
    const client = await modernClient(gateway, "claude-3", {
      listChanged: {
        tools: {
          onChanged: (_error, tools) => {
            if (tools) seen.push(tools.map((tool) => tool.name));
          },
        },
      },
    });
    const before = await client.listTools();
    assert.ok(!before.tools.some((tool) => tool.name === "remote__late_one"));
    http.addTool("late_one");
    await until(() => seen.some((names) => names.includes("remote__late_one")), 10_000, "list_changed at the client");
    assert.equal(textOf(await client.callTool({ name: "remote__late_one", arguments: {} })), "late_one ok");
    await client.close();
  });

  it("only advertises listChanged to 2026-07-28 clients", async () => {
    const legacy = await legacyClient(gateway, "codex");
    assert.equal(legacy.getServerCapabilities()?.tools?.listChanged, undefined);
    await legacy.close();
    const modern = await modernClient(gateway, "codex");
    assert.equal(modern.getServerCapabilities()?.tools?.listChanged, true);
    await modern.close();
  });

  it("reconnects by itself when an upstream forgets the session, so later changes still arrive", async () => {
    const remote = gateway.manager.get("remote")!;
    const readyBefore = remote.readyAt;
    http.dropSessions();
    // No agent call is needed: the dead GET stream is enough.
    await until(() => remote.readyAt !== readyBefore && remote.state === "ready", 15_000, "a reconnect");
    assert.ok(gateway.logs.some((line) => line.includes("remote: lost the session")));
    http.addTool("after_restart");
    await until(
      () => remote.tools.some((tool) => tool.name === "remote__after_restart"),
      10_000,
      "the new tool after the reconnect",
    );
  });

  it("refreshAll reconnects an upstream in error that came back, and leaves a signed-out one alone", async () => {
    const remote = gateway.manager.get("remote")!;
    const fake = gateway.manager.get("fake")!;
    remote.state = "error";
    fake.state = "needs_sign_in";
    try {
      await gateway.manager.refreshAll();
      assert.equal(remote.state, "ready");
      assert.equal(fake.state, "needs_sign_in");
    } finally {
      fake.state = "ready";
    }
  });
});

describe("a slow upstream at start", () => {
  let gateway: Gateway;
  let hanging: ReturnType<typeof createServer>;
  const sockets: Socket[] = [];
  let startedAt = 0;

  before(async () => {
    // Accepts connections and never answers, like an upstream that hangs.
    hanging = createServer((socket) => sockets.push(socket));
    const port = await freePort();
    await new Promise<void>((resolve) => hanging.listen(port, "127.0.0.1", resolve));
    startedAt = Date.now();
    gateway = await startGateway({
      upstreams: [
        stdioUpstream(),
        { id: "slow", title: "Slow", prefix: "slow", type: "http", url: `http://127.0.0.1:${port}/mcp`, auth: { type: "none" } },
      ],
      waitForUpstreams: false,
      server: { connectTimeoutMs: 20_000 },
    });
  });

  after(async () => {
    for (const socket of sockets) socket.destroy();
    await gateway?.close();
    await new Promise<void>((resolve) => hanging.close(() => resolve()));
  });

  it("answers tools/list a few seconds after start at most, then without waiting", async () => {
    const client = await legacyClient(gateway, "codex");
    const first = await client.listTools();
    const firstAt = Date.now() - startedAt;
    assert.ok(firstAt < FIRST_LIST_WAIT_MS + 1_500, `first list took ${firstAt} ms from start`);
    assert.ok(first.tools.some((tool) => tool.name === "fake__echo"));
    assert.equal(gateway.manager.get("slow")!.state, "connecting");
    const started = Date.now();
    await client.listTools();
    assert.ok(Date.now() - started < 500, "second list waited");
    await client.close();
  });
});

describe("a restart during a held call", () => {
  let gateway: Gateway;
  let closed = false;

  before(async () => {
    gateway = await startGateway({ upstreams: [stdioUpstream()], holdMs: 20_000, server: { drainMs: 1_000 } });
  });

  after(async () => {
    if (!closed) await gateway?.close();
  });

  it("answers the held call with its approval id before shutting down", async () => {
    const client = await legacyClient(gateway, "codex");
    const started = Date.now();
    const held = client.callTool({ name: "fake__send_message", arguments: { to: "ana", text: "x" } });
    await until(() => gateway.approvals.pending().length === 1, 5_000, "the approval");
    const id = gateway.approvals.pending()[0]!.id;
    closed = true;
    const closing = gateway.close();
    const result = await held;
    assert.match(textOf(result), new RegExp(`Waiting for Sam .* id ${id}`));
    assert.ok(Date.now() - started < 5_000, "answered well before the hold would have ended");
    await closing;
    await client.close().catch(() => {});
  });
});
