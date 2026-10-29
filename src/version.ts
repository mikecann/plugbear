// esbuild inlines package.json into the bundle, so the version travels with it.
import { readFileSync } from "node:fs";

import pkg from "../package.json" with { type: "json" };

export const VERSION: string = pkg.version;

// scripts/deploy.sh writes release.json next to dist/ in each release, so
// /health can say which build is live and the deploy can wait for it.
function readRelease(): string | null {
  try {
    const parsed = JSON.parse(readFileSync(new URL("../release.json", import.meta.url), "utf8")) as { id?: unknown };
    return typeof parsed.id === "string" ? parsed.id : null;
  } catch {
    return null;
  }
}

export const RELEASE: string | null = readRelease();
