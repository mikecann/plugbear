// Shared pieces of the built-in Google stdio server (server.ts): calling
// Google's REST APIs and checking tool arguments. This side never reads a
// secret file: the gateway sends a fresh access token with every call in
// the request's _meta, and keeps the refresh token and client secret to
// itself (see account.ts).

/** Where the gateway puts the access token in a tools/call's _meta. */
export const TOKEN_META_KEY = "connectors/google-access-token";
/** Set in a result's _meta when Google refused the token, so the gateway refreshes and retries once. */
export const AUTH_META_KEY = "connectors/google-auth";

export type GoogleService = "gmail" | "calendar";

export type GoogleUrls = { gmail: string; calendar: string };

/** The API roots. Tests point both at a fake on loopback. */
export function googleUrls(base?: string): GoogleUrls {
  if (base) {
    const root = base.replace(/\/+$/, "");
    return { gmail: `${root}/gmail/v1`, calendar: `${root}/calendar/v3` };
  }
  return { gmail: "https://gmail.googleapis.com/gmail/v1", calendar: "https://www.googleapis.com/calendar/v3" };
}

export class GoogleApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "GoogleApiError";
    this.status = status;
  }
}

/** A bad tool argument. Its message goes straight back to the agent. */
export class ArgError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArgError";
  }
}

export type ToolContext = { token: string; urls: GoogleUrls };

export type ToolDef = {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: Record<string, boolean>;
  run(args: Record<string, unknown>, ctx: ToolContext): Promise<unknown>;
};

const REQUEST_TIMEOUT_MS = 60_000;

export type Query = Record<string, string | number | boolean | readonly string[] | undefined>;

export function withQuery(url: string, query: Query = {}): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) for (const item of value) params.append(key, item);
    else params.append(key, String(value));
  }
  const text = params.toString();
  return text ? `${url}?${text}` : url;
}

/** One request to a Google API. Throws GoogleApiError with Google's own message. */
export async function google<T>(
  ctx: ToolContext,
  method: "GET" | "POST" | "PATCH",
  url: string,
  body?: unknown,
): Promise<T> {
  const response = await fetch(url, {
    method,
    headers: {
      authorization: `Bearer ${ctx.token}`,
      accept: "application/json",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    // A redirect would carry the token somewhere else.
    redirect: "error",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const text = await response.text();
  if (!response.ok) {
    let detail = text.slice(0, 500);
    try {
      const parsed = JSON.parse(text) as { error?: { message?: string } | string };
      if (typeof parsed.error === "object" && parsed.error?.message) detail = parsed.error.message;
      else if (typeof parsed.error === "string") detail = parsed.error;
    } catch {
      // Not JSON: keep the start of the text.
    }
    throw new GoogleApiError(response.status, `Google answered ${response.status}: ${detail}`);
  }
  return (text ? JSON.parse(text) : {}) as T;
}

export const enc = encodeURIComponent;

// Argument helpers. Tool schemas say the same thing for the agent; these
// make sure a call that ignores them gets a clear message instead of an
// odd Google error.

export function optString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw new ArgError(`${key} must be a string.`);
  return value;
}

export function reqString(args: Record<string, unknown>, key: string): string {
  const value = optString(args, key);
  if (value === undefined || !value.trim()) throw new ArgError(`${key} is required.`);
  return value;
}

export function optInt(args: Record<string, unknown>, key: string, min: number, max: number): number | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new ArgError(`${key} must be a whole number from ${min} to ${max}.`);
  }
  return value;
}

export function optBool(args: Record<string, unknown>, key: string): boolean | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") throw new ArgError(`${key} must be true or false.`);
  return value;
}

/** A list of email addresses, as an array or one comma-separated string. */
export function addressList(args: Record<string, unknown>, key: string): string[] | undefined {
  const value = args[key];
  if (value === undefined || value === null || value === "") return undefined;
  const items = typeof value === "string" ? value.split(",") : value;
  if (!Array.isArray(items) || items.some((item) => typeof item !== "string")) {
    throw new ArgError(`${key} must be a list of email addresses.`);
  }
  const addresses = (items as string[]).map((item) => item.trim()).filter(Boolean);
  for (const address of addresses) {
    if (/[\r\n]/.test(address) || !address.includes("@")) {
      throw new ArgError(`${key} has something that isn't an email address: ${JSON.stringify(address.slice(0, 100))}`);
    }
  }
  return addresses.length ? addresses : undefined;
}

/** Cuts long text and says how much was left out. */
export function cut(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n[Cut: ${text.length - max} more characters]`;
}
