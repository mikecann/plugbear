import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { loadSettings, ownerWords, parseSettingsFile, resolveSettings } from "./settings.ts";

describe("settings", () => {
  it("defaults to local mode on 127.0.0.1:8795", () => {
    const settings = resolveSettings({}, {});
    assert.equal(settings.mode, "local");
    assert.equal(settings.host, "127.0.0.1");
    assert.equal(settings.port, 8795);
    assert.equal(settings.publicUrl, "http://127.0.0.1:8795");
    assert.equal(settings.ownerName, "the user");
    assert.equal(settings.launchdLabel, "local.connectors");
    assert.equal(settings.gatewayHost, null);
    // No Sentry unless an install adds its own DSN.
    assert.equal(settings.sentryDsn, null);
    assert.equal(resolveSettings({ sentryDsn: "https://key@o0.ingest.example.com/1" }, {}).sentryDsn, "https://key@o0.ingest.example.com/1");
  });

  it("follows the port in local mode", () => {
    assert.equal(resolveSettings({ port: 9000 }, {}).publicUrl, "http://127.0.0.1:9000");
    assert.equal(resolveSettings({}, { CONNECTORS_PORT: "9001" }).publicUrl, "http://127.0.0.1:9001");
  });

  it("keeps local mode on loopback", () => {
    assert.throws(() => resolveSettings({ host: "0.0.0.0" }, {}), /127\.0\.0\.1 only/);
    assert.throws(() => resolveSettings({ publicUrl: "https://laptop.example.ts.net:8443" }, {}), /loopback address/);
    assert.equal(resolveSettings({ publicUrl: "http://localhost:8795" }, {}).publicUrl, "http://localhost:8795");
  });

  it("needs a public URL in tailscale mode, and lowercases the logins", () => {
    assert.throws(() => resolveSettings({ mode: "tailscale" }, {}), /set publicUrl/);
    const settings = resolveSettings(
      { mode: "tailscale", publicUrl: "https://studio.example.ts.net:8443/", adminLogins: ["Sam@Example.com"], ownerName: "Sam" },
      {},
    );
    assert.equal(settings.publicUrl, "https://studio.example.ts.net:8443");
    assert.deepEqual(settings.adminLogins, ["sam@example.com"]);
    assert.equal(settings.ownerName, "Sam");
  });

  it("lets flags beat the environment and the environment beat the file", () => {
    const file = { mode: "tailscale" as const, publicUrl: "https://a.example.ts.net:8443", adminLogins: ["a@example.com"] };
    const env = { CONNECTORS_PUBLIC_URL: "https://b.example.ts.net:8443", CONNECTORS_ADMIN_LOGINS: "b@example.com, c@example.com" };
    const fromEnv = resolveSettings(file, env);
    assert.equal(fromEnv.publicUrl, "https://b.example.ts.net:8443");
    assert.deepEqual(fromEnv.adminLogins, ["b@example.com", "c@example.com"]);
    const fromFlags = resolveSettings(file, env, { publicUrl: "https://c.example.ts.net:8443", mode: "tailscale" });
    assert.equal(fromFlags.publicUrl, "https://c.example.ts.net:8443");
    // An empty variable counts as unset.
    assert.equal(resolveSettings(file, { CONNECTORS_PUBLIC_URL: "" }).publicUrl, "https://a.example.ts.net:8443");
    assert.equal(resolveSettings({}, { CONNECTORS_MODE: "tailscale", CONNECTORS_PUBLIC_URL: "https://d.example.ts.net" }).mode, "tailscale");
    assert.throws(() => resolveSettings({}, { CONNECTORS_MODE: "public" }), /local or tailscale/);
  });

  it("refuses unknown fields and bad values", () => {
    assert.throws(() => parseSettingsFile({ mode: "public" }), /not valid/);
    assert.throws(() => parseSettingsFile({ adminPassword: "x" }), /not valid/);
    assert.throws(() => parseSettingsFile({ launchdLabel: "has spaces" }), /letters, digits/);
    assert.throws(() => parseSettingsFile({ gatewayHost: "studio; rm -rf ~" }), /ssh host/);
  });

  it("reads settings.json, and a missing one means defaults", () => {
    const dir = mkdtempSync(join(tmpdir(), "connectors-settings-"));
    const path = join(dir, "settings.json");
    assert.equal(loadSettings(path, {}).mode, "local");
    writeFileSync(path, JSON.stringify({ port: 8899, ownerName: "Ana", gatewayHost: "studio" }));
    const settings = loadSettings(path, {});
    assert.equal(settings.port, 8899);
    assert.equal(settings.ownerName, "Ana");
    assert.equal(settings.gatewayHost, "studio");
    writeFileSync(path, "{");
    assert.throws(() => loadSettings(path, {}), /isn't valid JSON/);
  });

  it("words the owner for messages", () => {
    assert.deepEqual(ownerWords(), { name: "the user", Name: "The user", possessive: "the user's" });
    assert.deepEqual(ownerWords("Ana"), { name: "Ana", Name: "Ana", possessive: "Ana's" });
  });
});
