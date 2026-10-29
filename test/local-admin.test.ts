// Local mode: the admin pages answer on this Mac's loopback address only,
// with the expected Host header, for a browser holding the sign-in cookie
// from `connectors open`. Tailscale's login header means nothing here.

import assert from "node:assert/strict";
import { request } from "node:http";
import { after, before, describe, it } from "node:test";

import { AdminSessions } from "../src/http.ts";
import { type Gateway, legacyClient, startGateway, stdioUpstream, textOf } from "./helpers.ts";

/** A raw request, so the test can send any Host header. */
function rawGet(url: string, headers: Record<string, string>): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(url, { headers }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => (body += chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

describe("local mode admin pages", () => {
  let gateway: Gateway;
  let approvalId: string;
  let cookie: string;
  const port = () => new URL(gateway.url).port;

  const signIn = async (next = "/admin") => {
    const code = AdminSessions.createCode(gateway.store);
    return fetch(`${gateway.url}/admin/login?code=${code}&next=${encodeURIComponent(next)}`, { redirect: "manual" });
  };
  const get = (path: string, headers: Record<string, string> = {}) =>
    fetch(`${gateway.url}${path}`, { headers: { cookie, ...headers }, redirect: "manual" });
  const post = (path: string, fields: Record<string, string>, headers: Record<string, string> = {}) =>
    fetch(`${gateway.url}${path}`, {
      method: "POST",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded", ...headers },
      body: new URLSearchParams(fields).toString(),
      redirect: "manual",
    });
  const csrfOn = async (path: string) => /name="csrf" value="([^"]+)"/.exec(await (await get(path)).text())![1]!;

  before(async () => {
    // No owner name: agents say "the user".
    gateway = await startGateway({ upstreams: [stdioUpstream()], holdMs: 50, server: { mode: "local", ownerName: undefined } });
    const client = await legacyClient(gateway, "codex");
    const held = await client.callTool({ name: "fake__send_message", arguments: { to: "ana", text: "hi" } });
    approvalId = /id (ap_[A-Za-z0-9_-]+)/.exec(textOf(held))![1]!;
    assert.match(textOf(held), new RegExp(`^Waiting for the user to approve this at ${gateway.url}/approvals/ap_`));
    await client.close();
  });

  after(async () => {
    await gateway?.close();
  });

  it("asks a browser without the cookie to open the page from Terminal", async () => {
    for (const path of ["/admin", "/admin/calls", `/approvals/${approvalId}`, "/admin/connect/fake", "/oauth/callback?state=x"]) {
      const response = await fetch(`${gateway.url}${path}`);
      assert.equal(response.status, 401, path);
      assert.match(await response.text(), /connectors open/);
    }
    const page = await (await fetch(`${gateway.url}/approvals/${approvalId}`)).text();
    assert.match(page, new RegExp(`connectors open /approvals/${approvalId}`));
  });

  it("ignores the Tailscale login header", async () => {
    const response = await fetch(`${gateway.url}/admin`, { headers: { "Tailscale-User-Login": "sam@example.com" } });
    assert.equal(response.status, 401);
  });

  it("swaps a one-time code for a long-lived, HttpOnly, Lax cookie", async () => {
    const response = await signIn(`/approvals/${approvalId}`);
    assert.equal(response.status, 303);
    assert.equal(response.headers.get("location"), `/approvals/${approvalId}`);
    assert.equal(response.headers.get("referrer-policy"), "no-referrer");
    const setCookie = response.headers.get("set-cookie") ?? "";
    assert.match(setCookie, new RegExp(`^connectors_admin_${port()}=`));
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /SameSite=Lax/);
    assert.match(setCookie, /Max-Age=31536000/);
    cookie = setCookie.split(";")[0]!;
    const page = await get(`/approvals/${approvalId}`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Codex wants to run fake__send_message/);
  });

  it("refuses a used, made-up or expired code", async () => {
    const code = AdminSessions.createCode(gateway.store);
    assert.equal((await fetch(`${gateway.url}/admin/login?code=${code}`, { redirect: "manual" })).status, 303);
    assert.equal((await fetch(`${gateway.url}/admin/login?code=${code}`, { redirect: "manual" })).status, 403);
    assert.equal((await fetch(`${gateway.url}/admin/login?code=made-up`, { redirect: "manual" })).status, 403);
    const old = AdminSessions.createCode(gateway.store, Date.now() - 3 * 60_000);
    assert.equal((await fetch(`${gateway.url}/admin/login?code=${old}`, { redirect: "manual" })).status, 403);
    // A wrong cookie gets nowhere.
    assert.equal((await fetch(`${gateway.url}/admin`, { headers: { cookie: `connectors_admin_${port()}=nope` } })).status, 401);
  });

  it("only sends the browser on to its own admin pages", async () => {
    for (const next of ["https://evil.example/", "//evil.example/admin", "/\\evil.example", "/health"]) {
      const response = await signIn(next);
      assert.equal(response.headers.get("location"), "/admin", next);
    }
  });

  it("refuses another Host, so a DNS-rebinding page can't read or post", async () => {
    const evil = await rawGet(`${gateway.url}/admin`, { host: `evil.example:${port()}`, cookie });
    assert.equal(evil.status, 403);
    assert.match(evil.body, /only answer at/);
    const code = AdminSessions.createCode(gateway.store);
    const login = await rawGet(`${gateway.url}/admin/login?code=${code}`, { host: "evil.example" });
    assert.equal(login.status, 403);
    const localhost = await rawGet(`${gateway.url}/admin`, { host: `localhost:${port()}`, cookie });
    assert.equal(localhost.status, 200);
  });

  it("refuses posts from other origins, even other ports on 127.0.0.1", async () => {
    const page = `/approvals/${approvalId}`;
    const csrf = await csrfOn(page);
    assert.equal((await post(page, { action: "approve", csrf }, { origin: "http://127.0.0.1:3000" })).status, 403);
    assert.equal((await post(page, { action: "approve", csrf }, { "sec-fetch-site": "same-site" })).status, 403);
    assert.equal((await post(page, { action: "approve" })).status, 403);
    assert.equal(gateway.approvals.get(approvalId)?.status, "pending");
    const ok = await post(page, { action: "approve", csrf }, { origin: gateway.url, "sec-fetch-site": "same-origin" });
    assert.equal(ok.status, 303);
    assert.equal(gateway.approvals.get(approvalId)?.status, "approved");
  });

  it("doesn't record a Tailscale login for calls", async () => {
    const client = await legacyClient(gateway, "codex");
    await client.callTool({ name: "fake__echo", arguments: { text: "local" } });
    await client.close();
    const call = gateway.store.calls({ agent: "codex", limit: 1 })[0]!;
    assert.equal(call.tool, "fake__echo");
    assert.equal(call.tailscaleLogin, null);
  });
});
