// Server-rendered admin and approval pages. Plain copy: no eyebrow or
// kicker labels and no em dashes.

import { expiredAfterApproval } from "./approvals.ts";
import type { AgentConfig } from "./config.ts";
import type { ApprovalRecord, CallRecord } from "./db.ts";
import { Html, html } from "./html.ts";
import type { UpstreamConnection, UpstreamState } from "./upstreams.ts";

const dateFormat = new Intl.DateTimeFormat("en-AU", {
  dateStyle: "medium",
  timeStyle: "medium",
});

export function formatTime(ms: number | null | undefined): string {
  return ms ? dateFormat.format(new Date(ms)) : "";
}

const STYLE = `
:root {
  color-scheme: light dark;
  --bg: #f6f6f3; --card: #ffffff; --text: #1d1d1f; --muted: #6e6e73; --line: #e4e4e0; --soft: #f1f1ee;
  --accent: #2f6fdb; --ok: #2f9e5b; --warn: #d9822b; --bad: #d64545; --off: #b0b0b0;
  --shadow: 0 1px 2px rgba(0,0,0,0.04), 0 4px 16px rgba(0,0,0,0.04);
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #161617; --card: #1f1f21; --text: #ececee; --muted: #9a9aa0; --line: #2e2e31; --soft: #262628;
    --accent: #6ea2ff; --ok: #4cc27c; --warn: #f0a050; --bad: #ff6b6b; --off: #5c5c60;
    --shadow: none;
  }
}
* { box-sizing: border-box; }
body { font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 0; background: var(--bg); color: var(--text); -webkit-font-smoothing: antialiased; }
a { color: var(--accent); text-decoration: none; }
a:hover { text-decoration: underline; }
nav { display: flex; align-items: center; gap: 1.5rem; max-width: 60rem; margin: 0 auto; padding: 1.1rem 1.5rem; }
nav .brand { display: flex; align-items: center; gap: 0.5rem; color: var(--text); font-weight: 650; margin-right: auto; }
nav .brand svg { width: 18px; height: 18px; }
nav a { color: var(--muted); font-size: 0.95rem; }
nav a.here { color: var(--text); }
nav a:hover { color: var(--text); text-decoration: none; }
main { max-width: 60rem; margin: 0 auto; padding: 0.5rem 1.5rem 4rem; }
main.wide { max-width: 80rem; }
main.narrow { max-width: 30rem; padding-top: 3rem; }
h1 { font-size: 1.6rem; font-weight: 650; letter-spacing: -0.01em; margin: 0.75rem 0 1.25rem; }
h2 { font-size: 0.95rem; font-weight: 600; color: var(--muted); margin: 2rem 0 0.6rem; }\nh1 + h2, h1 + .section-head h2 { margin-top: 0; }
p { margin: 0.5rem 0; }
code, pre { font: 13px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace; }
code { background: var(--soft); padding: 0.05rem 0.35rem; border-radius: 5px; }
pre { white-space: pre-wrap; word-break: break-word; padding: 0.9rem 1rem; background: var(--soft); border-radius: 10px; max-height: 60vh; overflow: auto; margin: 0.5rem 0 1rem; }
.muted { color: var(--muted); }
.small { font-size: 0.85rem; }
.card { background: var(--card); border: 1px solid var(--line); border-radius: 14px; box-shadow: var(--shadow); }
.list { padding: 0; margin: 0; list-style: none; }
.list > li { display: flex; align-items: center; gap: 0.9rem; padding: 0.85rem 1.1rem; border-top: 1px solid var(--line); }
.list > li:first-child { border-top: 0; }
.list .grow { flex: 1; min-width: 0; }
.list .name { font-weight: 600; color: var(--text); }
.list .sub { color: var(--muted); font-size: 0.85rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dot { width: 9px; height: 9px; border-radius: 50%; flex: none; background: var(--off); }
.dot.ready { background: var(--ok); }
.dot.needs_sign_in, .dot.needs_setup { background: var(--warn); }
.dot.error { background: var(--bad); }
.dot.connecting { background: var(--accent); }
.pill { display: inline-flex; align-items: center; gap: 0.45rem; font-size: 0.85rem; padding: 0.2rem 0.65rem; border-radius: 999px; background: var(--soft); }
.monogram { width: 52px; height: 52px; border-radius: 14px; background: var(--soft); display: grid; place-items: center; font-size: 1.4rem; font-weight: 650; color: var(--muted); margin-bottom: 1rem; }
.panel { padding: 1.75rem; }
.panel h1 { margin: 0 0 0.6rem; }
.actions { display: flex; gap: 0.5rem; flex-wrap: wrap; align-items: center; }
.panel .actions { margin-top: 1.5rem; }
.panel .actions form:first-child button.primary { padding: 0.55rem 1.4rem; }
.flash { padding: 0.75rem 1rem; border-radius: 10px; margin-bottom: 1rem; background: var(--card); border: 1px solid var(--line); }
.flash.error { border-color: var(--bad); }
form.inline { display: inline; margin: 0; }
button { font: inherit; font-size: 0.9rem; padding: 0.35rem 0.9rem; border-radius: 8px; border: 1px solid var(--line); background: var(--card); color: var(--text); cursor: pointer; }
button:hover { background: var(--soft); }
button.primary, a.btn.primary { background: var(--accent); border-color: var(--accent); color: white; font-weight: 600; }
button.primary:hover, a.btn.primary:hover { filter: brightness(1.06); }
a.btn { display: inline-block; font-size: 0.9rem; padding: 0.35rem 0.9rem; border-radius: 8px; text-decoration: none; }
button.danger { color: var(--bad); }
textarea { font: inherit; width: 100%; min-height: 4.5rem; padding: 0.6rem 0.75rem; border-radius: 10px; border: 1px solid var(--line); background: var(--card); color: var(--text); }
select { font: inherit; padding: 0.3rem 0.5rem; border-radius: 8px; border: 1px solid var(--line); background: var(--card); color: var(--text); }
dl { display: grid; grid-template-columns: max-content 1fr; gap: 0.5rem 1.5rem; margin: 1.25rem 0 0; }
dt { color: var(--muted); } dd { margin: 0; min-width: 0; overflow-wrap: anywhere; }
details.info { display: inline-block; position: relative; }
details.info summary { list-style: none; cursor: pointer; color: var(--muted); font-size: 0.85rem; }
details.info summary::-webkit-details-marker { display: none; }
details.info[open] summary { color: var(--text); }
details.info .tip { position: absolute; right: 0; top: 1.6rem; z-index: 2; width: 18rem; padding: 0.75rem 0.9rem; font-size: 0.85rem; background: var(--card); border: 1px solid var(--line); border-radius: 10px; box-shadow: var(--shadow); }
.section-head { display: flex; align-items: baseline; justify-content: space-between; }
table { border-collapse: collapse; width: 100%; font-size: 0.9rem; }
th, td { text-align: left; padding: 0.6rem 0.9rem; border-top: 1px solid var(--line); vertical-align: top; }
thead th { border-top: 0; color: var(--muted); font-weight: 500; font-size: 0.8rem; }
td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
.card table details summary { cursor: pointer; color: var(--muted); }
.filters { display: flex; gap: 0.75rem; flex-wrap: wrap; align-items: end; margin-bottom: 1rem; }
.filters label { display: flex; flex-direction: column; gap: 0.2rem; font-size: 0.8rem; color: var(--muted); }
.decide { padding: 1.25rem; margin-top: 1.25rem; }
.decide label { color: var(--muted); font-size: 0.85rem; }
.decide .actions { margin-top: 0.9rem; }
@media (max-width: 640px) { .list > li { flex-wrap: wrap; } table { display: block; overflow-x: auto; } }
`;

// A plug, drawn inline: the pages' CSP allows no images.
const PLUG = new Html(
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 2v5M15 2v5M6 7h12v4a6 6 0 0 1-12 0V7zM12 17v5"/></svg>`,
);

type Section = "services" | "calls" | "sends" | "";

export function page(title: string, body: Html, options: { section?: Section; width?: "wide" | "narrow" } = {}): string {
  const here = (section: Section) => (options.section === section ? "here" : "");
  return html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="same-origin">
<title>${title}</title>
<style>${new Html(STYLE)}</style>
</head>
<body>
<nav><a class="brand" href="/admin">${PLUG}Connectors</a><a class="${here("services")}" href="/admin">Services</a><a class="${here("calls")}" href="/admin/calls">Calls</a><a class="${here("sends")}" href="/admin/calls?view=sends">Sends</a></nav>
<main class="${options.width ?? ""}">${body}</main>
</body>
</html>`.value;
}

const STATE_LABELS: Record<UpstreamState, string> = {
  disabled: "Turned off",
  idle: "Not connected yet",
  connecting: "Connecting",
  ready: "Connected",
  needs_sign_in: "Needs sign-in",
  needs_setup: "Needs setting up",
  error: "Not reachable",
};

export function stateLabel(state: UpstreamState): string {
  return STATE_LABELS[state];
}

type Csrf = (action: string) => string;

function postButton(action: string, path: string, label: string, csrf: Csrf, kind = ""): Html {
  return html`<form class="inline" method="post" action="${path}">
<input type="hidden" name="csrf" value="${csrf(action)}">
<button type="submit" class="${kind}">${label}</button></form>`;
}

// The services list shows only what needs doing (Connect, Try again);
// "Sign in again" and "Disconnect" live on the service's own page.
function upstreamActions(connection: UpstreamConnection, csrf: Csrf, compact = false): Html {
  const id = encodeURIComponent(connection.id);
  const connected = connection.state === "ready";
  const buttons: Html[] = [];
  if (connection.signsIn && !(compact && connected)) {
    buttons.push(
      postButton(
        `connect:${connection.id}`,
        `/admin/upstreams/${id}/connect`,
        connected ? "Sign in again" : "Connect",
        csrf,
        connected ? "" : "primary",
      ),
    );
  }
  if (!compact && connection.signsIn && connected) {
    buttons.push(
      postButton(`disconnect:${connection.id}`, `/admin/upstreams/${id}/disconnect`, "Disconnect", csrf, "danger"),
    );
  }
  if (connection.state === "error" || connection.state === "idle") {
    buttons.push(postButton(`retry:${connection.id}`, `/admin/upstreams/${id}/retry`, "Try again", csrf));
  }
  return html`${buttons}`;
}

function kindLabel(connection: UpstreamConnection): string {
  const config = connection.config;
  if (config.type === "google") return "Google sign-in";
  if (config.type === "stdio") return "local command";
  return config.auth.type === "none" ? "no sign-in" : config.auth.type;
}

export type AdminView = {
  connections: UpstreamConnection[];
  agents: { agent: AgentConfig; hasToken: boolean; upstreams: string[]; lastCall?: number }[];
  pending: ApprovalRecord[];
  agentTitles: Map<string, string>;
  flash?: { text: string; error?: boolean };
  csrf: Csrf;
};

// The one line under a service's name: what it's doing, in a few words.
function serviceLine(connection: UpstreamConnection): string {
  if (connection.state === "ready") {
    const count = `${connection.tools.length} tools`;
    return connection.accountEmail ? `${count}, signed in as ${connection.accountEmail}` : count;
  }
  return connection.lastError ?? stateLabel(connection.state);
}

function info(text: Html | string): Html {
  return html`<details class="info"><summary title="More about this">ⓘ</summary><div class="tip">${text}</div></details>`;
}

export function adminPage(view: AdminView): string {
  const flash = view.flash
    ? html`<div class="flash ${view.flash.error ? "error" : ""}">${view.flash.text}</div>`
    : "";
  const pending = view.pending.length
    ? html`<h2>Waiting for your approval</h2>
<ul class="list card">
${view.pending.map(
  (record) => html`<li><span class="dot needs_sign_in"></span>
<div class="grow"><div class="name">${view.agentTitles.get(record.agent) ?? record.agent}</div><div class="sub"><code>${record.tool}</code> ${formatTime(record.createdAt)}</div></div>
<a class="btn primary" href="/approvals/${encodeURIComponent(record.id)}">Review</a></li>`,
)}
</ul>`
    : "";
  const services = html`<div class="section-head"><h2>Services</h2>${info(
    "Each service's tools reach every agent with a prefix, like gmail__search_threads. A service that's signed out shows agents a sign_in tool pointing back here.",
  )}</div>
<ul class="list card">
${view.connections.map(
  (connection) => html`<li>
<span class="dot ${connection.state}" title="${stateLabel(connection.state)}"></span>
<div class="grow"><a class="name" href="/admin/connect/${encodeURIComponent(connection.id)}">${connection.config.title}</a>
<div class="sub" title="${connection.id}, ${kindLabel(connection)}, tools start with ${connection.config.prefix}__">${serviceLine(connection)}</div></div>
<div class="actions">${upstreamActions(connection, view.csrf, true)}</div>
</li>`,
)}
</ul>`;
  const agents = html`<h2>Agents</h2>
<ul class="list card">
${view.agents.map(
  (row) => html`<li><span class="dot ${row.hasToken ? "ready" : ""}" title="${row.hasToken ? "Has a token" : "No token yet"}"></span>
<div class="grow"><div class="name">${row.agent.title}</div>
<div class="sub">${row.upstreams.length ? row.upstreams.join(", ") : "Can't use anything yet"}</div></div>
<div class="muted small">${row.lastCall ? formatTime(row.lastCall) : "No calls yet"}</div></li>`,
)}
</ul>`;
  return page("Connectors", html`<h1>Connectors</h1>${flash}${pending}${services}${agents}`, { section: "services" });
}

export type ConnectView = {
  connection: UpstreamConnection;
  csrf: Csrf;
};

/**
 * One service's status and its Connect button, for other apps (Threadbear)
 * to link to: /admin/connect/<id>.
 */
export function connectPage(view: ConnectView): string {
  const { connection } = view;
  const title = connection.config.title;
  const email = connection.accountEmail;
  const intro =
    connection.state === "ready"
      ? `${title} is connected. Agents can use its ${connection.tools.length} tools.`
      : connection.signsIn
        ? `Sign in so agents can use ${title}.`
        : `${title} doesn't need a sign-in.`;
  const actions = upstreamActions(connection, view.csrf);
  return page(
    title,
    html`<div class="card panel">
<div class="monogram">${title.slice(0, 1).toUpperCase()}</div>
<h1>${title}</h1>
<span class="pill"><span class="dot ${connection.state}"></span>${stateLabel(connection.state)}</span>
<p class="muted" style="margin-top: 1rem">${intro}</p>
<dl>
${email ? html`<dt>Google account</dt><dd>${email}</dd>` : ""}
${connection.state !== "ready" && connection.lastError && !connection.lastError.startsWith(stateLabel(connection.state))
  ? html`<dt>Notes</dt><dd>${connection.lastError}</dd>`
  : ""}
<dt>Tools start with</dt><dd><code>${connection.config.prefix}__</code></dd>
</dl>
<div class="actions">${actions}</div>
</div>
<p class="small" style="text-align: center; margin-top: 1.25rem"><a href="/admin">All services</a></p>`,
    { section: "services", width: "narrow" },
  );
}

export type CallsView = {
  calls: CallRecord[];
  sends: boolean;
  filter: { agent?: string; upstream?: string; decision?: string };
  options: { agents: string[]; upstreams: string[]; decisions: string[] };
};

function select(name: string, label: string, values: string[], current?: string): Html {
  return html`<label>${label}<select name="${name}"><option value="">All</option>
${values.map((value) => html`<option value="${value}" ${value === current ? new Html("selected") : ""}>${value}</option>`)}
</select></label>`;
}

export function callsPage(view: CallsView): string {
  const title = view.sends ? "Sends" : "Calls";
  const intro = view.sends
    ? html`<p class="muted">Calls that needed your approval, newest first.</p>`
    : html`<p class="muted">The latest 200 calls, newest first.</p>`;
  const filters = html`<form class="filters" method="get" action="/admin/calls">
${view.sends ? html`<input type="hidden" name="view" value="sends">` : ""}
${select("agent", "Agent", view.options.agents, view.filter.agent)}
${select("upstream", "Service", view.options.upstreams, view.filter.upstream)}
${select("decision", "Decision", view.options.decisions, view.filter.decision)}
<button type="submit">Filter</button></form>`;
  const rows = view.calls.map(
    (call) => html`<tr>
<td>${formatTime(call.ts)}</td><td>${call.agent}</td><td>${call.upstream ?? ""}</td><td><code>${call.tool}</code></td>
<td>${call.approvalId ? html`<a href="/approvals/${encodeURIComponent(call.approvalId)}">${call.decision}</a>` : call.decision}</td>
<td>${call.ok === null ? "" : call.ok ? "Yes" : "No"}</td>
<td class="num">${call.durationMs ?? ""}</td><td class="num">${call.resultBytes ?? ""}</td>
<td>${call.error ? html`<div>${call.error}</div>` : ""}${call.argsJson ? html`<details><summary>Arguments</summary><pre>${call.argsJson}</pre></details>` : ""}</td>
</tr>`,
  );
  const table = view.calls.length
    ? html`<div class="card"><table><thead><tr><th>Time</th><th>Agent</th><th>Service</th><th>Tool</th><th>Decision</th><th>OK</th><th class="num">ms</th><th class="num">Bytes</th><th>Details</th></tr></thead>
<tbody>${rows}</tbody></table></div>`
    : html`<p>No calls yet.</p>`;
  return page(title, html`<h1>${title}</h1>${intro}${filters}${table}`, {
    section: view.sends ? "sends" : "calls",
    width: "wide",
  });
}

export type ApprovalView = {
  record: ApprovalRecord;
  agentTitle: string;
  upstreamTitle: string;
  csrf: string;
  now: number;
};

function approvalStatus(record: ApprovalRecord): string {
  switch (record.status) {
    case "pending":
      return "Waiting for you";
    case "approved":
      return `Approved. It runs if the agent picks it up by ${formatTime(record.expiresAt)}.`;
    case "ran":
      return "Approved and run";
    case "declined":
      return "Declined";
    case "expired":
      return expiredAfterApproval(record)
        ? "Approved, but the agent didn't pick it up in time, so it didn't run"
        : "Expired without an answer";
  }
}

// Until the call has run, the stored arguments are exactly what will be
// sent, and this page is the only place the owner sees them, so nothing is
// hidden. JSON.parse and JSON.stringify keep every key, "__proto__"
// included. Afterwards only the call log's copy is kept.
function prettyArgs(argsJson: string): string {
  try {
    return JSON.stringify(JSON.parse(argsJson), null, 2);
  } catch {
    return argsJson;
  }
}

export function approvalPage(view: ApprovalView): string {
  const { record } = view;
  const pending = record.status === "pending" && record.expiresAt > view.now;
  const full = record.status === "pending" || record.status === "approved";
  const form = pending
    ? html`<form class="card decide" method="post" action="/approvals/${encodeURIComponent(record.id)}">
<input type="hidden" name="csrf" value="${view.csrf}">
<label for="note">Note for the agent (optional)</label><textarea id="note" name="note" maxlength="2000"></textarea>
<div class="actions"><button type="submit" name="action" value="approve" class="primary">Approve</button>
<button type="submit" name="action" value="deny" class="danger">Deny</button></div>
</form>`
    : "";
  return page(
    `Approve ${record.tool}?`,
    html`<h1>${view.agentTitle} wants to run ${record.tool}</h1>
<div class="card panel"><dl style="margin: 0">
<dt>Status</dt><dd>${approvalStatus(record)}</dd>
<dt>Agent</dt><dd>${view.agentTitle} (${record.agent})</dd>
<dt>Service</dt><dd>${view.upstreamTitle}</dd>
<dt>Tool</dt><dd><code>${record.tool}</code></dd>
<dt>Asked</dt><dd>${formatTime(record.createdAt)}</dd>
${pending ? html`<dt>Expires</dt><dd>${formatTime(record.expiresAt)}</dd>` : html`<dt>Decided</dt><dd>${formatTime(record.decidedAt)}</dd>`}
${record.note ? html`<dt>Your note</dt><dd>${record.note}</dd>` : ""}
</dl></div>
<h2>Arguments</h2>
<p class="muted">${
  record.status === "pending"
    ? "Exactly what the agent will send if you approve."
    : full
      ? "Exactly what will be sent when the agent picks it up."
      : "As kept in the call log: secret-looking values are hidden and long ones are cut."
}</p>
<pre>${prettyArgs(record.argsJson)}</pre>
${form}`,
  );
}

export function messagePage(title: string, text: string): string {
  return page(
    title,
    html`<div class="card panel"><h1>${title}</h1><p class="muted">${text}</p></div>
<p class="small" style="text-align: center; margin-top: 1.25rem"><a href="/admin">Back to Connectors</a></p>`,
    { width: "narrow" },
  );
}
