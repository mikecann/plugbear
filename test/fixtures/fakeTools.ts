// Tools shared by the fake upstreams. They're built on the v1 SDK
// (@modelcontextprotocol/sdk) on purpose: the real upstreams (Notion,
// Sentry, DeepWiki) are 2025-era servers, so the fakes are too.

import { appendFileSync } from "node:fs";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

export type FakeState = {
  sends: { to: string; text: string }[];
  calls: string[];
};

export function newFakeState(): FakeState {
  return { sends: [], calls: [] };
}

export const LONG_TOOL_NAME =
  "list.every_single_thing in-the-workspace/including archived items and more";

export function registerFakeTools(
  server: McpServer,
  state: FakeState,
  options: { logFile?: string; label?: string } = {},
): void {
  const record = (name: string) => {
    state.calls.push(name);
    if (options.logFile) appendFileSync(options.logFile, `${name}\n`);
  };

  server.registerTool(
    "echo",
    { description: "Echoes the text back", inputSchema: { text: z.string() } },
    async ({ text }) => {
      record("echo");
      return { content: [{ type: "text", text: `${options.label ?? "echo"}: ${text}` }] };
    },
  );

  server.registerTool(
    "send_message",
    {
      description: "Sends a message to someone",
      inputSchema: { to: z.string(), text: z.string(), api_token: z.string().optional() },
    },
    async ({ to, text }) => {
      record("send_message");
      state.sends.push({ to, text });
      return { content: [{ type: "text", text: `sent to ${to}` }] };
    },
  );

  // Like DeepWiki's tools, these declare an outputSchema and return
  // structuredContent. The policy holds send_report.
  server.registerTool(
    "send_report",
    {
      description: "Sends a report to someone",
      inputSchema: { to: z.string(), title: z.string() },
      outputSchema: { sent: z.boolean(), to: z.string() },
    },
    async ({ to }) => {
      record("send_report");
      state.sends.push({ to, text: "report" });
      return { content: [{ type: "text", text: `report sent to ${to}` }], structuredContent: { sent: true, to } };
    },
  );

  server.registerTool(
    "stats",
    {
      description: "Counts the calls so far",
      inputSchema: {},
      outputSchema: { calls: z.number() },
    },
    async () => {
      record("stats");
      return { content: [{ type: "text", text: `${state.calls.length} calls` }], structuredContent: { calls: state.calls.length } };
    },
  );

  server.registerTool(
    "big",
    { description: "Returns this many bytes of text", inputSchema: { bytes: z.number().int().min(0) } },
    async ({ bytes }) => {
      record("big");
      return { content: [{ type: "text", text: "x".repeat(bytes) }] };
    },
  );

  server.registerTool(
    "update_page",
    { description: "Edits a page", inputSchema: { id: z.string(), body: z.string() } },
    async ({ id }) => {
      record("update_page");
      return { content: [{ type: "text", text: `updated ${id}` }] };
    },
  );

  server.registerTool(
    "delete_page",
    { description: "Deletes a page", inputSchema: { id: z.string() } },
    async ({ id }) => {
      record("delete_page");
      return { content: [{ type: "text", text: `deleted ${id}` }] };
    },
  );

  server.registerTool(
    "fail",
    { description: "Always fails", inputSchema: {} },
    async () => {
      record("fail");
      return { content: [{ type: "text", text: "it failed" }], isError: true };
    },
  );

  server.registerTool(
    "env",
    { description: "Returns an environment variable", inputSchema: { name: z.string() } },
    async ({ name }) => {
      record("env");
      return { content: [{ type: "text", text: process.env[name] ?? "(unset)" }] };
    },
  );

  // The v1 SDK warns about names like this one; that's the point of it.
  const warn = console.warn;
  console.warn = () => {};
  try {
    server.registerTool(
      LONG_TOOL_NAME,
      { description: "A tool with an awkward name", inputSchema: {} },
      async () => {
        record("long");
        return { content: [{ type: "text", text: "long ok" }] };
      },
    );
  } finally {
    console.warn = warn;
  }
}
