// A fake remote upstream speaking session-based Streamable HTTP, like the
// 2025-era servers Notion and Sentry run. Optional static bearer token.

import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { type FakeState, newFakeState, registerFakeTools } from "./fakeTools.ts";

export type FakeHttpUpstream = {
  url: string;
  origin: string;
  state: FakeState;
  // Every Authorization header the fake saw, to prove agent tokens never arrive.
  authHeaders: string[];
  dropSessions(): void;
  addTool(name: string): void;
  close(): Promise<void>;
};

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : undefined;
}

export async function startFakeHttpUpstream(
  options: { bearer?: string; label?: string } = {},
): Promise<FakeHttpUpstream> {
  const state = newFakeState();
  const authHeaders: string[] = [];
  const sessions = new Map<string, { transport: StreamableHTTPServerTransport; server: McpServer }>();

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/redirect-to-private") {
      res.writeHead(302, { location: "http://169.254.169.254/latest/meta-data" }).end();
      return;
    }
    if (url.pathname === "/redirect-to-self") {
      res.writeHead(302, { location: "/mcp-echo-auth" }).end();
      return;
    }
    if (url.pathname === "/mcp-echo-auth") {
      res.writeHead(200, { "content-type": "text/plain" }).end(req.headers.authorization ?? "none");
      return;
    }
    if (url.pathname !== "/mcp") {
      res.writeHead(404).end();
      return;
    }
    if (req.headers.authorization) authHeaders.push(req.headers.authorization);
    if (options.bearer && req.headers.authorization !== `Bearer ${options.bearer}`) {
      res.writeHead(401, { "content-type": "text/plain" }).end("no");
      return;
    }
    const sessionId = req.headers["mcp-session-id"];
    const body = req.method === "POST" ? await readBody(req) : undefined;
    if (typeof sessionId === "string") {
      const session = sessions.get(sessionId);
      if (!session) {
        res.writeHead(404, { "content-type": "application/json" }).end(
          JSON.stringify({ jsonrpc: "2.0", error: { code: -32001, message: "Session not found" }, id: null }),
        );
        return;
      }
      await session.transport.handleRequest(req, res, body);
      return;
    }
    if (req.method === "POST" && isInitializeRequest(body)) {
      const server = new McpServer({ name: "fake-http", version: "1.0.0" });
      registerFakeTools(server, state, { label: options.label ?? "http echo" });
      const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          sessions.set(id, { transport, server });
        },
      });
      transport.onclose = () => {
        if (transport.sessionId) sessions.delete(transport.sessionId);
      };
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
      return;
    }
    res.writeHead(400, { "content-type": "application/json" }).end(
      JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "No session" }, id: null }),
    );
  };

  const http = createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      if (!res.headersSent) res.writeHead(500).end(String(error));
    });
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const { port } = http.address() as AddressInfo;
  const origin = `http://127.0.0.1:${port}`;
  return {
    url: `${origin}/mcp`,
    origin,
    state,
    authHeaders,
    dropSessions() {
      for (const { transport } of sessions.values()) void transport.close();
      sessions.clear();
    },
    addTool(name: string) {
      for (const { server } of sessions.values()) {
        server.registerTool(name, { description: "Added later", inputSchema: { x: z.string().optional() } }, async () => ({
          content: [{ type: "text", text: `${name} ok` }],
        }));
      }
    },
    async close() {
      for (const { transport } of sessions.values()) await transport.close().catch(() => {});
      sessions.clear();
      http.closeAllConnections();
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
}
