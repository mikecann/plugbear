import assert from "node:assert/strict";
import { test } from "node:test";

import type { ErrorEvent } from "@sentry/node";

import { looksLikeBug, redact, scrubEvent, sentryEnabled } from "./sentry.ts";

const prod = { NODE_ENV: "production" };
const DSN = "https://publickey@o0.ingest.example.com/1";

test("Sentry is on only for a deployed release under the LaunchAgent, with a DSN in settings", () => {
  assert.equal(sentryEnabled(prod, "20261029T000000Z-abcdef12", DSN), true);
  // No DSN (the default): never.
  assert.equal(sentryEnabled(prod, "20261029T000000Z-abcdef12", null), false);
  // Dev and tests: no NODE_ENV, no release.json, the test runner, loopback upstreams, the fake launchd.
  assert.equal(sentryEnabled({}, "20261029T000000Z-abcdef12", DSN), false);
  assert.equal(sentryEnabled({ NODE_ENV: "development" }, "r", DSN), false);
  assert.equal(sentryEnabled(prod, null, DSN), false);
  assert.equal(sentryEnabled({ ...prod, NODE_TEST_CONTEXT: "child-v8" }, "r", DSN), false);
  assert.equal(sentryEnabled({ ...prod, CONNECTORS_ALLOW_LOOPBACK_UPSTREAMS: "1" }, "r", DSN), false);
  assert.equal(sentryEnabled({ ...prod, CONNECTORS_SENTRY: "0" }, "r", DSN), false);
});

test("this test process would never report", () => {
  assert.equal(sentryEnabled(process.env, "r", DSN), false);
});

test("only programming errors from a tool call count as gateway bugs", () => {
  assert.equal(looksLikeBug(new TypeError("Cannot read properties of undefined (reading 'x')")), true);
  assert.equal(looksLikeBug(new ReferenceError("x is not defined")), true);
  assert.equal(looksLikeBug(new RangeError("Maximum call stack size exceeded")), true);
  assert.equal(looksLikeBug(new TypeError("fetch failed")), false);
  assert.equal(looksLikeBug(new TypeError("terminated", { cause: new Error("socket") })), false);
  assert.equal(looksLikeBug(new SyntaxError("Unexpected token < in JSON")), false);
  assert.equal(looksLikeBug(new Error("HTTP 502 from Notion")), false);
});

test("redact removes tokens, codes, emails and long secrets", () => {
  const token = `cn_claude-work_${"ab".repeat(32)}`;
  const out = redact(
    `bad ${token} Bearer sk-live-123 ya29.a0AfH6SM-x_y 1//0gLongRefreshTokenValue12345 ` +
      `https://studio.example/oauth/callback?code=abc&state=def sam@example.com ${"Z".repeat(48)}`,
  );
  assert.doesNotMatch(out, /cn_claude|sk-live|ya29|1\/\/0g|code=|sam@|ZZZZ/);
  assert.match(out, /https:\/\/studio\.example\/oauth\/callback\?\[redacted\]/);
});

test("scrubEvent keeps the error and drops everything else", () => {
  const event = {
    type: undefined,
    message: "Bearer abc.def",
    request: { headers: { authorization: "Bearer x" }, data: "{}" },
    user: { ip_address: "1.2.3.4" },
    extra: { args: { to: "someone" } },
    breadcrumbs: [{ message: "tool result" }],
    exception: {
      values: [
        {
          type: "TypeError",
          value: "boom for Bearer secret-token",
          stacktrace: { frames: [{ filename: "connectors.mjs", lineno: 1, vars: { token: "x" }, context_line: "x" }] },
        },
      ],
    },
  } as unknown as ErrorEvent;
  const out = scrubEvent(event);
  assert.equal(out.request, undefined);
  assert.equal(out.user, undefined);
  assert.equal(out.extra, undefined);
  assert.equal(out.breadcrumbs, undefined);
  assert.equal(out.message, "Bearer [redacted]");
  const exception = out.exception!.values![0]!;
  assert.equal(exception.type, "TypeError");
  assert.equal(exception.value, "boom for Bearer [redacted]");
  assert.deepEqual(exception.stacktrace!.frames![0], { filename: "connectors.mjs", lineno: 1 });
});
