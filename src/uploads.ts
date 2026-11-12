// Files an agent uploads for an email attachment (POST /uploads), so it
// can attach a screenshot by id instead of typing the file out as base64
// in a tool call, which costs a token per few characters. The gateway
// writes them; the built-in Gmail server and the approval page read them.
// Each is two files in state/uploads: <id>.bin (the bytes) and <id>.json
// (what it is). Nothing here is a secret, but the folder is 0700 anyway,
// and an upload is gone a day after it came in.

import { createHash, randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// One upload, and also every attachment on one email together: Gmail takes
// the whole message as one JSON field, and the Gmail server's heap is small.
export const MAX_ATTACHMENT_BYTES = 3 * 1024 * 1024;
// Long enough for a held send: a day to approve it, an hour to pick it up.
export const UPLOAD_TTL_MS = 26 * 60 * 60 * 1000;
// All uploads together, so a loop can't fill the disk.
export const MAX_UPLOADS_TOTAL_BYTES = 200 * 1024 * 1024;

const ID = /^up_[A-Za-z0-9_-]{22}$/;
// A type/subtype, nothing a header could be built from.
const CONTENT_TYPE = /^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/i;

export type UploadMeta = {
  id: string;
  filename?: string;
  contentType: string;
  size: number;
  sha256: string;
  agent: string;
  createdAt: number;
  expiresAt: number;
};

export class UploadError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "UploadError";
    this.status = status;
  }
}

export const isUploadId = (value: string): boolean => ID.test(value);

/** A file name that's safe to put in a MIME header, or a reason it isn't. */
export function filenameProblem(name: string): string | undefined {
  if (!name.trim()) return "is empty";
  if (name.length > 200) return "is over 200 characters";
  // Control characters, quotes and backslashes would break out of the
  // quoted header value; slashes make it a path.
  if (/[\u0000-\u001f\u007f"\\/]/.test(name)) return "can't contain quotes, slashes, backslashes or control characters";
  return undefined;
}

export function contentTypeOk(value: string): boolean {
  return value.length <= 100 && CONTENT_TYPE.test(value);
}

function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
}

/** Deletes expired uploads (and any half-written pair). Returns the bytes still kept. */
export function sweepUploads(dir: string, now: number): number {
  let kept = 0;
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return 0;
  }
  for (const name of names) {
    const match = /^(up_[A-Za-z0-9_-]{22})\.json$/.exec(name);
    if (!match) continue;
    const meta = readMeta(dir, match[1]!);
    if (meta && meta.expiresAt > now) kept += meta.size;
    else removeUpload(dir, match[1]!);
  }
  // A .bin without its .json is from a write that didn't finish.
  for (const name of names) {
    const match = /^(up_[A-Za-z0-9_-]{22})\.bin$/.exec(name);
    if (match && !names.includes(`${match[1]}.json`)) rmSync(join(dir, name), { force: true });
  }
  return kept;
}

function removeUpload(dir: string, id: string): void {
  rmSync(join(dir, `${id}.json`), { force: true });
  rmSync(join(dir, `${id}.bin`), { force: true });
}

function readMeta(dir: string, id: string): UploadMeta | undefined {
  try {
    const meta = JSON.parse(readFileSync(join(dir, `${id}.json`), "utf8")) as UploadMeta;
    return meta.id === id ? meta : undefined;
  } catch {
    return undefined;
  }
}

export function saveUpload(
  dir: string,
  bytes: Buffer,
  info: { filename?: string; contentType?: string; agent: string },
  now: number,
): UploadMeta {
  if (bytes.length === 0) throw new UploadError(400, "The upload is empty.");
  if (bytes.length > MAX_ATTACHMENT_BYTES) {
    throw new UploadError(413, `The upload is over the ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB limit.`);
  }
  if (info.filename !== undefined) {
    const problem = filenameProblem(info.filename);
    if (problem) throw new UploadError(400, `filename ${problem}.`);
  }
  const contentType = info.contentType?.toLowerCase() || "application/octet-stream";
  if (!contentTypeOk(contentType)) throw new UploadError(400, "Content-Type must be a plain type/subtype, like image/png.");
  ensureDir(dir);
  if (sweepUploads(dir, now) + bytes.length > MAX_UPLOADS_TOTAL_BYTES) {
    throw new UploadError(507, "There are too many uploads waiting. Try again tomorrow, when older ones have gone.");
  }
  const id = `up_${randomBytes(16).toString("base64url")}`;
  const meta: UploadMeta = {
    id,
    ...(info.filename ? { filename: info.filename } : {}),
    contentType,
    size: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    agent: info.agent,
    createdAt: now,
    expiresAt: now + UPLOAD_TTL_MS,
  };
  // The bytes first: an upload only exists once its .json does.
  writeFileSync(join(dir, `${id}.bin`), bytes, { mode: 0o600 });
  writeFileSync(join(dir, `${id}.json`), JSON.stringify(meta), { mode: 0o600 });
  return meta;
}

/** An upload that's still there, or undefined. Never follows anything but a well-formed id. */
export function uploadInfo(dir: string, id: string, now: number): UploadMeta | undefined {
  if (!isUploadId(id)) return undefined;
  const meta = readMeta(dir, id);
  if (!meta || meta.expiresAt <= now) return undefined;
  try {
    if (statSync(join(dir, `${id}.bin`)).size !== meta.size) return undefined;
  } catch {
    return undefined;
  }
  return meta;
}

export function readUpload(dir: string, id: string, now: number): { meta: UploadMeta; bytes: Buffer } | undefined {
  const meta = uploadInfo(dir, id, now);
  if (!meta) return undefined;
  const bytes = readFileSync(join(dir, `${id}.bin`));
  return bytes.length === meta.size ? { meta, bytes } : undefined;
}
