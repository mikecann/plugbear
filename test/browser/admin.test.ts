// The admin and approval pages in a real (headless) Chromium, which applies
// the pages' CSP the way Sam's browser does. fetch() doesn't, which is how
// a form-action that blocked every Connect got past the other tests.
//
//   npm run test:browser
//
// Needs Playwright's headless Chromium. If it isn't installed, the tests
// skip; `npx playwright-core install chromium-headless-shell` gets it.

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { type Browser, type BrowserContext, chromium } from "playwright-core";

import { startFakeOAuthUpstream, type FakeOAuthUpstream } from "../fixtures/fakeOAuthServer.ts";
import { type Gateway, LOGIN, legacyClient, startGateway, stdioUpstream, textOf } from "../helpers.ts";

async function launch(): Promise<Browser | undefined> {
  try {
    return await chromium.launch();
  } catch (error) {
    process.stderr.write(`Skipping browser tests: ${(error as Error).message.split("\n")[0]}\n`);
    return undefined;
  }
}

describe("admin pages in a browser", () => {
  let gateway: Gateway;
  let fake: FakeOAuthUpstream;
  let browser: Browser | undefined;
  let context: BrowserContext;
  const problems: string[] = [];

  before(async () => {
    fake = await startFakeOAuthUpstream();
    gateway = await startGateway({
      upstreams: [
        stdioUpstream(),
        { id: "secure", title: "Secure service", prefix: "secure", type: "http", url: fake.url, auth: { type: "oauth" } },
      ],
      holdMs: 50,
    });
    browser = await launch();
    if (!browser) return;
    // tailscale serve adds this header to every request it forwards.
    context = await browser.newContext({ extraHTTPHeaders: { "Tailscale-User-Login": LOGIN } });
    context.on("console", (message) => {
      if (message.type() === "error") problems.push(message.text());
    });
    context.on("requestfailed", (request) => problems.push(`${request.url()} ${request.failure()?.errorText}`));
  });

  after(async () => {
    await browser?.close();
    await gateway?.close();
    await fake?.close();
  });

  it("signs in to a service with Connect, through the provider and back", async (t) => {
    if (!browser) return t.skip("no headless Chromium");
    const page = await context.newPage();
    await page.goto(`${gateway.url}/admin`);
    // Each service's status is a dot whose title says it.
    assert.equal(await page.locator(".dot.needs_sign_in[title]").first().getAttribute("title"), "Needs sign-in");
    await Promise.all([
      page.waitForURL(`${gateway.url}/admin?connected=secure`, { timeout: 10_000 }),
      page.locator('form[action="/admin/upstreams/secure/connect"] button').click(),
    ]);
    assert.deepEqual(problems, []);
    assert.equal(await page.locator(".flash").textContent(), "Signed in to Secure service.");
    assert.equal(gateway.manager.get("secure")?.state, "ready");
    assert.equal(fake.stats.codeExchanges, 1);
    await page.close();
  });

  it("approves a held call from the approval page", async (t) => {
    if (!browser) return t.skip("no headless Chromium");
    const client = await legacyClient(gateway, "codex");
    const held = await client.callTool({ name: "fake__send_message", arguments: { to: "kim", text: "hello" } });
    const id = /id (ap_[A-Za-z0-9_-]+)/.exec(textOf(held))![1]!;
    const page = await context.newPage();
    await page.goto(`${gateway.url}/approvals/${id}`);
    assert.match((await page.locator("pre").textContent()) ?? "", /"to": "kim"/);
    await Promise.all([page.waitForLoadState("load"), page.getByRole("button", { name: "Approve" }).click()]);
    await page.waitForURL(`${gateway.url}/approvals/${id}`);
    assert.match((await page.locator("dd").first().textContent()) ?? "", /Approved\. It runs if the agent picks it up by/);
    assert.deepEqual(problems, []);
    const done = await client.callTool({ name: "connectors__await_approval", arguments: { id } });
    assert.equal(textOf(done), "sent to kim");
    await page.close();
    await client.close();
  });
});
