// The setup checklist at the top of /admin: one row per thing a fresh
// install still needs, worked out from what the server already knows. A
// pure function, so the rules are tested without a gateway.
//
// An agent counts as wired once it has a token. That's what
// install-clients.sh (or `connectors agent add`) leaves behind, and it
// doesn't lapse. Its last call is shown as a second signal but doesn't
// decide anything: the call log only records tool calls and keeps 90 days,
// so a wired agent that hasn't used a tool lately would go red again.

import type { UpstreamState } from "./upstreams.ts";

export const README_URL = "https://github.com/mikecann/plugbear";

export type SetupServiceInput = {
  id: string;
  title: string;
  state: UpstreamState;
  // Whether the owner signs in to it from the admin page.
  signsIn: boolean;
  // Gmail and Google Calendar: needs the owner's own Google OAuth client.
  google: boolean;
  accountEmail?: string;
  // The gateway's own message for needs_setup (never upstream text).
  lastError?: string;
};

export type SetupAgentInput = {
  id: string;
  title: string;
  // The client install-clients.sh wires for it, if any.
  clientType?: string;
  hasToken: boolean;
  lastCall?: number;
};

export type SetupInput = {
  services: SetupServiceInput[];
  agents: SetupAgentInput[];
  // <publicUrl>/mcp, for agents that are wired by hand.
  mcpUrl: string;
};

/** What a row's button does while the step is still to do. */
export type SetupAction =
  | { kind: "connect"; upstream: string }
  | { kind: "retry"; upstream: string }
  | { kind: "open"; href: string }
  | { kind: "link"; label: string; href: string }
  | { kind: "command"; label: string; command: string; note: string; href: string };

export type SetupStep = {
  // Stable for the life of the process, so the page can update rows by id.
  id: string;
  title: string;
  line: string;
  done: boolean;
  action?: SetupAction;
};

export type SetupSummary = {
  steps: SetupStep[];
  todo: number;
  heading: string;
};

const shortDate = new Intl.DateTimeFormat("en-AU", { day: "numeric", month: "short" });

function serviceStep(service: SetupServiceInput): SetupStep {
  const id = `service:${service.id}`;
  const base = { id, title: service.title };
  switch (service.state) {
    case "ready":
      return {
        ...base,
        done: true,
        line: !service.signsIn
          ? "No sign-in needed"
          : service.accountEmail
            ? `Signed in as ${service.accountEmail}`
            : "Signed in",
      };
    case "needs_sign_in":
      return {
        ...base,
        done: false,
        line: "Sign in once for every agent",
        action: { kind: "connect", upstream: service.id },
      };
    case "needs_setup":
      return {
        ...base,
        done: false,
        line: service.lastError ?? "Needs setting up first",
        action: {
          kind: "link",
          label: "How",
          href: `${README_URL}#${service.google ? "gmail-and-google-calendar" : "add-a-service"}`,
        },
      };
    case "error":
      return { ...base, done: false, line: "Not reachable", action: { kind: "retry", upstream: service.id } };
    case "idle":
    case "connecting":
    case "disabled":
      return {
        ...base,
        done: false,
        line: "Connecting",
        action: { kind: "open", href: `/admin/connect/${encodeURIComponent(service.id)}` },
      };
  }
}

function agentStep(agent: SetupAgentInput, mcpUrl: string): SetupStep {
  const id = `agent:${agent.id}`;
  if (agent.hasToken) {
    return {
      id,
      title: agent.title,
      done: true,
      line: agent.lastCall ? `Wired, last call ${shortDate.format(new Date(agent.lastCall))}` : "Wired, no calls yet",
    };
  }
  const href = `${README_URL}#wire-your-agents`;
  // An agent with a client is wired by install-clients.sh, from the repo
  // on the Mac the agent runs on; one without gets a token by hand.
  const action: SetupAction = agent.clientType
    ? {
        kind: "command",
        label: "Wire",
        note: "In your PlugBear folder, on the Mac this agent runs on:",
        command: `scripts/install-clients.sh --only ${agent.id}`,
        href,
      }
    : {
        kind: "command",
        label: "Wire",
        note: `On the gateway's Mac, then point the client at ${mcpUrl} with the token as a Bearer header:`,
        command: `connectors agent add ${agent.id}`,
        href,
      };
  return { id, title: agent.title, done: false, line: "Not wired yet", action };
}

export function setupSteps(input: SetupInput): SetupSummary {
  const steps = [
    // A service that's turned off is off on purpose, so it isn't a step.
    ...input.services.filter((service) => service.state !== "disabled").map(serviceStep),
    ...input.agents.map((agent) => agentStep(agent, input.mcpUrl)),
  ];
  const todo = steps.filter((step) => !step.done).length;
  return { steps, todo, heading: todo === 0 ? "All set" : `${todo} to do` };
}
