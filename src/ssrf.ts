// SSRF guard for every request the gateway makes to an upstream or an OAuth
// server. Only https URLs, never a private, LAN, loopback, link-local or
// CGNAT (tailnet) address, and redirects are followed by hand so each hop
// gets the same checks. DNS answers are checked at connect time by the
// dispatcher's lookup, so a name can't resolve to a public address for the
// check and a private one for the connection.

import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { BlockList, isIP } from "node:net";

import { Agent } from "undici";

const blocked = new BlockList();
// IPv4
blocked.addSubnet("0.0.0.0", 8, "ipv4");
blocked.addSubnet("10.0.0.0", 8, "ipv4");
blocked.addSubnet("100.64.0.0", 10, "ipv4"); // CGNAT, Tailscale
blocked.addSubnet("127.0.0.0", 8, "ipv4");
blocked.addSubnet("169.254.0.0", 16, "ipv4");
blocked.addSubnet("172.16.0.0", 12, "ipv4");
blocked.addSubnet("192.0.0.0", 24, "ipv4");
blocked.addSubnet("192.0.2.0", 24, "ipv4");
blocked.addSubnet("192.168.0.0", 16, "ipv4");
blocked.addSubnet("198.18.0.0", 15, "ipv4");
blocked.addSubnet("198.51.100.0", 24, "ipv4");
blocked.addSubnet("203.0.113.0", 24, "ipv4");
blocked.addSubnet("224.0.0.0", 4, "ipv4");
blocked.addSubnet("240.0.0.0", 4, "ipv4");
// IPv6
blocked.addAddress("::", "ipv6");
blocked.addAddress("::1", "ipv6");
blocked.addSubnet("fc00::", 7, "ipv6"); // unique local, includes Tailscale's fd7a:
blocked.addSubnet("fe80::", 10, "ipv6");
blocked.addSubnet("fec0::", 10, "ipv6");
blocked.addSubnet("ff00::", 8, "ipv6");
blocked.addSubnet("2001:db8::", 32, "ipv6");
blocked.addSubnet("100::", 64, "ipv6");

const loopback = new BlockList();
loopback.addSubnet("127.0.0.0", 8, "ipv4");
loopback.addAddress("::1", "ipv6");

// IPv6 forms that carry an IPv4 address: mapped (::ffff:a.b.c.d), NAT64
// (64:ff9b::a.b.c.d) and 6to4 (2002:AABB:CCDD::).
function embeddedIpv4(address: string): string | null {
  const lower = address.toLowerCase();
  const dotted = /^(?:::ffff:|64:ff9b::)(\d{1,3}(?:\.\d{1,3}){3})$/.exec(lower);
  if (dotted) return dotted[1]!;
  const hex = /^(?:::ffff:|64:ff9b::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(lower);
  const sixToFour = /^2002:([0-9a-f]{1,4}):([0-9a-f]{1,4}):/.exec(lower);
  const parts = hex ?? sixToFour;
  if (!parts) return null;
  const high = Number.parseInt(parts[1]!, 16);
  const low = Number.parseInt(parts[2]!, 16);
  return [high >> 8, high & 255, low >> 8, low & 255].join(".");
}

export function isPrivateAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return blocked.check(address, "ipv4");
  if (family === 6) {
    const v4 = embeddedIpv4(address);
    if (v4 !== null) return blocked.check(v4, "ipv4");
    return blocked.check(address, "ipv6");
  }
  // Not an IP at all: refuse rather than guess.
  return true;
}

export function isLoopbackAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return loopback.check(address, "ipv4");
  if (family === 6) return loopback.check(address, "ipv6");
  return false;
}

export type GuardOptions = {
  // Lets tests reach http://127.0.0.1 servers. Never set in production.
  allowLoopback?: boolean;
};

export class BlockedRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BlockedRequestError";
  }
}

const BLOCKED_HOSTNAMES = /(^|\.)(localhost|local|internal|home\.arpa)$/i;

/** Checks a URL before any request. Throws BlockedRequestError. */
export function checkUrl(input: string | URL, options: GuardOptions = {}): URL {
  const url = new URL(input);
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const loopbackOk =
    options.allowLoopback === true &&
    (host === "localhost" || (isIP(host) !== 0 && isLoopbackAddress(host)));
  if (url.username || url.password) {
    throw new BlockedRequestError(`Refusing a URL with credentials in it: ${url.origin}`);
  }
  if (loopbackOk) {
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new BlockedRequestError(`Refusing ${url.protocol} URL`);
    }
    return url;
  }
  if (url.protocol !== "https:") {
    throw new BlockedRequestError(`Refusing a non-https URL: ${url.origin}`);
  }
  if (isIP(host) !== 0) {
    if (isPrivateAddress(host)) {
      throw new BlockedRequestError(`Refusing a private address: ${url.origin}`);
    }
  } else if (BLOCKED_HOSTNAMES.test(host) || !host.includes(".")) {
    throw new BlockedRequestError(`Refusing a local hostname: ${url.origin}`);
  }
  return url;
}

type LookupCallback = (
  error: NodeJS.ErrnoException | null,
  address: string | LookupAddress[],
  family?: number,
) => void;

/** A dns.lookup replacement that fails when any answer is private. */
export function guardedLookup(options: GuardOptions = {}) {
  return (
    hostname: string,
    lookupOptions: { all?: boolean; family?: number } | number,
    callback: LookupCallback,
  ): void => {
    const opts = typeof lookupOptions === "number" ? { family: lookupOptions } : lookupOptions;
    dnsLookup(hostname, { ...opts, all: true }, (error, addresses) => {
      if (error) {
        callback(error, []);
        return;
      }
      const bad = addresses.find(
        (entry) =>
          isPrivateAddress(entry.address) &&
          !(options.allowLoopback && isLoopbackAddress(entry.address)),
      );
      if (bad || addresses.length === 0) {
        const blockedError = new BlockedRequestError(
          `Refusing ${hostname}: it resolves to a private address`,
        ) as NodeJS.ErrnoException;
        blockedError.code = "EBLOCKED";
        callback(blockedError, []);
        return;
      }
      if (opts.all) callback(null, addresses);
      else callback(null, addresses[0]!.address, addresses[0]!.family);
    });
  };
}

const MAX_REDIRECTS = 5;

export type GuardedFetch = typeof fetch;

/**
 * A fetch for upstream and OAuth traffic. Pass it to the MCP SDK as
 * `fetch`/`fetchFn` so every request it makes goes through the guard.
 */
export function createGuardedFetch(options: GuardOptions = {}): GuardedFetch {
  const dispatcher = new Agent({
    connect: { lookup: guardedLookup(options) as never },
    // Long tool calls can sit quietly for minutes.
    bodyTimeout: 15 * 60_000,
    headersTimeout: 5 * 60_000,
  });

  const guarded = async (
    input: string | URL | Request,
    init: RequestInit = {},
  ): Promise<Response> => {
    if (input instanceof Request) {
      // The SDK passes URLs, not Request objects; keep it simple and safe.
      throw new BlockedRequestError("Pass a URL, not a Request, to the guarded fetch");
    }
    let url = checkUrl(input, options);
    const callerHandlesRedirects = init.redirect === "manual" || init.redirect === "error";
    let method = (init.method ?? "GET").toUpperCase();
    let body = init.body;
    const headers = new Headers(init.headers);
    for (let hop = 0; ; hop += 1) {
      const response = await fetch(url, {
        ...init,
        method,
        body,
        headers,
        redirect: "manual",
        // undici's dispatcher option isn't in the DOM RequestInit type.
        ...({ dispatcher } as object),
      });
      const location = response.headers.get("location");
      if (
        callerHandlesRedirects ||
        response.status < 300 ||
        response.status > 399 ||
        response.status === 304 ||
        !location
      ) {
        return response;
      }
      if (hop >= MAX_REDIRECTS) {
        throw new BlockedRequestError(`Too many redirects from ${url.origin}`);
      }
      await response.body?.cancel();
      const next = checkUrl(new URL(location, url), options);
      if (next.origin !== url.origin) {
        // An upstream's own token must never follow a redirect elsewhere.
        headers.delete("authorization");
        headers.delete("cookie");
      }
      url = next;
      if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === "POST")) {
        method = "GET";
        body = undefined;
      } else if (body !== undefined && body !== null && typeof body !== "string" && !(body instanceof URLSearchParams)) {
        throw new BlockedRequestError("Can't replay a streamed body across a redirect");
      }
    }
  };
  return guarded as GuardedFetch;
}
