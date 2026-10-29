// Secret files are written whole to a temp file and renamed into place, so
// a crash never leaves half a token file, and they are always 0600.

import { randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve, sep } from "node:path";

export function writeSecretFile(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = join(dirname(path), `.${randomBytes(6).toString("hex")}.tmp`);
  writeFileSync(temp, contents, { mode: 0o600 });
  chmodSync(temp, 0o600);
  renameSync(temp, path);
}

export function readSecretFile(path: string): string | undefined {
  if (!existsSync(path)) return undefined;
  return readFileSync(path, "utf8");
}

export function deleteSecretFile(path: string): void {
  rmSync(path, { force: true });
}

/**
 * Resolves a path config gives relative to secrets/, refusing anything that
 * would land outside it.
 */
export function secretPath(secretsDir: string, relative: string): string {
  const root = resolve(secretsDir);
  const full = resolve(root, relative);
  if (!full.startsWith(root + sep)) {
    throw new Error(`${relative} is outside secrets/`);
  }
  return full;
}
