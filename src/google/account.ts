// The owner's Google sign-in for the built-in Gmail and Calendar upstreams.
// Google's hosted MCP servers only take Workspace accounts in a developer
// preview, not a personal @gmail.com account, so the gateway signs in to
// Google itself and runs a small stdio server (server.ts) per service.
//
// Upstreams that name the same account share one sign-in:
//   secrets/clients/<account>.json  the Google "Web application" OAuth client
//                                   (client_id, client_secret; the file
//                                   Google's console downloads works too)
//   secrets/oauth/<account>.json    tokens, granted scopes, the account's
//                                   email and the PKCE verifier (0600)
// Only the gateway reads these. It refreshes the access token (one refresh
// at a time per account) and hands the stdio servers a fresh access token
// with each call, so they never see the refresh token or client secret.

import { createHash, randomBytes } from "node:crypto";

import type { Layout } from "../layout.ts";
import { type Logger, silentLogger } from "../log.ts";
import { NeedsSignInError, oauthFilePath, redirectUrlFor, staticClientPath } from "../oauth.ts";
import { deleteSecretFile, readSecretFile, writeSecretFile } from "../secretFiles.ts";
import type { GuardedFetch } from "../ssrf.ts";
import type { GoogleService } from "./api.ts";

export type GoogleEndpoints = { authorize: string; token: string };

export const GOOGLE_ENDPOINTS: GoogleEndpoints = {
  authorize: "https://accounts.google.com/o/oauth2/v2/auth",
  token: "https://oauth2.googleapis.com/token",
};

const SCOPE_ROOT = "https://www.googleapis.com/auth/";

export const SERVICE_SCOPES: Record<GoogleService, string[]> = {
  // compose covers drafts and sending; no modify, as there are no label tools.
  gmail: [`${SCOPE_ROOT}gmail.readonly`, `${SCOPE_ROOT}gmail.compose`],
  calendar: [`${SCOPE_ROOT}calendar.readonly`, `${SCOPE_ROOT}calendar.events`],
};

export const SERVICE_NAMES: Record<GoogleService, string> = { gmail: "Gmail", calendar: "Google Calendar" };

// Asked for as well, so the admin page can show which Google account signed
// in: the same browser often has a work account too.
const IDENTITY_SCOPES = ["openid", "email"];

// Refresh a little before Google's expiry so a call never starts with a
// token about to lapse.
const EXPIRY_MARGIN_MS = 2 * 60_000;
const TOKEN_TIMEOUT_MS = 30_000;

type TokenFile = {
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number;
  // Space-separated, as Google reports what the owner granted.
  scope?: string;
  email?: string;
  savedAt?: number;
  codeVerifier?: string;
};

type TokenResponse = {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  id_token?: string;
  error?: string;
  error_description?: string;
};

/** The OAuth client file is missing, so there's nothing to sign in with yet. */
export class NeedsSetupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NeedsSetupError";
  }
}

class GoogleTokenError extends Error {
  readonly code: string;
  constructor(code: string, description?: string) {
    super(`Google refused the token request: ${code}${description ? ` (${description})` : ""}`);
    this.name = "GoogleTokenError";
    this.code = code;
  }
}

export type AccountListener = {
  signedIn(): void;
  signedOut(reason: string): void;
};

/** The email in an ID token straight from Google's token endpoint (over TLS, so not re-verified). */
function emailFromIdToken(idToken: string | undefined): string | undefined {
  const payload = idToken?.split(".")[1];
  if (!payload) return undefined;
  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { email?: unknown };
    return typeof claims.email === "string" ? claims.email : undefined;
  } catch {
    return undefined;
  }
}

export class GoogleAccount {
  readonly id: string;
  private readonly layout: Layout;
  private readonly redirect: string;
  private readonly fetch: GuardedFetch;
  private readonly endpoints: GoogleEndpoints;
  private readonly log: Logger;
  private readonly now: () => number;
  private readonly scopes = new Set<string>(IDENTITY_SCOPES);
  private readonly listeners = new Set<AccountListener>();
  private refreshing?: Promise<string>;

  constructor(options: {
    id: string;
    layout: Layout;
    publicUrl: string;
    fetch: GuardedFetch;
    endpoints?: GoogleEndpoints;
    log?: Logger;
    now?: () => number;
  }) {
    this.id = options.id;
    this.layout = options.layout;
    this.redirect = redirectUrlFor(options.publicUrl);
    this.fetch = options.fetch;
    this.endpoints = options.endpoints ?? GOOGLE_ENDPOINTS;
    this.log = options.log ?? silentLogger;
    this.now = options.now ?? Date.now;
  }

  /** Each upstream on this account adds its service's scopes; one sign-in asks for all of them. */
  addScopes(scopes: readonly string[]): void {
    for (const scope of scopes) this.scopes.add(scope);
  }

  listen(listener: AccountListener): void {
    this.listeners.add(listener);
  }

  /** Where the owner puts the OAuth client, relative to secrets/. */
  get clientFileName(): string {
    return `clients/${this.id}.json`;
  }

  private read(): TokenFile {
    const text = readSecretFile(oauthFilePath(this.layout, this.id));
    if (!text) return {};
    try {
      return JSON.parse(text) as TokenFile;
    } catch {
      return {};
    }
  }

  private write(update: (file: TokenFile) => void): void {
    const file = this.read();
    update(file);
    writeSecretFile(oauthFilePath(this.layout, this.id), `${JSON.stringify(file, null, 2)}\n`);
  }

  /** The OAuth client, flat or as Google's console downloads it ({"web": {...}}). */
  private client(): { clientId: string; clientSecret: string } {
    const text = readSecretFile(staticClientPath(this.layout, this.id));
    if (!text) throw new NeedsSetupError(`Needs a Google OAuth client in secrets/${this.clientFileName}.`);
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(text) as Record<string, unknown>;
    } catch {
      throw new NeedsSetupError(`secrets/${this.clientFileName} isn't valid JSON.`);
    }
    const inner = (parsed.web ?? parsed.installed ?? parsed) as { client_id?: unknown; client_secret?: unknown };
    if (typeof inner.client_id !== "string" || typeof inner.client_secret !== "string") {
      throw new NeedsSetupError(`secrets/${this.clientFileName} needs a client_id and a client_secret.`);
    }
    return { clientId: inner.client_id, clientSecret: inner.client_secret };
  }

  /** Throws NeedsSetupError if the client file is missing or broken. */
  checkClient(): void {
    this.client();
  }

  isSignedIn(): boolean {
    return Boolean(this.read().refreshToken);
  }

  email(): string | undefined {
    return this.read().email;
  }

  /** Scopes this upstream needs that the owner didn't grant (Google lets them untick some). */
  missingScopes(required: readonly string[]): string[] {
    const granted = new Set((this.read().scope ?? "").split(/\s+/).filter(Boolean));
    return required.filter((scope) => !granted.has(scope));
  }

  /** Starts a sign-in: the Google URL to send the owner's browser to. */
  authorizationUrl(state: string): URL {
    const { clientId } = this.client();
    const verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    this.write((file) => {
      file.codeVerifier = verifier;
    });
    const url = new URL(this.endpoints.authorize);
    url.search = new URLSearchParams({
      client_id: clientId,
      redirect_uri: this.redirect,
      response_type: "code",
      scope: [...this.scopes].join(" "),
      // offline and consent so Google always sends a refresh token, even
      // when the owner has signed in before.
      access_type: "offline",
      prompt: "consent",
      include_granted_scopes: "true",
      state,
      code_challenge: challenge,
      code_challenge_method: "S256",
    }).toString();
    return url;
  }

  /** Exchanges the code from the callback for tokens, then tells every upstream on this account. */
  async finishSignIn(code: string): Promise<void> {
    const verifier = this.read().codeVerifier;
    if (!verifier) throw new Error("No Google sign-in is in progress. Start again with Connect.");
    const response = await this.tokenRequest({
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      redirect_uri: this.redirect,
    });
    if (!response.refresh_token) {
      throw new Error("Google didn't send a refresh token, so the sign-in wouldn't last. Connect again.");
    }
    const email = emailFromIdToken(response.id_token);
    const now = this.now();
    writeSecretFile(
      oauthFilePath(this.layout, this.id),
      `${JSON.stringify(
        {
          accessToken: response.access_token,
          refreshToken: response.refresh_token,
          expiresAt: now + (response.expires_in ?? 3600) * 1000,
          scope: response.scope ?? "",
          ...(email ? { email } : {}),
          savedAt: now,
        } satisfies TokenFile,
        null,
        2,
      )}\n`,
    );
    this.log.info(`google account ${this.id}: signed in`);
    for (const listener of this.listeners) listener.signedIn();
  }

  /**
   * A fresh access token, refreshed if it's about to expire (or `force`).
   * One refresh at a time. Throws NeedsSignInError once Google says the
   * refresh token is no good (revoked, expired), after signing out.
   */
  async accessToken(force = false): Promise<string> {
    const file = this.read();
    if (!file.refreshToken) throw new NeedsSignInError(this.id);
    if (!force && file.accessToken && (file.expiresAt ?? 0) - this.now() > EXPIRY_MARGIN_MS) {
      return file.accessToken;
    }
    this.refreshing ??= this.refresh(file.refreshToken).finally(() => {
      this.refreshing = undefined;
    });
    return this.refreshing;
  }

  private async refresh(refreshToken: string): Promise<string> {
    let response: TokenResponse;
    try {
      response = await this.tokenRequest({ grant_type: "refresh_token", refresh_token: refreshToken });
    } catch (error) {
      if (error instanceof GoogleTokenError && error.code === "invalid_grant") {
        const reason = "Google sign-in expired or was revoked. Connect again.";
        this.log.warn(`google account ${this.id}: refresh token refused (invalid_grant), signing out`);
        this.signOut(reason);
        throw new NeedsSignInError(this.id, reason);
      }
      throw error;
    }
    const now = this.now();
    this.write((file) => {
      file.accessToken = response.access_token;
      file.expiresAt = now + (response.expires_in ?? 3600) * 1000;
      if (response.scope) file.scope = response.scope;
      // Google doesn't usually rotate refresh tokens, but keep a new one if it does.
      if (response.refresh_token) file.refreshToken = response.refresh_token;
      file.savedAt = now;
    });
    return response.access_token!;
  }

  /** Forgets the tokens and tells every upstream on this account. */
  signOut(reason = "Signed out."): void {
    deleteSecretFile(oauthFilePath(this.layout, this.id));
    for (const listener of this.listeners) listener.signedOut(reason);
  }

  private async tokenRequest(params: Record<string, string>): Promise<TokenResponse> {
    const { clientId, clientSecret } = this.client();
    const response = await this.fetch(this.endpoints.token, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({ ...params, client_id: clientId, client_secret: clientSecret }).toString(),
      redirect: "error",
      signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
    });
    let json: TokenResponse = {};
    try {
      json = (await response.json()) as TokenResponse;
    } catch {
      // Not JSON; the status says enough.
    }
    if (!response.ok || json.error) {
      throw new GoogleTokenError(json.error ?? `HTTP ${response.status}`, json.error_description);
    }
    if (!json.access_token) throw new GoogleTokenError("no_access_token");
    return json;
  }
}
