// CSRF tokens for the admin and approval forms: an HMAC of the Tailscale
// login and the action ("approval:<id>", "connect:<upstream>"), keyed by
// secrets/csrf-key. A page from the owner's browser carries one; a cross-site
// form post can't make one.

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import { readSecretFile, writeSecretFile } from "./secretFiles.ts";

export class Csrf {
  private readonly key: Buffer;

  constructor(key: Buffer) {
    if (key.length < 32) throw new Error("The CSRF key must be at least 32 bytes.");
    this.key = key;
  }

  static fromFile(path: string): Csrf {
    let hex = readSecretFile(path)?.trim();
    if (!hex || !/^[0-9a-f]{64,}$/.test(hex)) {
      hex = randomBytes(32).toString("hex");
      writeSecretFile(path, `${hex}\n`);
    }
    return new Csrf(Buffer.from(hex, "hex"));
  }

  token(login: string, action: string): string {
    return createHmac("sha256", this.key).update(`${login}\n${action}`).digest("base64url");
  }

  check(login: string, action: string, token: unknown): boolean {
    if (typeof token !== "string" || token.length === 0) return false;
    const expected = Buffer.from(this.token(login, action));
    const actual = Buffer.from(token);
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  }
}
