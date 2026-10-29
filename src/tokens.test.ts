import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  TokenExistsError,
  TokenStore,
  generateToken,
  hashToken,
  issueToken,
  parseToken,
  readAgentSecrets,
  removeToken,
  verifyToken,
} from "./tokens.ts";

function tempFile(): string {
  return join(mkdtempSync(join(tmpdir(), "connectors-tokens-")), "secrets", "agents.json");
}

describe("agent tokens", () => {
  it("look like cn_<agent>_<64 hex>", () => {
    const token = generateToken("claude-3");
    assert.match(token, /^cn_claude-3_[0-9a-f]{64}$/);
    assert.deepEqual(parseToken(token), { agentId: "claude-3" });
    assert.equal(parseToken("cn_claude-3_short"), null);
    assert.equal(parseToken("Bearer x"), null);
    assert.notEqual(generateToken("codex"), generateToken("codex"));
  });

  it("store only a hash, in a 0600 file", () => {
    const path = tempFile();
    const token = issueToken(path, "codex", { rotate: false });
    const text = readFileSync(path, "utf8");
    assert.ok(!text.includes(token));
    assert.ok(text.includes(hashToken(token)));
    assert.equal(statSync(path).mode & 0o777, 0o600);
  });

  it("verify by hash and reject everything else", () => {
    const path = tempFile();
    const token = issueToken(path, "codex", { rotate: false });
    const secrets = readAgentSecrets(path);
    assert.equal(verifyToken(secrets, token), "codex");
    assert.equal(verifyToken(secrets, token.replace(/.$/, (c) => (c === "0" ? "1" : "0"))), null);
    // Right shape, wrong agent: the hash is looked up under the claimed agent.
    assert.equal(verifyToken(secrets, token.replace("cn_codex_", "cn_grok_")), null);
    assert.equal(verifyToken(secrets, ""), null);
    assert.equal(verifyToken(secrets, "cn_codex_"), null);
  });

  it("refuse to add twice, and rotate replaces the old token", () => {
    const path = tempFile();
    const first = issueToken(path, "muse", { rotate: false });
    assert.throws(() => issueToken(path, "muse", { rotate: false }), TokenExistsError);
    assert.throws(() => issueToken(path, "grok", { rotate: true }), /no token yet/);
    const second = issueToken(path, "muse", { rotate: true });
    const secrets = readAgentSecrets(path);
    assert.equal(verifyToken(secrets, first), null);
    assert.equal(verifyToken(secrets, second), "muse");
    assert.ok(secrets.agents.muse?.rotatedAt);
  });

  it("can be removed", () => {
    const path = tempFile();
    const token = issueToken(path, "grok", { rotate: false });
    assert.equal(removeToken(path, "grok"), true);
    assert.equal(removeToken(path, "grok"), false);
    assert.equal(verifyToken(readAgentSecrets(path), token), null);
  });

  it("are picked up by a running server without a restart", () => {
    const path = tempFile();
    const store = new TokenStore(path);
    assert.equal(store.has("codex"), false);
    const token = issueToken(path, "codex", { rotate: false });
    assert.equal(store.verify(token), "codex");
    const rotated = issueToken(path, "codex", { rotate: true });
    assert.equal(store.verify(token), null);
    assert.equal(store.verify(rotated), "codex");
  });
});
