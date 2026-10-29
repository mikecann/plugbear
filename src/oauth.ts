// The gateway is an OAuth *client* of each upstream (never a server). This
// provider keeps one upstream's client registration, tokens, PKCE verifier
// and discovery state in secrets/oauth/<id>.json (0600), with clients and
// tokens keyed by the authorization server's issuer.
//
// Client order: a static client from secrets/clients/<id>.json when the
// upstream says auth.client = "static"; otherwise dynamic client
// registration. Client ID metadata documents need a public URL to host the
// document, which a tailnet-only gateway doesn't have, so they're skipped.

import { join } from "node:path";

import {
  UnauthorizedError,
  auth,
  extractWWWAuthenticateParams,
  type AuthProvider,
  type OAuthClientInformationContext,
  type OAuthClientMetadata,
  type OAuthClientProvider,
  type OAuthDiscoveryState,
  type StoredOAuthClientInformation,
  type StoredOAuthTokens,
} from "@modelcontextprotocol/client";

import type { HttpUpstreamConfig } from "./config.ts";
import type { Layout } from "./layout.ts";
import { deleteSecretFile, readSecretFile, writeSecretFile } from "./secretFiles.ts";

export const CLIENT_NAME = "Connectors (MCP gateway)";

type SavedTokens = StoredOAuthTokens & { savedAt?: number };

export type OAuthFile = {
  clients?: Record<string, StoredOAuthClientInformation>;
  tokens?: Record<string, SavedTokens>;
  // The issuer of the most recently saved tokens.
  currentIssuer?: string;
  codeVerifier?: string;
  discoveryState?: OAuthDiscoveryState;
};

/** Thrown when a background connect would need the owner's browser. */
export class NeedsSignInError extends Error {
  // Why, in words for the admin page ("Google sign-in expired..."), if
  // there's more to say than "Needs sign-in."
  readonly reason?: string;
  constructor(upstreamId: string, reason?: string) {
    super(reason ? `${upstreamId}: ${reason}` : `${upstreamId} needs sign-in. Press Connect on the admin page.`);
    this.name = "NeedsSignInError";
    this.reason = reason;
  }
}

export function oauthFilePath(layout: Layout, upstreamId: string): string {
  return join(layout.oauthDir, `${upstreamId}.json`);
}

export function staticClientPath(layout: Layout, upstreamId: string): string {
  return join(layout.clientsDir, `${upstreamId}.json`);
}

export function redirectUrlFor(publicUrl: string): string {
  return new URL("/oauth/callback", publicUrl).toString();
}

export class FileOAuthProvider implements OAuthClientProvider {
  readonly upstream: HttpUpstreamConfig;
  private readonly layout: Layout;
  private readonly redirect: string;
  // Set for an interactive sign-in started from the admin page.
  private pendingState?: string;
  authorizationUrl?: URL;

  constructor(options: {
    upstream: HttpUpstreamConfig;
    layout: Layout;
    publicUrl: string;
    state?: string;
  }) {
    this.upstream = options.upstream;
    this.layout = options.layout;
    this.redirect = redirectUrlFor(options.publicUrl);
    this.pendingState = options.state;
  }

  get redirectUrl(): string {
    return this.redirect;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: CLIENT_NAME,
      redirect_uris: [this.redirect],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      // A public client with PKCE, like the CLIs that sign in to MCP servers.
      token_endpoint_auth_method: "none",
      ...(this.upstream.scopes?.length ? { scope: this.upstream.scopes.join(" ") } : {}),
    };
  }

  state(): string {
    if (!this.pendingState) throw new NeedsSignInError(this.upstream.id);
    return this.pendingState;
  }

  private read(): OAuthFile {
    const text = readSecretFile(oauthFilePath(this.layout, this.upstream.id));
    return text ? (JSON.parse(text) as OAuthFile) : {};
  }

  private write(update: (file: OAuthFile) => void): void {
    const file = this.read();
    update(file);
    writeSecretFile(oauthFilePath(this.layout, this.upstream.id), `${JSON.stringify(file, null, 2)}\n`);
  }

  private staticClient(): StoredOAuthClientInformation | undefined {
    if (this.upstream.auth.type !== "oauth" || this.upstream.auth.client !== "static") return undefined;
    const text = readSecretFile(staticClientPath(this.layout, this.upstream.id));
    if (!text) {
      throw new Error(
        `${this.upstream.id} uses a static OAuth client, but secrets/clients/${this.upstream.id}.json is missing.`,
      );
    }
    const parsed = JSON.parse(text) as { client_id?: string; client_secret?: string };
    if (!parsed.client_id) {
      throw new Error(`secrets/clients/${this.upstream.id}.json has no client_id.`);
    }
    return {
      client_id: parsed.client_id,
      ...(parsed.client_secret ? { client_secret: parsed.client_secret } : {}),
    };
  }

  clientInformation(ctx?: OAuthClientInformationContext): StoredOAuthClientInformation | undefined {
    const fixed = this.staticClient();
    if (fixed) return fixed;
    const file = this.read();
    const issuer = ctx?.issuer ?? file.currentIssuer;
    return issuer ? file.clients?.[issuer] : undefined;
  }

  saveClientInformation(info: StoredOAuthClientInformation, ctx?: OAuthClientInformationContext): void {
    // A static client lives in its own file; nothing to save.
    if (this.upstream.auth.type === "oauth" && this.upstream.auth.client === "static") return;
    const issuer = ctx?.issuer ?? info.issuer;
    if (!issuer) return;
    this.write((file) => {
      file.clients = { ...file.clients, [issuer]: info };
    });
  }

  tokens(ctx?: OAuthClientInformationContext): StoredOAuthTokens | undefined {
    const file = this.read();
    // No ctx means the transport wants the bearer token for a request:
    // return the most recently saved set.
    const issuer = ctx?.issuer ?? file.currentIssuer;
    if (!issuer) return undefined;
    const saved = file.tokens?.[issuer];
    if (!saved) return undefined;
    const { savedAt: _savedAt, ...tokens } = saved;
    return tokens;
  }

  saveTokens(tokens: StoredOAuthTokens, ctx?: OAuthClientInformationContext): void {
    const issuer = ctx?.issuer ?? tokens.issuer ?? "default";
    this.write((file) => {
      file.tokens = { ...file.tokens, [issuer]: { ...tokens, savedAt: Date.now() } };
      file.currentIssuer = issuer;
    });
  }

  redirectToAuthorization(authorizationUrl: URL): void {
    // Only a sign-in the owner started from the admin page may send them to the
    // provider. A background connect or refresh that ends up here means the
    // upstream needs signing in again.
    if (!this.pendingState) throw new NeedsSignInError(this.upstream.id);
    this.authorizationUrl = authorizationUrl;
  }

  saveCodeVerifier(codeVerifier: string): void {
    this.write((file) => {
      file.codeVerifier = codeVerifier;
    });
  }

  codeVerifier(): string {
    const verifier = this.read().codeVerifier;
    if (!verifier) throw new Error(`No sign-in in progress for ${this.upstream.id}.`);
    return verifier;
  }

  saveDiscoveryState(state: OAuthDiscoveryState): void {
    this.write((file) => {
      file.discoveryState = state;
    });
  }

  discoveryState(): OAuthDiscoveryState | undefined {
    return this.read().discoveryState;
  }

  invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery"): void {
    this.write((file) => {
      if (scope === "all" || scope === "tokens") {
        delete file.tokens;
        delete file.currentIssuer;
      }
      if (scope === "all" || scope === "client") delete file.clients;
      if (scope === "all" || scope === "verifier") delete file.codeVerifier;
      if (scope === "all" || scope === "discovery") delete file.discoveryState;
    });
  }

  hasTokens(): boolean {
    return this.tokens() !== undefined;
  }
}

/**
 * What the HTTP transport uses for an OAuth upstream: the stored access
 * token, and on a 401 at most one refresh at a time. The SDK's own adapter
 * runs a refresh per failed request, so parallel calls at expiry would all
 * spend the same refresh token. With providers that rotate refresh tokens
 * (OAuth 2.1 requires it for public clients like this one) every refresh
 * after the first gets invalid_grant, and the SDK then deletes the tokens
 * the first one just saved, which signs the upstream out. Here the 401s
 * that arrive while a refresh runs wait for it and retry with its token. A
 * later straggler starts another refresh, from the newest refresh token,
 * which is wasteful but safe.
 */
export function singleFlightAuth(provider: FileOAuthProvider): AuthProvider {
  let inflight: Promise<void> | undefined;
  return {
    token: async () => provider.tokens()?.access_token,
    onUnauthorized: (ctx) => {
      if (inflight) return inflight;
      inflight = (async () => {
        const { resourceMetadataUrl, scope } = extractWWWAuthenticateParams(ctx.response);
        const result = await auth(provider, { serverUrl: ctx.serverUrl, resourceMetadataUrl, scope, fetchFn: ctx.fetchFn });
        if (result !== "AUTHORIZED") throw new UnauthorizedError();
      })().finally(() => {
        inflight = undefined;
      });
      return inflight;
    },
  };
}

/** Deletes an upstream's tokens but keeps its client registration. */
export function deleteTokens(layout: Layout, upstreamId: string): void {
  const path = oauthFilePath(layout, upstreamId);
  const text = readSecretFile(path);
  if (!text) return;
  const file = JSON.parse(text) as OAuthFile;
  delete file.tokens;
  delete file.currentIssuer;
  delete file.codeVerifier;
  if (Object.keys(file).length === 0) {
    deleteSecretFile(path);
    return;
  }
  writeSecretFile(path, `${JSON.stringify(file, null, 2)}\n`);
}
