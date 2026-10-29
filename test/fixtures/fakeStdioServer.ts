// A fake stdio upstream: `node test/fixtures/fakeStdioServer.ts`.
// FAKE_LOG_FILE, if set, gets one line per tool call so tests can count.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { newFakeState, registerFakeTools } from "./fakeTools.ts";

const server = new McpServer({ name: "fake-stdio", version: "1.0.0" });
registerFakeTools(server, newFakeState(), { logFile: process.env.FAKE_LOG_FILE, label: "stdio echo" });
process.stderr.write("fake stdio server starting\n");
await server.connect(new StdioServerTransport());
