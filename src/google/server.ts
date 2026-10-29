// The built-in Google MCP server: `node google-mcp.mjs gmail|calendar`,
// started by the gateway as a stdio upstream for each "google" upstream.
// A hand-rolled newline-delimited JSON-RPC loop with no dependencies, so
// the process stays small. It speaks the 2025-era protocol, like
// the other stdio upstreams; the gateway's client falls back to it when
// server/discover gets "method not found".
//
// No secrets here: the gateway sends a fresh access token with each
// tools/call in params._meta (TOKEN_META_KEY). Nothing is logged except
// startup, and never a token or tool arguments.

import { createInterface } from "node:readline";

import {
  AUTH_META_KEY,
  ArgError,
  GoogleApiError,
  TOKEN_META_KEY,
  type ToolDef,
  googleUrls,
} from "./api.ts";
import { calendarTools } from "./calendar.ts";
import { gmailTools } from "./gmail.ts";

const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

type Request = { jsonrpc: "2.0"; id?: string | number | null; method?: string; params?: Record<string, unknown> };

const service = process.argv[2];
const tools: ToolDef[] | undefined =
  service === "gmail" ? gmailTools : service === "calendar" ? calendarTools : undefined;
if (!tools) {
  process.stderr.write("Usage: google-mcp gmail|calendar\n");
  process.exit(2);
}
const urls = googleUrls(process.env.CONNECTORS_GOOGLE_API_BASE);
const byName = new Map(tools.map((tool) => [tool.name, tool]));

function send(message: unknown): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function text(value: string, isError = false, meta?: Record<string, unknown>) {
  return {
    content: [{ type: "text", text: value }],
    ...(isError ? { isError: true } : {}),
    ...(meta ? { _meta: meta } : {}),
  };
}

async function callTool(params: Record<string, unknown>) {
  const name = typeof params.name === "string" ? params.name : "";
  const tool = byName.get(name);
  if (!tool) return text(`Unknown tool: ${name}`, true);
  const meta = (params._meta ?? {}) as Record<string, unknown>;
  const token = meta[TOKEN_META_KEY];
  if (typeof token !== "string" || !token) return text("No Google access token came with this call.", true);
  const raw = params.arguments;
  const args = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  try {
    const value = await tool.run(args, { token, urls });
    return text(typeof value === "string" ? value : JSON.stringify(value, null, 2));
  } catch (error) {
    if (error instanceof ArgError) return text(error.message, true);
    if (error instanceof GoogleApiError) {
      // 401: the token was refused. The gateway refreshes it and tries once more.
      return text(error.message, true, error.status === 401 ? { [AUTH_META_KEY]: "unauthorized" } : undefined);
    }
    return text(`Calling Google failed: ${(error as Error).message}`, true);
  }
}

async function handle(request: Request): Promise<void> {
  // Notifications (no id) need no answer.
  if (request.id === undefined || request.id === null) return;
  const reply = (result: unknown) => send({ jsonrpc: "2.0", id: request.id, result });
  const params = request.params ?? {};
  switch (request.method) {
    case "initialize": {
      const asked = typeof params.protocolVersion === "string" ? params.protocolVersion : "";
      reply({
        protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[1],
        capabilities: { tools: {} },
        serverInfo: { name: `connectors-google-${service}`, version: "1.0.0" },
      });
      return;
    }
    case "ping":
      reply({});
      return;
    case "tools/list":
      reply({
        tools: tools!.map(({ name, title, description, inputSchema, annotations }) => ({
          name,
          title,
          description,
          inputSchema,
          annotations,
        })),
      });
      return;
    case "tools/call":
      reply(await callTool(params));
      return;
    default:
      send({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: `Method not found: ${request.method}` } });
  }
}

const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  if (!line.trim()) return;
  let request: Request;
  try {
    request = JSON.parse(line) as Request;
  } catch {
    send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
    return;
  }
  handle(request).catch((error: unknown) => {
    send({ jsonrpc: "2.0", id: request.id ?? null, error: { code: -32603, message: (error as Error).message } });
  });
});
// The gateway closes stdin to stop us.
lines.on("close", () => process.exit(0));
process.stderr.write(`google ${service} server ready\n`);
