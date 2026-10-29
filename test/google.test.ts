// Gmail and Google Calendar through the built-in Google server, against a
// fake Google: "needs setup" until the OAuth client is in place, sign-in
// stubs and the connect page, one Google sign-in for both upstreams,
// tokens handed to the stdio server per call, refresh, a revoked refresh
// token, and the shipped policy's "ask Sam first" rules.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { CALENDAR_SCOPES, FAKE_CLIENT, FAKE_EMAIL, GMAIL_SCOPES, type FakeGoogle, startFakeGoogle } from "./fixtures/fakeGoogle.ts";
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

const policy = JSON.parse(readFileSync(new URL("../config/policy.example.json", import.meta.url), "utf8")) as unknown;

type Status = { id: string; title: string; state: string; message: string; connectUrl: string; tools: number };

describe("Gmail and Google Calendar", () => {
  let gateway: Gateway;
  let google: FakeGoogle;

  before(async () => {
    google = await startFakeGoogle();
    gateway = await startGateway({
      upstreams: [
        stdioUpstream(),
        { id: "gmail", title: "Gmail (personal)", prefix: "gmail", type: "google", service: "gmail", account: "google" },
        { id: "gcal", title: "Google Calendar (personal)", prefix: "gcal", type: "google", service: "calendar", account: "google" },
      ],
      policy,
      server: { googleEndpoints: google.endpoints, googleApiBase: google.url },
    });
  });

  after(async () => {
    await gateway?.close();
    await google?.close();
  });

  const health = async () =>
    ((await (await fetch(`${gateway.url}/health`)).json()) as { upstreams: Record<string, Status> }).upstreams;
  const tokenFile = () => join(gateway.layout.oauthDir, "google.json");
  const clientFile = () => join(gateway.layout.clientsDir, "google.json");
  const state = (id: string) => gateway.manager.get(id)!.state;

  /** Connect from the deep-link page, through the fake consent screen and back. */
  async function signIn(id = "gmail"): Promise<URL> {
    const csrf = await csrfFrom(`${gateway.url}/admin/connect/${id}`);
    const start = await postForm(`${gateway.url}/admin/upstreams/${id}/connect`, { csrf });
    assert.equal(start.status, 303);
    const authorize = new URL(start.headers.get("location")!);
    const consent = await fetch(authorize, { redirect: "manual" });
    assert.equal(consent.status, 302);
    const done = await fetch(consent.headers.get("location")!, { headers: adminHeaders(), redirect: "manual" });
    assert.equal(done.status, 303);
    assert.equal(done.headers.get("location"), `/admin?connected=${id}`);
    await gateway.manager.get("gmail")!.connect();
    await gateway.manager.get("gcal")!.connect();
    return authorize;
  }

  it("needs setting up until the OAuth client is in place, and starts no server", async () => {
    assert.equal(state("gmail"), "needs_setup");
    assert.equal(state("gcal"), "needs_setup");
    const statuses = await health();
    assert.deepEqual(statuses.gmail, {
      id: "gmail",
      title: "Gmail (personal)",
      state: "needs_setup",
      message: "Needs a Google OAuth client in secrets/clients/google.json.",
      connectUrl: `${gateway.url}/admin/connect/gmail`,
      tools: 0,
    });
    assert.equal(statuses.fake!.state, "connected");
    assert.ok(!gateway.logs.some((line) => line.includes("built-in Google server")));
  });

  it("lists one sign_in stub per signed-out service, in each agent's naming style", async () => {
    const codex = await legacyClient(gateway, "codex");
    const { tools } = await codex.listTools();
    const google = tools.filter((tool) => /^(gmail|gcal)__/.test(tool.name));
    assert.deepEqual(google.map((tool) => tool.name), ["gmail__sign_in", "gcal__sign_in"]);
    assert.match(google[0]!.description!, new RegExp(`Gmail \\(personal\\) isn't set up yet.*${gateway.url}/admin/connect/gmail`));
    const called = await codex.callTool({ name: "gmail__sign_in", arguments: {} });
    assert.equal(called.isError, undefined);
    assert.match(textOf(called), /Ask Sam to open .*\/admin\/connect\/gmail/);
    await codex.close();

    const grok = await modernClient(gateway, "grok");
    const grokTools = (await grok.listTools()).tools.map((tool) => tool.name);
    assert.ok(grokTools.includes("gmail_sign_in") && grokTools.includes("gcal_sign_in"));
    assert.ok(!grokTools.some((name) => name.includes("__")));
    assert.match(textOf(await grok.callTool({ name: "gcal_sign_in", arguments: {} })), /admin\/connect\/gcal/);
    await grok.close();
  });

  it("serves a connect page per service, for Sam's login only", async () => {
    assert.equal((await fetch(`${gateway.url}/admin/connect/gmail`)).status, 403);
    assert.equal(
      (await fetch(`${gateway.url}/admin/connect/gmail`, { headers: { "Tailscale-User-Login": "someone@else.com" } })).status,
      403,
    );
    assert.equal((await fetch(`${gateway.url}/admin/connect/nope`, { headers: adminHeaders() })).status, 404);
    const page = await fetch(`${gateway.url}/admin/connect/gmail`, { headers: adminHeaders() });
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-security-policy") ?? "", /form-action 'self' https:/);
    const html = await page.text();
    assert.match(html, /<h1>Gmail \(personal\)<\/h1>/);
    assert.match(html, /Needs setting up/);
    assert.match(html, /secrets\/clients\/google\.json/);
    assert.match(html, /action="\/admin\/upstreams\/gmail\/connect">\s*<input type="hidden" name="csrf"/);
    assert.ok(!html.includes("—"), "no em dashes");
    // A page for a service without a sign-in still works.
    const fake = await (await fetch(`${gateway.url}/admin/connect/fake`, { headers: adminHeaders() })).text();
    assert.match(fake, /Connected/);
    assert.ok(!fake.includes("/connect\">"));
  });

  it("says what's missing when Connect is pressed without a client", async () => {
    const csrf = await csrfFrom(`${gateway.url}/admin/connect/gmail`);
    const response = await postForm(`${gateway.url}/admin/upstreams/gmail/connect`, { csrf });
    assert.equal(response.status, 303);
    const page = await (await fetch(new URL(response.headers.get("location")!, gateway.url), { headers: adminHeaders() })).text();
    assert.match(page, /Needs a Google OAuth client in secrets\/clients\/google\.json/);
  });

  it("signs in once for both services, with offline access and PKCE", async () => {
    mkdirSync(gateway.layout.clientsDir, { recursive: true, mode: 0o700 });
    // The file Google's console downloads.
    writeFileSync(clientFile(), JSON.stringify({ web: { ...FAKE_CLIENT, redirect_uris: [] } }), { mode: 0o600 });
    await gateway.manager.get("gmail")!.connect();
    assert.equal(state("gmail"), "needs_sign_in");
    assert.equal((await health()).gmail!.state, "signed_out");

    const authorize = await signIn("gmail");
    const params = authorize.searchParams;
    assert.equal(`${authorize.origin}${authorize.pathname}`, google.endpoints.authorize);
    assert.equal(params.get("access_type"), "offline");
    assert.equal(params.get("prompt"), "consent");
    assert.equal(params.get("redirect_uri"), `${gateway.url}/oauth/callback`);
    assert.equal(params.get("code_challenge_method"), "S256");
    assert.ok((params.get("state") ?? "").length >= 32);
    assert.deepEqual(new Set(params.get("scope")!.split(" ")), new Set(["openid", "email", ...GMAIL_SCOPES, ...CALENDAR_SCOPES]));
    assert.equal(google.stats.codeExchanges, 1);

    assert.equal(state("gmail"), "ready");
    assert.equal(state("gcal"), "ready");
    assert.equal(statSync(tokenFile()).mode & 0o777, 0o600);
    const stored = JSON.parse(readFileSync(tokenFile(), "utf8"));
    assert.ok(stored.refreshToken && stored.accessToken);
    assert.equal(stored.email, FAKE_EMAIL);
    assert.equal(stored.codeVerifier, undefined);
    assert.ok(!readFileSync(tokenFile(), "utf8").includes(FAKE_CLIENT.client_secret));

    const statuses = await health();
    assert.equal(statuses.gmail!.state, "connected");
    assert.equal(statuses.gmail!.tools, 6);
    assert.equal(statuses.gcal!.tools, 5);
    // /health is open on the tailnet: no email, no tokens.
    const raw = await (await fetch(`${gateway.url}/health`)).text();
    assert.ok(!raw.includes(FAKE_EMAIL) && !raw.includes(stored.accessToken));

    const page = await (await fetch(`${gateway.url}/admin/connect/gcal`, { headers: adminHeaders() })).text();
    assert.match(page, new RegExp(`Google account</dt><dd>${FAKE_EMAIL}`));
    assert.match(page, /Sign in again/);
  });

  it("lists the Gmail and Calendar tools instead of the stubs", async () => {
    const client = await legacyClient(gateway, "codex");
    const names = (await client.listTools()).tools.map((tool) => tool.name).filter((name) => /^(gmail|gcal)__/.test(name));
    assert.deepEqual(names, [
      "gmail__search_threads",
      "gmail__get_thread",
      "gmail__get_message",
      "gmail__list_labels",
      "gmail__create_draft",
      "gmail__send_message",
      "gcal__list_calendars",
      "gcal__list_events",
      "gcal__get_event",
      "gcal__create_event",
      "gcal__update_event",
    ]);
    // A stale stub name says to list again.
    assert.match(textOf(await client.callTool({ name: "gmail__sign_in", arguments: {} })), /signed in now/);
    await client.close();
  });

  it("reads mail", async () => {
    const client = await legacyClient(gateway, "codex");
    const search = JSON.parse(textOf(await client.callTool({ name: "gmail__search_threads", arguments: { query: "from:ann" } })));
    assert.equal(search.threads[0].threadId, "t1");
    assert.equal(search.threads[0].subject, "Lunch");
    assert.equal(search.threads[0].unread, true);
    const thread = JSON.parse(textOf(await client.callTool({ name: "gmail__get_thread", arguments: { threadId: "t1" } })));
    assert.equal(thread.messages[0].body, "Lunch on Friday?\nAnn");
    assert.deepEqual(thread.messages[0].attachments, [{ filename: "menu.pdf", mimeType: "application/pdf", size: 1234 }]);
    assert.equal(thread.messages[1].body, "Sure & see you then");
    const labels = JSON.parse(textOf(await client.callTool({ name: "gmail__list_labels", arguments: {} })));
    assert.equal(labels.labels[1].name, "Receipts");
    const missing = await client.callTool({ name: "gmail__get_thread", arguments: { threadId: "nope" } });
    assert.equal(missing.isError, true);
    assert.match(textOf(missing), /Google answered 404/);
    const bad = await client.callTool({ name: "gmail__search_threads", arguments: { maxResults: 500 } });
    assert.equal(bad.isError, true);
    assert.match(textOf(bad), /maxResults must be a whole number from 1 to 25/);
    await client.close();
  });

  it("creates drafts straight away but holds a send for Sam", async () => {
    const client = await legacyClient(gateway, "codex");
    const draft = await client.callTool({
      name: "gmail__create_draft",
      arguments: { to: ["ann@example.com"], body: "See you then", replyToMessageId: "m1" },
    });
    assert.equal(draft.isError, undefined, textOf(draft));
    const raw = Buffer.from(google.drafts[0]!.raw, "base64url").toString("utf8");
    assert.match(raw, /^To: ann@example.com\r\nSubject: Re: Lunch\r\nIn-Reply-To: <m1@example.com>\r\nReferences: <m1@example.com>\r\n/);
    assert.equal(google.drafts[0]!.threadId, "t1");

    const send = await client.callTool({
      name: "gmail__send_message",
      arguments: { to: "ann@example.com", subject: "Hi", body: "Hello" },
    });
    assert.match(textOf(send), /Waiting for Sam to approve this/);
    assert.equal(google.sent.length, 0);
    const id = /id (ap_[A-Za-z0-9_-]+)/.exec(textOf(send))![1]!;
    gateway.approvals.decide(id, "approved");
    const result = await client.callTool({ name: "connectors__await_approval", arguments: { id } });
    assert.equal(JSON.parse(textOf(result)).sent, true);
    assert.equal(google.sent.length, 1);
    assert.match(Buffer.from(google.sent[0]!.raw, "base64url").toString("utf8"), /Subject: Hi/);
    await client.close();
  });

  it("asks before calendar changes that reach guests, and not otherwise", async () => {
    const client = await legacyClient(gateway, "codex");
    const events = JSON.parse(
      textOf(await client.callTool({ name: "gcal__list_events", arguments: { query: "plan", timeMin: "2026-11-01T00:00:00Z" } })),
    );
    assert.equal(events.events.length, 2);
    assert.equal(google.eventQueries.at(-1)!.get("q"), "plan");
    assert.equal(google.eventQueries.at(-1)!.get("singleEvents"), "true");

    const solo = await client.callTool({
      name: "gcal__create_event",
      arguments: { summary: "Gym", start: "2026-11-04T07:00:00+08:00", end: "2026-11-04T08:00:00+08:00" },
    });
    assert.equal(JSON.parse(textOf(solo)).summary, "Gym");

    const withGuests = await client.callTool({
      name: "gcal__create_event",
      arguments: { summary: "Coffee", start: "2026-11-05", end: "2026-11-06", attendees: ["ann@example.com"] },
    });
    assert.match(textOf(withGuests), /Waiting for Sam/);

    // e2 has a guest: changing it without naming the attendees is refused...
    const sneaky = await client.callTool({ name: "gcal__update_event", arguments: { eventId: "e2", summary: "Moved" } });
    assert.equal(sneaky.isError, true);
    assert.match(textOf(sneaky), /This event has guests \(ann@example\.com\)/);
    assert.equal(google.patches.length, 0);
    // ...and naming them brings the change to Sam.
    const named = await client.callTool({
      name: "gcal__update_event",
      arguments: { eventId: "e2", summary: "Moved", attendees: ["ann@example.com"] },
    });
    assert.match(textOf(named), /Waiting for Sam/);
    const id = /id (ap_[A-Za-z0-9_-]+)/.exec(textOf(named))![1]!;
    gateway.approvals.decide(id, "approved");
    await client.callTool({ name: "connectors__await_approval", arguments: { id } });
    assert.equal(google.patches.length, 1);
    assert.equal(google.patches[0]!.sendUpdates, "all");
    // Sam's own entry stays on the guest list.
    assert.deepEqual(
      google.patches[0]!.body.attendees!.map((attendee) => attendee.email),
      [FAKE_EMAIL, "ann@example.com"],
    );

    // An event without guests changes straight away.
    const focus = await client.callTool({ name: "gcal__update_event", arguments: { eventId: "e1", summary: "Deep work" } });
    assert.equal(JSON.parse(textOf(focus)).summary, "Deep work");
    assert.equal(google.patches[1]!.sendUpdates, "none");
    await client.close();
  });

  it("refreshes the access token when it expires or Google refuses it", async () => {
    const client = await legacyClient(gateway, "codex");
    const before = google.stats.refreshes;
    google.expireAccessTokens();
    // Expired by Google's clock but not ours: the server gets a 401 and the gateway retries once.
    const first = await client.callTool({ name: "gmail__list_labels", arguments: {} });
    assert.equal(first.isError, undefined, textOf(first));
    assert.equal(google.stats.refreshes, before + 1);

    // Expired by our clock: refreshed before the call, once for parallel calls.
    const file = JSON.parse(readFileSync(tokenFile(), "utf8"));
    writeFileSync(tokenFile(), JSON.stringify({ ...file, expiresAt: 0 }), { mode: 0o600 });
    const results = await Promise.all(
      [1, 2, 3].map(() => client.callTool({ name: "gcal__list_calendars", arguments: {} })),
    );
    for (const result of results) assert.equal(result.isError, undefined, textOf(result));
    assert.equal(google.stats.refreshes, before + 2);
    await client.close();
  });

  it("signs both services out when Google refuses the refresh token, and keeps the others going", async () => {
    google.revokeRefreshTokens();
    const client = await legacyClient(gateway, "codex");
    const result = await client.callTool({ name: "gmail__list_labels", arguments: {} });
    assert.equal(result.isError, true);
    assert.match(textOf(result), /Gmail \(personal\) needs signing in again\. Ask Sam to open .*\/admin\/connect\/gmail/);
    assert.equal(state("gmail"), "needs_sign_in");
    assert.equal(state("gcal"), "needs_sign_in");
    assert.ok(!existsSync(tokenFile()));
    const statuses = await health();
    assert.equal(statuses.gcal!.state, "signed_out");
    assert.equal(statuses.gcal!.message, "Google sign-in expired or was revoked. Connect again.");
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    assert.ok(names.includes("gmail__sign_in") && names.includes("gcal__sign_in"));
    assert.ok(!names.includes("gmail__list_labels"));
    assert.match(
      textOf(await client.callTool({ name: "gcal__sign_in", arguments: {} })),
      /Google Calendar \(personal\) is signed out.*admin\/connect\/gcal/,
    );
    assert.equal(textOf(await client.callTool({ name: "fake__echo", arguments: { text: "ok" } })), "stdio echo: ok");
    await client.close();
  });

  it("keeps a service signed out when Sam doesn't grant its scopes", async () => {
    google.grantOnly = ["openid", "email", ...GMAIL_SCOPES];
    try {
      await signIn("gcal");
    } finally {
      google.grantOnly = undefined;
    }
    assert.equal(state("gmail"), "ready");
    assert.equal(state("gcal"), "needs_sign_in");
    assert.equal((await health()).gcal!.message, "Google didn't grant access to Google Calendar. Connect again and allow it.");
  });

  it("signs both out on Disconnect, and goes back to needing setup without the client", async () => {
    await signIn("gcal");
    assert.equal(state("gcal"), "ready");
    const csrf = /action="\/admin\/upstreams\/gcal\/disconnect">\s*<input type="hidden" name="csrf" value="([^"]+)"/.exec(
      await (await fetch(`${gateway.url}/admin/connect/gcal`, { headers: adminHeaders() })).text(),
    )![1]!;
    assert.equal((await postForm(`${gateway.url}/admin/upstreams/gcal/disconnect`, { csrf })).status, 303);
    assert.equal(state("gmail"), "needs_sign_in");
    assert.equal(state("gcal"), "needs_sign_in");
    assert.ok(!existsSync(tokenFile()));

    rmSync(clientFile());
    await gateway.manager.get("gmail")!.connect();
    assert.equal(state("gmail"), "needs_setup");
  });
});
