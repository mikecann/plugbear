// A fake Google on loopback for the Gmail and Calendar upstreams: the OAuth
// authorize and token endpoints (PKCE, client secret, refresh, revoke) and
// just enough of the Gmail and Calendar REST APIs for the tools.

import { createHash, randomBytes } from "node:crypto";
import { type IncomingMessage, type ServerResponse, createServer } from "node:http";
import type { AddressInfo } from "node:net";

export const FAKE_CLIENT = { client_id: "fake-client.apps.googleusercontent.com", client_secret: "fake-client-secret" };
export const FAKE_EMAIL = "sam@example.com";

const SCOPE_ROOT = "https://www.googleapis.com/auth/";

function b64(text: string): string {
  return Buffer.from(text).toString("base64url");
}

type Event = {
  id: string;
  summary?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  attendees?: { email: string; self?: boolean; responseStatus?: string }[];
  description?: string;
};

export type FakeGoogle = {
  url: string;
  endpoints: { authorize: string; token: string };
  stats: { codeExchanges: number; refreshes: number; failedRefreshes: number; apiCalls: number; unauthorized: number };
  lastAuthorize?: URLSearchParams;
  // What Sam "ticks" on the consent screen; all asked scopes by default.
  grantOnly?: string[];
  drafts: { raw: string; threadId?: string }[];
  sent: { raw: string; threadId?: string }[];
  events: Map<string, Event>;
  eventQueries: URLSearchParams[];
  patches: { id: string; body: Partial<Event>; sendUpdates: string | null }[];
  expireAccessTokens(): void;
  // Access tokens stop working before their expiry (revoked early).
  invalidateAccessTokens(): void;
  revokeRefreshTokens(): void;
  close(): Promise<void>;
};

async function readText(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
}

const messages = {
  m1: {
    id: "m1",
    threadId: "t1",
    labelIds: ["INBOX", "UNREAD"],
    snippet: "Lunch on Friday?",
    payload: {
      mimeType: "multipart/alternative",
      headers: [
        { name: "From", value: "Ann <ann@example.com>" },
        { name: "To", value: FAKE_EMAIL },
        { name: "Subject", value: "Lunch" },
        { name: "Date", value: "Tue, 27 Oct 2026 09:00:00 +0800" },
        { name: "Message-ID", value: "<m1@example.com>" },
      ],
      parts: [
        { mimeType: "text/plain", body: { data: b64("Lunch on Friday?\nAnn") } },
        { mimeType: "text/html", body: { data: b64("<p>Lunch on Friday?</p>") } },
        { mimeType: "application/pdf", filename: "menu.pdf", body: { attachmentId: "a1", size: 1234 } },
      ],
    },
  },
  m2: {
    id: "m2",
    threadId: "t1",
    labelIds: ["SENT"],
    snippet: "Sure",
    payload: {
      mimeType: "text/html",
      headers: [
        { name: "From", value: FAKE_EMAIL },
        { name: "Subject", value: "Re: Lunch" },
        { name: "Date", value: "Tue, 27 Oct 2026 10:00:00 +0800" },
      ],
      body: { data: b64("<div>Sure &amp; see you <b>then</b></div>") },
    },
  },
};

export async function startFakeGoogle(): Promise<FakeGoogle> {
  const codes = new Map<string, { challenge: string; redirectUri: string; scope: string }>();
  const accessTokens = new Map<string, { expiresAt: number }>();
  const refreshTokens = new Map<string, { scope: string }>();
  let origin = "";
  const token = () => randomBytes(16).toString("hex");
  const issueAccess = () => {
    const access = token();
    accessTokens.set(access, { expiresAt: Date.now() + 3600_000 });
    return access;
  };

  const fake: FakeGoogle = {
    url: "",
    endpoints: { authorize: "", token: "" },
    stats: { codeExchanges: 0, refreshes: 0, failedRefreshes: 0, apiCalls: 0, unauthorized: 0 },
    drafts: [],
    sent: [],
    events: new Map([
      ["e1", { id: "e1", summary: "Focus", start: { dateTime: "2026-11-02T09:00:00+00:00" }, end: { dateTime: "2026-11-02T10:00:00+00:00" } }],
      [
        "e2",
        {
          id: "e2",
          summary: "Planning",
          start: { dateTime: "2026-11-03T09:00:00+00:00" },
          end: { dateTime: "2026-11-03T10:00:00+00:00" },
          attendees: [
            { email: FAKE_EMAIL, self: true, responseStatus: "accepted" },
            { email: "ann@example.com", responseStatus: "needsAction" },
          ],
        },
      ],
    ]),
    eventQueries: [],
    patches: [],
    expireAccessTokens() {
      for (const entry of accessTokens.values()) entry.expiresAt = 0;
    },
    invalidateAccessTokens() {
      accessTokens.clear();
    },
    revokeRefreshTokens() {
      refreshTokens.clear();
      accessTokens.clear();
    },
    close: async () => {},
  };

  const handleToken = async (req: IncomingMessage, res: ServerResponse) => {
    const form = new URLSearchParams(await readText(req));
    if (form.get("client_id") !== FAKE_CLIENT.client_id || form.get("client_secret") !== FAKE_CLIENT.client_secret) {
      return json(res, 401, { error: "invalid_client" });
    }
    if (form.get("grant_type") === "authorization_code") {
      const code = codes.get(form.get("code") ?? "");
      codes.delete(form.get("code") ?? "");
      const challenge = createHash("sha256").update(form.get("code_verifier") ?? "").digest("base64url");
      if (!code || code.challenge !== challenge || code.redirectUri !== form.get("redirect_uri")) {
        return json(res, 400, { error: "invalid_grant" });
      }
      fake.stats.codeExchanges += 1;
      const refresh = token();
      refreshTokens.set(refresh, { scope: code.scope });
      const idToken = `${b64('{"alg":"RS256"}')}.${b64(JSON.stringify({ email: FAKE_EMAIL, sub: "1" }))}.sig`;
      return json(res, 200, {
        access_token: issueAccess(),
        refresh_token: refresh,
        expires_in: 3599,
        scope: code.scope,
        token_type: "Bearer",
        id_token: idToken,
      });
    }
    if (form.get("grant_type") === "refresh_token") {
      const refresh = refreshTokens.get(form.get("refresh_token") ?? "");
      if (!refresh) {
        fake.stats.failedRefreshes += 1;
        return json(res, 400, { error: "invalid_grant", error_description: "Token has been expired or revoked." });
      }
      fake.stats.refreshes += 1;
      return json(res, 200, { access_token: issueAccess(), expires_in: 3599, scope: refresh.scope, token_type: "Bearer" });
    }
    return json(res, 400, { error: "unsupported_grant_type" });
  };

  const handleApi = async (req: IncomingMessage, res: ServerResponse, url: URL) => {
    const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1] ?? "";
    const access = accessTokens.get(bearer);
    if (!access || access.expiresAt < Date.now()) {
      fake.stats.unauthorized += 1;
      return json(res, 401, { error: { code: 401, message: "Request had invalid authentication credentials." } });
    }
    fake.stats.apiCalls += 1;
    const path = url.pathname;
    const method = req.method ?? "GET";
    let match: RegExpExecArray | null;
    if (path === "/gmail/v1/users/me/threads") {
      return json(res, 200, { threads: [{ id: "t1", snippet: "Lunch on Friday?" }], resultSizeEstimate: 1 });
    }
    if ((match = /^\/gmail\/v1\/users\/me\/threads\/([^/]+)$/.exec(path))) {
      if (match[1] !== "t1") return json(res, 404, { error: { code: 404, message: "Requested entity was not found." } });
      return json(res, 200, { id: "t1", messages: [messages.m1, messages.m2] });
    }
    if ((match = /^\/gmail\/v1\/users\/me\/messages\/([^/]+)$/.exec(path)) && method === "GET") {
      const message = messages[match[1] as keyof typeof messages];
      return message ? json(res, 200, message) : json(res, 404, { error: { code: 404, message: "Not found" } });
    }
    if (path === "/gmail/v1/users/me/labels") {
      return json(res, 200, { labels: [{ id: "INBOX", name: "INBOX", type: "system" }, { id: "Label_1", name: "Receipts", type: "user" }] });
    }
    if (path === "/gmail/v1/users/me/drafts" && method === "POST") {
      const body = JSON.parse(await readText(req)) as { message: { raw: string; threadId?: string } };
      fake.drafts.push(body.message);
      return json(res, 200, { id: `d${fake.drafts.length}`, message: { id: "dm1", threadId: body.message.threadId ?? "t9" } });
    }
    if (path === "/gmail/v1/users/me/messages/send" && method === "POST") {
      const body = JSON.parse(await readText(req)) as { raw: string; threadId?: string };
      fake.sent.push(body);
      return json(res, 200, { id: `s${fake.sent.length}`, threadId: body.threadId ?? "t9", labelIds: ["SENT"] });
    }
    if (path === "/calendar/v3/users/me/calendarList") {
      return json(res, 200, { items: [{ id: FAKE_EMAIL, summary: "Sam", primary: true, accessRole: "owner", timeZone: "Europe/Lisbon" }] });
    }
    if ((match = /^\/calendar\/v3\/calendars\/([^/]+)\/events$/.exec(path))) {
      if (method === "POST") {
        const body = JSON.parse(await readText(req)) as Event;
        const event = { ...body, id: `e${fake.events.size + 1}` };
        fake.events.set(event.id, event);
        return json(res, 200, event);
      }
      fake.eventQueries.push(url.searchParams);
      return json(res, 200, { timeZone: "Europe/Lisbon", items: [...fake.events.values()] });
    }
    if ((match = /^\/calendar\/v3\/calendars\/([^/]+)\/events\/([^/]+)$/.exec(path))) {
      const event = fake.events.get(decodeURIComponent(match[2]!));
      if (!event) return json(res, 404, { error: { code: 404, message: "Not Found" } });
      if (method === "PATCH") {
        const body = JSON.parse(await readText(req)) as Partial<Event>;
        fake.patches.push({ id: event.id, body, sendUpdates: url.searchParams.get("sendUpdates") });
        Object.assign(event, body);
      }
      return json(res, 200, event);
    }
    return json(res, 404, { error: { code: 404, message: `No fake for ${method} ${path}` } });
  };

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", origin);
    const run = async () => {
      if (url.pathname === "/o/oauth2/v2/auth") {
        const params = url.searchParams;
        fake.lastAuthorize = params;
        if (params.get("client_id") !== FAKE_CLIENT.client_id) return json(res, 400, { error: "invalid_client" });
        if (params.get("code_challenge_method") !== "S256" || !params.get("code_challenge")) {
          return json(res, 400, { error: "invalid_request" });
        }
        const asked = (params.get("scope") ?? "").split(" ");
        const granted = fake.grantOnly ? asked.filter((scope) => fake.grantOnly!.includes(scope)) : asked;
        const code = token();
        codes.set(code, { challenge: params.get("code_challenge")!, redirectUri: params.get("redirect_uri") ?? "", scope: granted.join(" ") });
        const target = new URL(params.get("redirect_uri")!);
        target.searchParams.set("code", code);
        target.searchParams.set("state", params.get("state") ?? "");
        target.searchParams.set("scope", granted.join(" "));
        res.writeHead(302, { location: target.toString() }).end();
        return;
      }
      if (url.pathname === "/token" && req.method === "POST") return handleToken(req, res);
      return handleApi(req, res, url);
    };
    run().catch((error: unknown) => json(res, 500, { error: String(error) }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  fake.url = origin;
  fake.endpoints = { authorize: `${origin}/o/oauth2/v2/auth`, token: `${origin}/token` };
  fake.close = () =>
    new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  return fake;
}

export const GMAIL_SCOPES = [`${SCOPE_ROOT}gmail.readonly`, `${SCOPE_ROOT}gmail.compose`];
export const CALENDAR_SCOPES = [`${SCOPE_ROOT}calendar.readonly`, `${SCOPE_ROOT}calendar.events`];
