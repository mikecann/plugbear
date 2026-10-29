// Upstream sign-in against a fake OAuth-protected MCP server: Connect from
// the admin page, the provider redirect, the callback, using the tokens,
// refreshing them, "needs sign-in" when refresh fails, and Disconnect.

import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { startFakeOAuthUpstream, type FakeOAuthUpstream } from "./fixtures/fakeOAuthServer.ts";
import {
  type Gateway,
  adminHeaders,
  csrfFrom,
  legacyClient,
  postForm,
  startGateway,
  stdioUpstream,
  textOf,
} from "./helpers.ts";

describe("upstream OAuth sign-in", () => {
  let gateway: Gateway;
  let fake: FakeOAuthUpstream;

  before(async () => {
    fake = await startFakeOAuthUpstream();
    gateway = await startGateway({
      upstreams: [
        stdioUpstream(),
        {
          id: "secure",
          title: "Secure service",
          prefix: "secure",
          type: "http",
          url: fake.url,
          auth: { type: "oauth" },
          scopes: ["read", "write"],
        },
      ],
    });
  });

  after(async () => {
    await gateway?.close();
    await fake?.close();
  });

  const tokenFile = () => join(gateway.layout.oauthDir, "secure.json");

  it("starts as needs sign-in and lists only a sign_in stub for it", async () => {
    assert.equal(gateway.manager.get("secure")?.state, "needs_sign_in");
    const client = await legacyClient(gateway, "codex");
    const { tools } = await client.listTools();
    assert.deepEqual(
      tools.filter((tool) => tool.name.startsWith("secure__")).map((tool) => tool.name),
      ["secure__sign_in"],
    );
    assert.ok(tools.some((tool) => tool.name === "fake__echo"));
    const status = textOf(await client.callTool({ name: "connectors__status", arguments: {} }));
    assert.match(status, new RegExp(`Secure service .*needs sign-in. Ask Sam to open ${gateway.url}/admin/connect/secure`));
    await client.close();
  });

  it("only starts a sign-in from the admin page with a CSRF token, over Tailscale", async () => {
    const path = `${gateway.url}/admin/upstreams/secure/connect`;
    assert.equal((await postForm(path, {}, {})).status, 403);
    assert.equal((await postForm(path, { csrf: "forged" })).status, 403);
    const csrf = await csrfFrom(`${gateway.url}/admin`);
    assert.equal(
      (await postForm(path, { csrf }, adminHeaders({ origin: "https://evil.example" }))).status,
      403,
    );
    assert.equal(
      (await postForm(path, { csrf }, adminHeaders({ "sec-fetch-site": "cross-site" }))).status,
      403,
    );
  });

  it("signs in through Connect, the provider and the callback", async () => {
    // The admin page has one form per action; the first is Connect for "secure".
    const adminHtml = await (await fetch(`${gateway.url}/admin`, { headers: adminHeaders() })).text();
    const csrf = /action="\/admin\/upstreams\/secure\/connect">\s*<input type="hidden" name="csrf" value="([^"]+)"/.exec(adminHtml)?.[1];
    assert.ok(csrf, "connect form");
    const start = await postForm(`${gateway.url}/admin/upstreams/secure/connect`, { csrf });
    assert.equal(start.status, 303);
    const authorizeUrl = new URL(start.headers.get("location")!);
    assert.equal(authorizeUrl.origin, fake.origin);
    assert.equal(authorizeUrl.pathname, "/authorize");
    assert.equal(authorizeUrl.searchParams.get("redirect_uri"), `${gateway.url}/oauth/callback`);
    assert.equal(authorizeUrl.searchParams.get("code_challenge_method"), "S256");
    assert.equal(authorizeUrl.searchParams.get("resource"), fake.url);
    assert.equal(authorizeUrl.searchParams.get("scope"), "read write");
    const state = authorizeUrl.searchParams.get("state");
    assert.ok(state && state.length >= 32);
    assert.equal(fake.stats.registrations, 1);

    // Sam's browser follows the provider back to the callback.
    const approve = await fetch(authorizeUrl, { redirect: "manual" });
    assert.equal(approve.status, 302);
    const callback = new URL(approve.headers.get("location")!);
    assert.equal(`${callback.origin}${callback.pathname}`, `${gateway.url}/oauth/callback`);

    // Without the Tailscale header the callback is refused.
    assert.equal((await fetch(callback, { redirect: "manual" })).status, 403);

    const done = await fetch(callback, { headers: adminHeaders(), redirect: "manual" });
    assert.equal(done.status, 303);
    assert.equal(done.headers.get("location"), "/admin?connected=secure");
    assert.equal(gateway.manager.get("secure")?.state, "ready");
    assert.equal(fake.stats.codeExchanges, 1);

    // The state is single use.
    const replay = await fetch(callback, { headers: adminHeaders(), redirect: "manual" });
    assert.equal(replay.status, 400);

    // Tokens are stored by issuer in a 0600 file.
    assert.equal(statSync(tokenFile()).mode & 0o777, 0o600);
    const stored = JSON.parse(readFileSync(tokenFile(), "utf8"));
    assert.equal(stored.currentIssuer, fake.origin);
    assert.ok(stored.tokens[fake.origin].access_token);
    assert.ok(stored.clients[fake.origin].client_id);

    const page = await (await fetch(`${gateway.url}/admin?connected=secure`, { headers: adminHeaders() })).text();
    assert.match(page, /Signed in to Secure service\./);
  });

  it("uses the upstream once signed in", async () => {
    const client = await legacyClient(gateway, "codex");
    const { tools } = await client.listTools();
    assert.ok(tools.some((tool) => tool.name === "secure__echo"));
    assert.equal(textOf(await client.callTool({ name: "secure__echo", arguments: { text: "hi" } })), "oauth echo: hi");
    await client.close();
  });

  it("refreshes an expired access token by itself", async () => {
    fake.expireAccessTokens();
    const client = await legacyClient(gateway, "codex");
    assert.equal(textOf(await client.callTool({ name: "secure__echo", arguments: { text: "again" } })), "oauth echo: again");
    assert.equal(fake.stats.refreshes, 1);
    assert.equal(gateway.manager.get("secure")?.state, "ready");
    await client.close();
  });

  it("stays signed in when parallel calls find the access token expired", async () => {
    // The fake's refresh tokens are single use, like a provider that rotates
    // them. Spending one twice would sign the upstream out.
    fake.expireAccessTokens();
    const refreshes = fake.stats.refreshes;
    const failed = fake.stats.failedRefreshes;
    const agents = [
      { id: "codex", tool: "secure__echo" },
      { id: "claude-3", tool: "secure__echo" },
      { id: "grok", tool: "secure_echo" },
      { id: "codex", tool: "secure__echo" },
    ];
    const clients = await Promise.all(agents.map((agent) => legacyClient(gateway, agent.id)));
    const results = await Promise.all(
      clients.map((client, index) => client.callTool({ name: agents[index]!.tool, arguments: { text: `p${index}` } })),
    );
    results.forEach((result, index) => assert.equal(textOf(result), `oauth echo: p${index}`));
    // Calls whose 401 came while a refresh ran waited for it. One whose 401
    // came after may refresh again, from the new refresh token; none reuses
    // a spent one.
    assert.ok(fake.stats.refreshes - refreshes >= 1);
    assert.equal(fake.stats.failedRefreshes - failed, 0);
    assert.equal(gateway.manager.get("secure")?.state, "ready");
    await Promise.all(clients.map((client) => client.close()));
  });

  it("marks the upstream as needing sign-in when refresh fails, and keeps the others going", async () => {
    fake.expireAccessTokens();
    fake.revokeRefreshTokens();
    const client = await legacyClient(gateway, "codex");
    const result = await client.callTool({ name: "secure__echo", arguments: { text: "x" } });
    assert.equal(result.isError, true);
    assert.match(textOf(result), /Secure service needs signing in again\. Ask Sam to open .*\/admin\/connect\/secure and sign in/);
    assert.equal(gateway.manager.get("secure")?.state, "needs_sign_in");
    const { tools } = await client.listTools();
    assert.deepEqual(
      tools.filter((tool) => tool.name.startsWith("secure__")).map((tool) => tool.name),
      ["secure__sign_in"],
    );
    assert.equal(textOf(await client.callTool({ name: "fake__echo", arguments: { text: "ok" } })), "stdio echo: ok");
    await client.close();
  });

  it("forgets tokens on Disconnect but keeps the client registration", async () => {
    // Sign in again first, reusing the registration.
    const csrf = await csrfFrom(`${gateway.url}/admin`);
    const adminHtml = await (await fetch(`${gateway.url}/admin`, { headers: adminHeaders() })).text();
    const connectCsrf = /action="\/admin\/upstreams\/secure\/connect">\s*<input type="hidden" name="csrf" value="([^"]+)"/.exec(adminHtml)![1]!;
    assert.ok(csrf);
    const start = await postForm(`${gateway.url}/admin/upstreams/secure/connect`, { csrf: connectCsrf });
    const approve = await fetch(start.headers.get("location")!, { redirect: "manual" });
    await fetch(approve.headers.get("location")!, { headers: adminHeaders(), redirect: "manual" });
    assert.equal(gateway.manager.get("secure")?.state, "ready");
    assert.equal(fake.stats.registrations, 1);

    const disconnectCsrf = /action="\/admin\/upstreams\/secure\/disconnect">\s*<input type="hidden" name="csrf" value="([^"]+)"/.exec(
      await (await fetch(`${gateway.url}/admin/connect/secure`, { headers: adminHeaders() })).text(),
    )![1]!;
    const response = await postForm(`${gateway.url}/admin/upstreams/secure/disconnect`, { csrf: disconnectCsrf });
    assert.equal(response.status, 303);
    assert.equal(gateway.manager.get("secure")?.state, "needs_sign_in");
    assert.ok(existsSync(tokenFile()));
    const stored = JSON.parse(readFileSync(tokenFile(), "utf8"));
    assert.equal(stored.tokens, undefined);
    assert.ok(stored.clients[fake.origin]);
  });

  it("refuses an unknown or expired sign-in state", async () => {
    const response = await fetch(`${gateway.url}/oauth/callback?code=x&state=made-up`, {
      headers: adminHeaders(),
      redirect: "manual",
    });
    assert.equal(response.status, 400);
    assert.match(await response.text(), /expired or was already used/);
  });
});
