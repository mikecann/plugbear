// Optional push for pending approvals via ntfy. The topic is a secret (it's
// the only thing between a stranger and the owner's phone), so it lives in
// secrets/ntfy-topic and is never logged. The push carries a title and a
// link only: never the call's arguments.

import { type Logger, errorMessage, silentLogger } from "./log.ts";
import { readSecretFile } from "./secretFiles.ts";

export const NTFY_URL = "https://ntfy.sh/";

export type Notifier = (message: { title: string; clickUrl: string }) => Promise<void>;

export function createNtfyNotifier(options: {
  topicFile: string;
  fetch?: typeof fetch;
  log?: Logger;
}): Notifier {
  const log = options.log ?? silentLogger;
  const doFetch = options.fetch ?? fetch;
  return async ({ title, clickUrl }) => {
    const topic = readSecretFile(options.topicFile)?.trim();
    if (!topic) return;
    try {
      // JSON publishing keeps non-ASCII titles out of HTTP headers.
      const response = await doFetch(NTFY_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          topic,
          title,
          message: "Open it to approve or deny.",
          click: clickUrl,
          tags: ["raised_hand"],
        }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) log.warn(`ntfy push failed with HTTP ${response.status}`);
      await response.body?.cancel();
    } catch (error) {
      log.warn(`ntfy push failed: ${errorMessage(error)}`);
    }
  };
}
