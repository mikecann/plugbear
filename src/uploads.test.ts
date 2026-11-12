import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import {
  MAX_ATTACHMENT_BYTES,
  UPLOAD_TTL_MS,
  UploadError,
  readUpload,
  saveUpload,
  sweepUploads,
  uploadInfo,
} from "./uploads.ts";

describe("uploads", () => {
  let root: string;
  let dir: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "connectors-uploads-"));
    dir = join(root, "uploads");
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("keeps an upload privately for a day, then sweeps it", () => {
    const meta = saveUpload(dir, Buffer.from("hello"), { filename: "a.txt", contentType: "Text/Plain", agent: "codex" }, 1_000);
    assert.match(meta.id, /^up_[A-Za-z0-9_-]{22}$/);
    assert.equal(meta.contentType, "text/plain");
    assert.equal(statSync(dir).mode & 0o777, 0o700);
    assert.equal(statSync(join(dir, `${meta.id}.bin`)).mode & 0o777, 0o600);
    assert.equal(readUpload(dir, meta.id, 2_000)!.bytes.toString(), "hello");
    assert.equal(readUpload(dir, meta.id, 1_000 + UPLOAD_TTL_MS), undefined);
    assert.equal(sweepUploads(dir, 1_000 + UPLOAD_TTL_MS), 0);
    assert.deepEqual(readdirSync(dir), []);
  });

  it("only reads well-formed ids, never a path", () => {
    assert.equal(uploadInfo(dir, "../secrets/agents", 0), undefined);
    assert.equal(uploadInfo(dir, "up_../../../../etc/passwd", 0), undefined);
  });

  it("refuses empty, oversized and oddly named uploads", () => {
    const code = (fn: () => unknown) => {
      try {
        fn();
      } catch (error) {
        return (error as UploadError).status;
      }
      return 0;
    };
    assert.equal(code(() => saveUpload(dir, Buffer.alloc(0), { agent: "a" }, 0)), 400);
    assert.equal(code(() => saveUpload(dir, Buffer.alloc(MAX_ATTACHMENT_BYTES + 1), { agent: "a" }, 0)), 413);
    assert.equal(code(() => saveUpload(dir, Buffer.from("x"), { agent: "a", filename: "../x" }, 0)), 400);
    assert.equal(code(() => saveUpload(dir, Buffer.from("x"), { agent: "a", contentType: "text/html\r\nX: y" }, 0)), 400);
  });

  it("drops a half-written upload", () => {
    saveUpload(dir, Buffer.from("x"), { agent: "a" }, 0);
    writeFileSync(join(dir, "up_aaaaaaaaaaaaaaaaaaaaaa.bin"), "partial");
    assert.equal(sweepUploads(dir, 1), 1);
    assert.equal(readdirSync(dir).length, 2);
  });
});
