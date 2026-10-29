// End-to-end through /mcp: a fake stdio upstream and a fake session-based
// HTTP upstream, driven by a 2025-era client (v1 SDK, like Codex, Grok and
// Muse) and a 2026-07-28 client (v2 SDK, like Claude Code).

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { LONG_TOOL_NAME } from "./fixtures/fakeTools.ts";
import { startFakeHttpUpstream, type FakeHttpUpstream } from "./fixtures/fakeHttpServer.ts";
import {
  type Gateway,
  adminHeaders,
  csrfFrom,
  legacyClient,
  modernClient,
  postForm,
  startGateway,
  stdioUpstream,
  textOf,
} from "./helpers.ts";

type Health = {
  ok: boolean;
  version: string;
  upstreams: Record<string, { id: string; title: string; state: string; message: string; connectUrl: string; tools: number }>;
};

describe("gateway over /mcp", () => {
  let gateway: Gateway;
  let http: FakeHttpUpstream;
  let work: FakeHttpUpstream;
  const stdioLog = join(mkdtempSync(join(tmpdir(), "connectors-stdio-")), "calls.log");

  before(async () => {
    // Must not reach the stdio child, which only gets a safe default env.
    process.env.CONNECTORS_TEST_LEAK = "leak";
    http = await startFakeHttpUpstream({ bearer: "upstream-static-token" });
    work = await startFakeHttpUpstream({ label: "work echo" });
    gateway = await startGateway({
      upstreams: [
        stdioUpstream({
          env: { FAKE_LOG_FILE: stdioLog, FAKE_PLAIN: "plain-value", FAKE_SECRET: { secretFile: "upstream-env/fake-secret" } },
        }),
        { id: "remote", title: "Remote (personal)", prefix: "remote", type: "http", url: http.url, auth: { type: "bearer" } },
        { id: "remotework", title: "Remote (work)", prefix: "rwork", tags: ["work"], type: "http", url: work.url, auth: { type: "none" } },
      ],
      beforeStart(layout) {
        mkdirSync(join(layout.secrets, "upstream-tokens"), { recursive: true, mode: 0o700 });
        writeFileSync(join(layout.secrets, "upstream-tokens", "remote"), "upstream-static-token\n", { mode: 0o600 });
        mkdirSync(join(layout.secrets, "upstream-env"), { recursive: true, mode: 0o700 });
        writeFileSync(join(layout.secrets, "upstream-env", "fake-secret"), "from-a-secret-file\n", { mode: 0o600 });
      },
    });
  });

  after(async () => {
    await gateway?.close();
    await http?.close();
    await work?.close();
  });

  it("answers 401 without OAuth hints to a missing or bad token", async () => {
    for (const authorization of [undefined, "Bearer nope", `Bearer ${gateway.tokens.codex}x`, `Basic ${gateway.tokens.codex}`]) {
      const response = await fetch(`${gateway.url}/mcp`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          ...(authorization ? { authorization } : {}),
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
      });
      assert.equal(response.status, 401, authorization ?? "no header");
      assert.equal(response.headers.get("www-authenticate"), null);
    }
    for (const path of [
      "/.well-known/oauth-protected-resource",
      "/.well-known/oauth-protected-resource/mcp",
      "/.well-known/oauth-authorization-server",
      "/register",
      "/authorize",
      "/token",
    ]) {
      assert.equal((await fetch(`${gateway.url}${path}`)).status, 404, path);
    }
  });

  it("serves /health without auth", async () => {
    const health = (await (await fetch(`${gateway.url}/health`)).json()) as Health;
    assert.equal(health.ok, true);
    assert.match(health.version, /^\d+\.\d+\.\d+/);
    assert.deepEqual(Object.keys(health.upstreams), ["fake", "remote", "remotework"]);
    assert.deepEqual(health.upstreams.remote, {
      id: "remote",
      title: "Remote (personal)",
      state: "connected",
      message: "Connected, 10 tools.",
      connectUrl: `${gateway.url}/admin/connect/remote`,
      tools: 10,
    });
  });

  it("lists every allowed tool to a 2025-era client", async () => {
    const client = await legacyClient(gateway, "codex");
    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name);
    for (const name of ["connectors__await_approval", "connectors__status", "fake__echo", "remote__send_message", "rwork__echo"]) {
      assert.ok(names.includes(name), name);
    }
    for (const name of names) assert.match(name, /^[a-zA-Z0-9_-]{1,64}$/);
    await client.close();
  });

  it("lists tools to a 2026-07-28 client, minus work upstreams for Grok", async () => {
    const client = await modernClient(gateway, "grok");
    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name);
    assert.ok(names.includes("fake_echo"));
    assert.ok(names.includes("remote_echo"));
    assert.ok(!names.some((name) => name.startsWith("rwork_")));
    await client.close();
  });

  it("gives Grok names with no second __, and the same policy and log", async () => {
    const client = await legacyClient(gateway, "grok");
    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name);
    for (const name of ["connectors_await_approval", "connectors_status", "fake_echo", "fake_send_message"]) {
      assert.ok(names.includes(name), name);
    }
    for (const name of names) {
      assert.ok(!name.includes("__"), name);
      assert.match(name, /^[a-zA-Z0-9_-]{1,64}$/);
    }
    assert.equal(textOf(await client.callTool({ name: "fake_echo", arguments: { text: "grok" } })), "stdio echo: grok");
    // A long name maps back in this style too.
    const long = names.find((name) => name.startsWith("fake_list_every_single_thing"))!;
    assert.equal(textOf(await client.callTool({ name: long, arguments: {} })), "long ok");
    // Other agents' names aren't Grok's.
    const wrongStyle = await client.callTool({ name: "fake__echo", arguments: { text: "x" } });
    assert.equal(wrongStyle.isError, true);
    // The "ask" rule *__*send* still holds, and the reply names Grok's await tool.
    const held = await client.callTool({ name: "fake_send_message", arguments: { to: "kim", text: "hi" } });
    assert.match(textOf(held), /call connectors_await_approval with id ap_/);
    const approval = gateway.approvals.pending().find((record) => record.agent === "grok")!;
    assert.equal(approval.tool, "fake__send_message");
    gateway.approvals.decide(approval.id, "declined");
    const logged = gateway.store.calls({ agent: "grok", limit: 5 }).map((call) => call.tool);
    assert.ok(logged.includes("fake__echo"));
    assert.ok(logged.includes("fake__send_message"));
    await client.close();
  });

  it("marks twin upstreams in tool descriptions", async () => {
    const client = await legacyClient(gateway, "codex");
    const { tools } = await client.listTools();
    const describe = (name: string) => tools.find((tool) => tool.name === name)?.description;
    assert.equal(describe("remote__echo"), "Echoes the text back (Remote, personal)");
    assert.equal(describe("rwork__echo"), "Echoes the text back (Remote, work)");
    assert.equal(describe("fake__echo"), "Echoes the text back");
    await client.close();
  });

  it("calls stdio and HTTP upstreams for both client eras and logs each call", async () => {
    const legacy = await legacyClient(gateway, "codex");
    const modern = await modernClient(gateway, "claude-3");
    assert.equal(textOf(await legacy.callTool({ name: "fake__echo", arguments: { text: "one" } })), "stdio echo: one");
    assert.equal(textOf(await modern.callTool({ name: "remote__echo", arguments: { text: "two" } })), "http echo: two");
    assert.equal(textOf(await modern.callTool({ name: "rwork__echo", arguments: { text: "three" } })), "work echo: three");
    const calls = gateway.store.calls({ limit: 3 });
    assert.deepEqual(
      calls.map((call) => [call.agent, call.upstream, call.tool, call.decision, call.ok]),
      [
        ["claude-3", "remotework", "rwork__echo", "allow", 1],
        ["claude-3", "remote", "remote__echo", "allow", 1],
        ["codex", "fake", "fake__echo", "allow", 1],
      ],
    );
    // The legacy client sent Tailscale-User-Login; it's recorded.
    assert.equal(calls[2]?.tailscaleLogin, "sam@example.com");
    assert.ok((calls[1]?.resultBytes ?? 0) > 0);
    await legacy.close();
    await modern.close();
  });

  it("never passes an agent's token upstream", async () => {
    assert.ok(http.authHeaders.length > 0);
    for (const header of [...http.authHeaders, ...work.authHeaders]) {
      assert.equal(header, "Bearer upstream-static-token");
      for (const token of Object.values(gateway.tokens)) assert.ok(!header.includes(token));
    }
    assert.equal(work.authHeaders.length, 0);
  });

  it("passes env values and secret files to stdio servers", async () => {
    const client = await legacyClient(gateway, "codex");
    assert.equal(textOf(await client.callTool({ name: "fake__env", arguments: { name: "FAKE_PLAIN" } })), "plain-value");
    assert.equal(textOf(await client.callTool({ name: "fake__env", arguments: { name: "FAKE_SECRET" } })), "from-a-secret-file");
    // The gateway's own environment doesn't leak into the child.
    assert.equal(textOf(await client.callTool({ name: "fake__env", arguments: { name: "CONNECTORS_TEST_LEAK" } })), "(unset)");
    assert.ok(gateway.logs.some((line) => line.includes(`fake: starting ${process.execPath}`)));
    await client.close();
  });

  it("exposes long tool names short enough for Codex and maps them back", async () => {
    const client = await legacyClient(gateway, "codex");
    const { tools } = await client.listTools();
    const long = tools.find((tool) => tool.name.startsWith("fake__list_every_single_thing"));
    assert.ok(long, "long tool listed");
    assert.ok(long.name.length <= 64);
    assert.equal(textOf(await client.callTool({ name: long.name, arguments: {} })), "long ok");
    assert.ok(LONG_TOOL_NAME.length > 64);
    await client.close();
  });

  it("returns upstream errors as tool errors", async () => {
    const client = await legacyClient(gateway, "codex");
    const result = await client.callTool({ name: "fake__fail", arguments: {} });
    assert.equal(result.isError, true);
    assert.equal(textOf(result), "it failed");
    const unknown = await client.callTool({ name: "fake__nope", arguments: {} });
    assert.equal(unknown.isError, true);
    assert.match(textOf(unknown), /Unknown tool/);
    // Grok can't reach work tools even by name.
    const grok = await legacyClient(gateway, "grok");
    const blocked = await grok.callTool({ name: "rwork_echo", arguments: { text: "x" } });
    assert.equal(blocked.isError, true);
    assert.equal(work.state.calls.filter((name) => name === "echo").length, 1);
    await client.close();
    await grok.close();
  });

  it("blocks tools the policy denies", async () => {
    const client = await legacyClient(gateway, "codex");
    const result = await client.callTool({ name: "remote__delete_page", arguments: { id: "p1" } });
    assert.equal(result.isError, true);
    assert.match(textOf(result), /policy doesn't allow/);
    assert.ok(!http.state.calls.includes("delete_page"));
    assert.equal(gateway.store.calls({ decision: "deny", limit: 1 })[0]?.tool, "remote__delete_page");
    await client.close();
  });

  it("leaves tools the policy always denies out of the list and the status count", async () => {
    const client = await legacyClient(gateway, "codex");
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    assert.ok(!names.includes("remote__delete_page"));
    assert.ok(!names.includes("fake__delete_page"));
    assert.ok(names.includes("remote__echo"));
    const status = textOf(await client.callTool({ name: "connectors__status", arguments: {} }));
    // Each fake server has 10 tools, one of them delete_page.
    assert.match(status, /Remote \(personal\) \(tools start with remote__\): signed in, 9 tools/);
    await client.close();
  });

  it("runs an ask call when Sam approves within the hold", async () => {
    const client = await modernClient(gateway, "claude-3");
    const before = http.state.sends.length;
    const pending = client.callTool({ name: "remote__send_message", arguments: { to: "sam", text: "hello", api_token: "hush" } });
    // Wait for the approval to appear, then approve it like Sam would.
    let id: string | undefined;
    for (let i = 0; i < 50 && !id; i += 1) {
      id = gateway.approvals.pending()[0]?.id;
      if (!id) await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(id);
    gateway.approvals.decide(id, "approved");
    const result = await pending;
    assert.equal(textOf(result), "sent to sam");
    assert.equal(http.state.sends.length, before + 1);
    const push = gateway.pushes.at(-1)!;
    assert.equal(push.title, "Claude (claude-3) wants to run remote__send_message");
    assert.equal(push.clickUrl, `${gateway.url}/approvals/${id}`);
    assert.ok(!JSON.stringify(push).includes("hello"));
    const call = gateway.store.calls({ limit: 1 })[0]!;
    assert.equal(call.decision, "approved");
    assert.equal(call.approvalId, id);
    assert.ok(!call.argsJson?.includes("hush"));
    await client.close();
  });

  it("tells the agent to wait, then runs the call once from await_approval", async () => {
    const client = await legacyClient(gateway, "codex");
    const before = http.state.sends.length;
    const first = await client.callTool({ name: "remote__send_message", arguments: { to: "alex", text: "later" } });
    assert.notEqual(first.isError, true);
    const text = textOf(first);
    const id = /id (ap_[A-Za-z0-9_-]+)/.exec(text)?.[1];
    assert.ok(id, text);
    assert.match(text, /^Waiting for Sam to approve this at http:\/\/127\.0\.0\.1:\d+\/approvals\/ap_/);
    assert.match(text, /Don't try to approve it yourself/);
    assert.equal(http.state.sends.length, before);

    // Still pending: another await just waits and says so again.
    const stillWaiting = await client.callTool({ name: "connectors__await_approval", arguments: { id } });
    assert.match(textOf(stillWaiting), /^Waiting for Sam/);

    // Another agent can't wait on or run it.
    const other = await legacyClient(gateway, "claude-3");
    const stolen = await other.callTool({ name: "connectors__await_approval", arguments: { id } });
    assert.equal(stolen.isError, true);
    assert.match(textOf(stolen), /another agent/);

    // Sam approves on the approval page.
    const page = `${gateway.url}/approvals/${id}`;
    const csrf = await csrfFrom(page);
    const response = await postForm(page, { csrf, action: "approve" });
    assert.equal(response.status, 303);

    const done = await client.callTool({ name: "connectors__await_approval", arguments: { id } });
    assert.equal(textOf(done), "sent to alex");
    const again = await client.callTool({ name: "connectors__await_approval", arguments: { id } });
    assert.equal(textOf(again), "sent to alex");
    assert.equal(http.state.sends.length, before + 1);
    await client.close();
    await other.close();
  });

  it("reports a declined call with Sam's note", async () => {
    const client = await legacyClient(gateway, "codex");
    const first = await client.callTool({ name: "fake__send_message", arguments: { to: "jo", text: "nope" } });
    const id = /id (ap_[A-Za-z0-9_-]+)/.exec(textOf(first))?.[1]!;
    const page = `${gateway.url}/approvals/${id}`;
    await postForm(page, { csrf: await csrfFrom(page), action: "deny", note: "Wrong person" });
    const result = await client.callTool({ name: "connectors__await_approval", arguments: { id } });
    assert.equal(result.isError, true);
    assert.equal(textOf(result), "Sam declined this call. Sam's note: Wrong person");
    assert.ok(!readFileSync(stdioLog, "utf8").includes("send_message"));
    assert.equal(gateway.store.calls({ decision: "declined", limit: 1 })[0]?.approvalId, id);
    await client.close();
  });

  it("explains a missing approval id", async () => {
    const client = await legacyClient(gateway, "codex");
    const result = await client.callTool({ name: "connectors__await_approval", arguments: { id: "ap_doesnotexist" } });
    assert.equal(result.isError, true);
    await client.close();
  });

  it("tells the agent which services it can use", async () => {
    const client = await legacyClient(gateway, "grok");
    const text = textOf(await client.callTool({ name: "connectors_status", arguments: {} }));
    assert.match(text, /You are Grok \(grok\)/);
    assert.match(text, /Fake stdio \(tools start with fake_\): signed in, \d+ tools/);
    assert.ok(!text.includes("Remote (work)"));
    await client.close();
  });

  it("reconnects when an upstream drops its session and retries the call", async () => {
    const client = await legacyClient(gateway, "codex");
    http.dropSessions();
    assert.equal(textOf(await client.callTool({ name: "remote__echo", arguments: { text: "back" } })), "http echo: back");
    await client.close();
  });

  it("keeps serving the others when an upstream goes down", async () => {
    await work.close();
    const client = await legacyClient(gateway, "codex");
    const failed = await client.callTool({ name: "rwork__echo", arguments: { text: "x" } });
    assert.equal(failed.isError, true);
    assert.match(textOf(failed), /Remote \(work\)/);
    await gateway.manager.get("remotework")!.connect();
    assert.equal(gateway.manager.get("remotework")!.state, "error");
    const { tools } = await client.listTools();
    assert.ok(tools.some((tool) => tool.name === "fake__echo"));
    assert.ok(!tools.some((tool) => tool.name.startsWith("rwork__")));
    assert.equal(textOf(await client.callTool({ name: "fake__echo", arguments: { text: "still" } })), "stdio echo: still");
    const health = (await (await fetch(`${gateway.url}/health`)).json()) as Health;
    // Upstream error text stays on the admin page; /health has a fixed message.
    assert.equal(health.upstreams.remotework!.state, "error");
    assert.equal(health.upstreams.remotework!.message, "Not reachable. The admin page has the details.");
    assert.equal(health.upstreams.remotework!.tools, 0);
    await client.close();
  });

  it("shows the call on the admin calls page", async () => {
    const page = await fetch(`${gateway.url}/admin/calls?view=sends`, { headers: adminHeaders() });
    const html = await page.text();
    assert.equal(page.status, 200);
    assert.match(html, /remote__send_message/);
    assert.ok(!html.includes("fake__echo"));
  });
});
