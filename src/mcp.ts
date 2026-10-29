// The /mcp endpoint. @modelcontextprotocol/server 2.x serves both the
// stateless 2026-07-28 protocol (Claude Code) and 2025-era clients (Codex,
// Grok, Muse) from one handler: legacy requests get a fresh, sessionless
// instance each time. A new low-level Server per request is cheap because
// tool lists come from the upstream manager's cache.

import {
  createMcpHandler,
  Server,
  type AuthInfo,
  type McpHttpHandler,
} from "@modelcontextprotocol/server";

import type { AgentConfig } from "./config.ts";
import { type Gateway, instructionsFor } from "./gateway.ts";
import { type Logger, silentLogger } from "./log.ts";
import { VERSION } from "./version.ts";

export type Caller = {
  agent: AgentConfig;
  tailscaleLogin: string | null;
};

/** What the HTTP layer hands the MCP handler after checking the token. */
export function callerAuthInfo(caller: Caller): AuthInfo {
  return {
    // The real token stays in the HTTP layer; nothing downstream needs it.
    token: "[verified]",
    clientId: caller.agent.id,
    scopes: [],
    extra: { caller },
  };
}

// Tool arguments over 1 MB are refused (413) before they're parsed. That's
// also the most a held call may carry, and it keeps a burst of big calls from
// exhausting the 384 MB heap.
export const MAX_REQUEST_BODY_BYTES = 1024 * 1024;

export function createMcpEndpoint(gateway: Gateway, log: Logger = silentLogger): McpHttpHandler {
  return createMcpHandler(
    ({ authInfo, era }) => {
      const caller = (authInfo?.extra as { caller?: Caller } | undefined)?.caller;
      if (!caller) throw new Error("MCP request without a verified caller");
      const server = new Server(
        { name: "connectors", title: "Connectors", version: VERSION },
        {
          // 2026-07-28 clients hear about tool changes on a
          // subscriptions/listen stream (Claude Code opens one; Grok 1.0.70
          // doesn't). 2025-era clients are served stateless, with no stream
          // to send it on, so they aren't told.
          capabilities: { tools: era === "modern" ? { listChanged: true } : {} },
          instructions: instructionsFor(caller.agent, gateway.owner, gateway.serviceTitles(caller.agent)),
        },
      );
      server.setRequestHandler("tools/list", async () => ({
        tools: (await gateway.listTools(caller.agent)) as never,
      }));
      server.setRequestHandler("tools/call", async (request, ctx) =>
        (await gateway.callTool(
          { agent: caller.agent, tailscaleLogin: caller.tailscaleLogin, signal: ctx.mcpReq.signal },
          request.params.name,
          request.params.arguments ?? {},
        )) as never,
      );
      return server;
    },
    { onerror: (error) => log.warn(`mcp: ${error.message}`), maxRequestBodySize: MAX_REQUEST_BODY_BYTES },
  );
}
