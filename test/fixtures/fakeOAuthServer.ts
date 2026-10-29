// A fake OAuth-protected upstream: a minimal authorization server (metadata,
// dynamic client registration, authorization code with PKCE S256, refresh
// with rotation) and an MCP resource that wants its bearer tokens. Tests can
// expire access tokens or revoke refresh tokens to drive the gateway's
// refresh and "needs sign-in" paths.

import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import { type FakeState, newFakeState, registerFakeTools } from "./fakeTools.ts";

type Client = { client_id: string; redirect_uris: string[] };
type Code = { clientId: string; redirectUri: string; challenge: string; resource?: string; scope?: string };

export type FakeOAuthUpstream = {
  origin: string;
  url: string;
  state: FakeState;
  stats: { registrations: number; codeExchanges: number; refreshes: number; failedRefreshes: number };
  lastAuthorize?: URLSearchParams;
  expireAccessTokens(): void;
  revokeRefreshTokens(): void;
  close(): Promise<void>;
};

function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, { "content-type": "application/json", ...headers }).end(JSON.stringify(body));
}

async function readText(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

const token = () => randomBytes(18).toString("base64url");

export async function startFakeOAuthUpstream(): Promise<FakeOAuthUpstream> {
  const state = newFakeState();
  const clients = new Map<string, Client>();
  const codes = new Map<string, Code>();
  const accessTokens = new Map<string, { expiresAt: number }>();
  const refreshTokens = new Map<string, { clientId: string }>();
  let origin = "";

  const fake: FakeOAuthUpstream = {
    origin: "",
    url: "",
    state,
    stats: { registrations: 0, codeExchanges: 0, refreshes: 0, failedRefreshes: 0 },
    expireAccessTokens() {
      accessTokens.clear();
    },
    revokeRefreshTokens() {
      refreshTokens.clear();
    },
    close: async () => {},
  };

  const issue = (clientId: string) => {
    const access = token();
    const refresh = token();
    accessTokens.set(access, { expiresAt: Date.now() + 3600_000 });
    refreshTokens.set(refresh, { clientId });
    return { access_token: access, token_type: "Bearer", expires_in: 3600, refresh_token: refresh, scope: "read write" };
  };

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", origin);
    const path = url.pathname;
    if (path === "/.well-known/oauth-protected-resource/mcp" || path === "/.well-known/oauth-protected-resource") {
      return json(res, 200, {
        resource: `${origin}/mcp`,
        authorization_servers: [origin],
        scopes_supported: ["read", "write"],
      });
    }
    if (path === "/.well-known/oauth-authorization-server") {
      return json(res, 200, {
        issuer: origin,
        authorization_endpoint: `${origin}/authorize`,
        token_endpoint: `${origin}/token`,
        registration_endpoint: `${origin}/register`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
      });
    }
    if (path === "/register" && req.method === "POST") {
      const metadata = JSON.parse(await readText(req)) as { redirect_uris?: string[] };
      const client: Client = { client_id: `client-${clients.size + 1}`, redirect_uris: metadata.redirect_uris ?? [] };
      clients.set(client.client_id, client);
      fake.stats.registrations += 1;
      return json(res, 201, { ...metadata, client_id: client.client_id, client_id_issued_at: Math.floor(Date.now() / 1000) });
    }
    if (path === "/authorize") {
      const params = url.searchParams;
      fake.lastAuthorize = params;
      const client = clients.get(params.get("client_id") ?? "");
      const redirectUri = params.get("redirect_uri") ?? "";
      if (!client || !client.redirect_uris.includes(redirectUri)) return json(res, 400, { error: "invalid_client" });
      if (params.get("code_challenge_method") !== "S256" || !params.get("code_challenge")) {
        return json(res, 400, { error: "invalid_request", error_description: "PKCE S256 required" });
      }
      const code = token();
      codes.set(code, {
        clientId: client.client_id,
        redirectUri,
        challenge: params.get("code_challenge")!,
        resource: params.get("resource") ?? undefined,
        scope: params.get("scope") ?? undefined,
      });
      const target = new URL(redirectUri);
      target.searchParams.set("code", code);
      if (params.get("state")) target.searchParams.set("state", params.get("state")!);
      res.writeHead(302, { location: target.toString() }).end();
      return;
    }
    if (path === "/token" && req.method === "POST") {
      const form = new URLSearchParams(await readText(req));
      if (form.get("grant_type") === "authorization_code") {
        const code = codes.get(form.get("code") ?? "");
        codes.delete(form.get("code") ?? "");
        const verifier = form.get("code_verifier") ?? "";
        const challenge = createHash("sha256").update(verifier).digest("base64url");
        if (!code || code.challenge !== challenge || code.redirectUri !== form.get("redirect_uri") || code.clientId !== form.get("client_id")) {
          return json(res, 400, { error: "invalid_grant" });
        }
        fake.stats.codeExchanges += 1;
        return json(res, 200, issue(code.clientId));
      }
      if (form.get("grant_type") === "refresh_token") {
        const refresh = refreshTokens.get(form.get("refresh_token") ?? "");
        if (!refresh) {
          fake.stats.failedRefreshes += 1;
          return json(res, 400, { error: "invalid_grant", error_description: "refresh token revoked" });
        }
        refreshTokens.delete(form.get("refresh_token")!);
        fake.stats.refreshes += 1;
        return json(res, 200, issue(refresh.clientId));
      }
      return json(res, 400, { error: "unsupported_grant_type" });
    }
    if (path === "/mcp") {
      const header = req.headers.authorization ?? "";
      const access = header.startsWith("Bearer ") ? accessTokens.get(header.slice(7)) : undefined;
      if (!access || access.expiresAt < Date.now()) {
        return json(res, 401, { error: "invalid_token" }, {
          "www-authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`,
        });
      }
      const body = req.method === "POST" ? JSON.parse((await readText(req)) || "null") : undefined;
      const server = new McpServer({ name: "fake-oauth", version: "1.0.0" });
      registerFakeTools(server, state, { label: "oauth echo" });
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      await server.connect(transport);
      res.on("close", () => {
        void transport.close();
        void server.close();
      });
      await transport.handleRequest(req, res, body);
      return;
    }
    res.writeHead(404).end();
  };

  const http = createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      if (!res.headersSent) res.writeHead(500).end(String(error));
    });
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  fake.origin = origin;
  fake.url = `${origin}/mcp`;
  fake.close = async () => {
    http.closeAllConnections();
    await new Promise<void>((resolve) => http.close(() => resolve()));
  };
  return fake;
}
