import assert from "node:assert/strict";
import { describe, it, after, before } from "node:test";

import { startFakeHttpUpstream, type FakeHttpUpstream } from "../test/fixtures/fakeHttpServer.ts";
import { BlockedRequestError, checkUrl, createGuardedFetch, guardedLookup, isPrivateAddress } from "./ssrf.ts";

describe("private address check", () => {
  it("blocks private, loopback, link-local, CGNAT and special ranges", () => {
    for (const address of [
      "127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254",
      "100.64.0.1", "100.101.102.103", "0.0.0.0", "224.0.0.1", "255.255.255.255", "198.18.0.1",
      "::1", "::", "fe80::1", "fd7a:115c:a1e0::1", "fc00::1", "ff02::1",
      "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:10.0.0.1", "64:ff9b::a9fe:a9fe", "2002:c0a8:0101::1",
    ]) {
      assert.equal(isPrivateAddress(address), true, address);
    }
  });

  it("allows public addresses", () => {
    for (const address of ["1.1.1.1", "104.18.32.7", "172.32.0.1", "100.128.0.1", "2606:4700::6810:2007", "::ffff:8.8.8.8"]) {
      assert.equal(isPrivateAddress(address), false, address);
    }
  });

  it("refuses anything that isn't an address", () => {
    assert.equal(isPrivateAddress("example.com"), true);
  });
});

describe("URL check", () => {
  it("only allows public https URLs", () => {
    assert.equal(checkUrl("https://mcp.notion.com/mcp").hostname, "mcp.notion.com");
    for (const url of [
      "http://mcp.notion.com/mcp",
      "https://127.0.0.1/mcp",
      "https://[::1]/mcp",
      "https://10.0.0.5/mcp",
      "https://169.254.169.254/latest",
      "https://localhost/mcp",
      "https://studio.local/mcp",
      "https://intranet/mcp",
      "https://user:pass@example.com/",
      "file:///etc/passwd",
    ]) {
      assert.throws(() => checkUrl(url), BlockedRequestError, url);
    }
  });

  it("lets tests use loopback http only when asked", () => {
    assert.throws(() => checkUrl("http://127.0.0.1:9/mcp"), BlockedRequestError);
    assert.equal(checkUrl("http://127.0.0.1:9/mcp", { allowLoopback: true }).port, "9");
    assert.throws(() => checkUrl("http://10.0.0.1/mcp", { allowLoopback: true }), BlockedRequestError);
  });
});

describe("DNS check", () => {
  const lookup = (host: string, allowLoopback = false) =>
    new Promise<unknown>((resolve, reject) =>
      guardedLookup({ allowLoopback })(host, { all: true }, (error, addresses) => (error ? reject(error) : resolve(addresses))),
    );

  it("refuses names that resolve to private addresses", async () => {
    await assert.rejects(lookup("localhost"), /private address/);
  });

  it("allows loopback names in test mode", async () => {
    const addresses = (await lookup("localhost", true)) as { address: string }[];
    assert.ok(addresses.length > 0);
  });
});

describe("guarded fetch", () => {
  let fake: FakeHttpUpstream;
  before(async () => {
    fake = await startFakeHttpUpstream();
  });
  after(async () => {
    await fake.close();
  });

  it("refuses a redirect to a private address", async () => {
    const guarded = createGuardedFetch({ allowLoopback: true });
    await assert.rejects(guarded(`${fake.origin}/redirect-to-private`), BlockedRequestError);
  });

  it("follows a same-origin redirect and keeps the Authorization header", async () => {
    const guarded = createGuardedFetch({ allowLoopback: true });
    const response = await guarded(`${fake.origin}/redirect-to-self`, { headers: { authorization: "Bearer upstream" } });
    assert.equal(await response.text(), "Bearer upstream");
  });

  it("refuses loopback servers outside test mode", async () => {
    const guarded = createGuardedFetch();
    await assert.rejects(guarded(`${fake.origin}/mcp`), BlockedRequestError);
  });
});
