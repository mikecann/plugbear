import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { type SetupAgentInput, type SetupServiceInput, setupSteps } from "./setup.ts";

const MCP_URL = "https://studio.example.ts.net:8443/mcp";

function service(extra: Partial<SetupServiceInput> = {}): SetupServiceInput {
  return { id: "notion", title: "Notion", state: "ready", signsIn: true, google: false, ...extra };
}

function agent(extra: Partial<SetupAgentInput> = {}): SetupAgentInput {
  return { id: "codex", title: "Codex", clientType: "codex", hasToken: true, ...extra };
}

describe("setupSteps", () => {
  it("is all set when every service is ready and every agent has a token", () => {
    const setup = setupSteps({
      services: [service(), service({ id: "deepwiki", title: "DeepWiki", signsIn: false })],
      agents: [agent()],
      mcpUrl: MCP_URL,
    });
    assert.equal(setup.todo, 0);
    assert.equal(setup.heading, "All set");
    assert.deepEqual(
      setup.steps.map((step) => [step.id, step.done, step.line]),
      [
        ["service:notion", true, "Signed in"],
        ["service:deepwiki", true, "No sign-in needed"],
        ["agent:codex", true, "Wired, no calls yet"],
      ],
    );
    assert.ok(setup.steps.every((step) => step.action === undefined));
  });

  it("counts what's left to do", () => {
    const setup = setupSteps({
      services: [service({ state: "needs_sign_in" }), service({ id: "sentry", title: "Sentry" })],
      agents: [agent({ hasToken: false }), agent({ id: "grok", title: "Grok", clientType: "grok", hasToken: false })],
      mcpUrl: MCP_URL,
    });
    assert.equal(setup.todo, 3);
    assert.equal(setup.heading, "3 to do");
  });

  it("offers Connect for a service that needs signing in", () => {
    const [step] = setupSteps({ services: [service({ state: "needs_sign_in" })], agents: [], mcpUrl: MCP_URL }).steps;
    assert.equal(step!.done, false);
    assert.deepEqual(step!.action, { kind: "connect", upstream: "notion" });
  });

  it("points Google services without a client at the README's Gmail section", () => {
    const [step] = setupSteps({
      services: [
        service({
          id: "gmail",
          title: "Gmail",
          google: true,
          state: "needs_setup",
          lastError: "Needs a Google OAuth client in secrets/clients/google.json.",
        }),
      ],
      agents: [],
      mcpUrl: MCP_URL,
    }).steps;
    assert.equal(step!.line, "Needs a Google OAuth client in secrets/clients/google.json.");
    assert.equal(step!.action?.kind, "link");
    assert.match((step!.action as { href: string }).href, /#gmail-and-google-calendar$/);
  });

  it("offers Try again for a service that isn't reachable, without its error text", () => {
    const [step] = setupSteps({
      services: [service({ state: "error", lastError: "upstream said <something>" })],
      agents: [],
      mcpUrl: MCP_URL,
    }).steps;
    assert.equal(step!.line, "Not reachable");
    assert.deepEqual(step!.action, { kind: "retry", upstream: "notion" });
  });

  it("links a service that's still connecting to its own page", () => {
    for (const state of ["idle", "connecting"] as const) {
      const [step] = setupSteps({ services: [service({ state })], agents: [], mcpUrl: MCP_URL }).steps;
      assert.equal(step!.done, false);
      assert.deepEqual(step!.action, { kind: "open", href: "/admin/connect/notion" });
    }
  });

  it("leaves services that are turned off out", () => {
    const setup = setupSteps({ services: [service({ state: "disabled" })], agents: [], mcpUrl: MCP_URL });
    assert.deepEqual(setup.steps, []);
    assert.equal(setup.heading, "All set");
  });

  it("shows the signed-in Google account", () => {
    const [step] = setupSteps({
      services: [service({ id: "gcal", title: "Google Calendar", google: true, accountEmail: "sam@example.com" })],
      agents: [],
      mcpUrl: MCP_URL,
    }).steps;
    assert.equal(step!.line, "Signed in as sam@example.com");
  });

  it("counts an agent as wired once it has a token, whether or not it has called in", () => {
    const lastCall = Date.UTC(2026, 9, 30, 12);
    const [called, quiet] = setupSteps({
      services: [],
      agents: [agent({ lastCall }), agent({ id: "grok", title: "Grok" })],
      mcpUrl: MCP_URL,
    }).steps;
    assert.equal(called!.done, true);
    assert.match(called!.line, /^Wired, last call 30 Oct$/);
    assert.equal(quiet!.done, true);
    assert.equal(quiet!.line, "Wired, no calls yet");
  });

  it("gives the install-clients command for an agent with a client", () => {
    const [step] = setupSteps({ services: [], agents: [agent({ hasToken: false })], mcpUrl: MCP_URL }).steps;
    assert.equal(step!.done, false);
    assert.equal(step!.line, "Not wired yet");
    assert.equal(step!.action?.kind, "command");
    const action = step!.action as { command: string; href: string };
    assert.equal(action.command, "scripts/install-clients.sh --only codex");
    assert.match(action.href, /#wire-your-agents$/);
  });

  it("gives `connectors agent add` and the MCP URL for an agent without a client", () => {
    const [step] = setupSteps({
      services: [],
      agents: [agent({ id: "studio-bot", title: "Studio bot", clientType: undefined, hasToken: false })],
      mcpUrl: MCP_URL,
    }).steps;
    const action = step!.action as { command: string; note: string };
    assert.equal(action.command, "connectors agent add studio-bot");
    assert.ok(action.note.includes(MCP_URL));
  });
});
