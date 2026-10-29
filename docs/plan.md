# Connectors: one MCP gateway for every agent

The design, with the reasons. The README is the user guide.

## Why

People who run several agents run into the same wall: connectors belong to
one login of one app. Someone with four Claude logins (a pool, or work and
personal), Codex, Grok and Muse has to connect Notion, Gmail and the rest
once per Claude login, separately again in Codex, and not at all in the
others. Threads that go through a proxy, or move between logins, lose
claude.ai connectors entirely. Logins also come and go, so connector
sign-ins shouldn't depend on any of them.

Connectors is a small server the user runs (on their Mac, or on another
always-on Mac over Tailscale) that signs in to each service once and gives
every agent the same MCP URL. Because every call goes through it, it's also
the one place to log what agents send and to hold "ask first" rules for
things like sending email.

Words used below: the **owner** is the person who runs the gateway and
approves calls (settings call them `ownerName`); the **gateway machine** is
the Mac it runs on; the **agents' Mac** is where the agents run (often the
same machine).

## Scope of v1

In:
- Streamable HTTP MCP endpoint at `/mcp` that aggregates tools from upstream
  MCP servers, each tool named `<prefix>__<tool>`.
- Upstreams of three kinds: remote HTTP with OAuth (the gateway is the OAuth
  client), remote HTTP with no auth or a static bearer token, and local stdio
  servers started by the gateway.
- Per-agent bearer tokens, per-agent upstream allowlists.
- Policy rules per tool: `allow`, `ask` (the owner approves first) or `deny`.
- Approvals: hold the call, show an approval page, optional ntfy push.
- A call log in SQLite and a small admin page: upstream status, Connect
  buttons for sign-ins, pending approvals, recent calls.
- A CLI for agent tokens and status, and a script that wires every agent on
  the agents' Mac to the gateway.
- Two modes (added 29 Oct, see "Modes and admin access"): local, on this
  Mac's loopback only, and tailscale, published with `tailscale serve`.
- Install and deploy under launchd, to this Mac or another one over ssh.

Out of v1 (later): passkey-protected approvals, MCP elicitation-based
approvals, a public internet URL, Google services other than Gmail and
Calendar (added 29 Oct, see "Gmail and Google Calendar"), Slack (a
workspace admin has to approve an internal Slack app), Linux.

## Where it runs

- macOS on Apple silicon, as a LaunchAgent of the user who owns it, on the
  official Node build pinned in `ops/node.json` (26.12.1; `node:sqlite`
  truncates text at NUL on older Nodes), listening on `127.0.0.1:8795`
  only (`port` in settings). The heap is capped at 384 MB, so a leak
  restarts the gateway instead of squeezing whatever else the machine runs.
- The LaunchAgent's label is `launchdLabel` in settings,
  `local.connectors` by default. An install that started under another
  label keeps it by setting `launchdLabel`; changing it later needs the old
  job booted out by hand.
- Tailscale mode only: `tailscale serve --bg --https=<servePort>
  http://127.0.0.1:<port>` publishes it as
  `https://<machine>.<tailnet>.ts.net:<servePort>` (8443 by default).
- Data: `~/Library/Application Support/Connectors/` (`CONNECTORS_HOME`)
  - `app/` the live release (symlink into `releases/`), `node/` the pinned
    Node, `bin/connectors` the CLI by full path,
  - `config/` (added 29 Oct): this install's own `settings.json`,
    `upstreams.json`, `agents.json`, `policy.json`. None hold secrets, none
    are in the repo, and a deploy never touches them. Any that's missing
    comes from the example shipped in the release,
    `app/config/<name>.example.json`, per file, so an install only copies
    the files it changes.
  - `secrets/` (0700): `agents.json` (token hashes), `oauth/<upstream>.json`
    (client registration, tokens, PKCE verifier; 0600), `clients/<upstream>.json`
    for statically configured OAuth clients, `csrf-key`, `admin-key`
    (local mode), `ntfy-topic` (optional),
  - `state/connectors.sqlite` (call log, approvals, sign-in states, local
    mode's one-time login codes),
  - logs in `~/Library/Logs/connectors.log`.

### Settings (added 29 Oct)

`config/settings.json`, every field optional, overridden by environment
variables (`CONNECTORS_MODE`, `CONNECTORS_PORT`, `CONNECTORS_HOST`,
`CONNECTORS_PUBLIC_URL`, `CONNECTORS_ADMIN_LOGINS`, `CONNECTORS_OWNER`) and
by `serve` flags, for tests and one-off runs:

```json
{ "mode": "tailscale", "port": 8795,
  "publicUrl": "https://studio.example-tailnet.ts.net:8443",
  "adminLogins": ["sam@example.com"], "servePort": 8443,
  "ownerName": "Sam", "launchdLabel": "local.connectors" }
```

- `mode`: `local` (default) or `tailscale`.
- `publicUrl`: the base of every link the gateway hands out (approval
  pages, Connect pages, the sign-in stubs) and of the OAuth redirect URI.
  Local mode defaults it to `http://127.0.0.1:<port>` and refuses anything
  that isn't loopback; tailscale mode requires it. `serve` refuses to start
  on settings that don't fit together, before it listens.
- `ownerName`: what agent-facing text calls the owner ("Waiting for Sam to
  approve this", "Ask Sam to open ..."). Default "the user". The admin
  pages say "you".
- `sentryDsn`: optional. With one, the deployed gateway reports its own
  bugs, errors only and scrubbed of request data, tokens and arguments
  (`src/sentry.ts`). The repo has no DSN, so nobody's install reports
  anywhere it didn't choose.
- `gatewayHost`: only read on the agents' Mac, by `deploy.sh`,
  `install.sh` and `install-clients.sh`: the ssh host the gateway runs on.
  The gateway machine's own settings decide its port, mode and label.

`connectors init` writes `settings.json` (from its flags; in tailscale mode
it reads the tailnet name and the signed-in login from `tailscale status
--json` when they aren't given) and copies `agents.example.json` to
`agents.json`, but only if they're missing: it never overwrites.
`connectors settings --json` prints the settings in effect and which file
each config came from; the scripts read the gateway's settings through it
rather than parsing JSON themselves.

## Inbound: agents to gateway

- `POST /mcp` (and `GET`/`DELETE` if the transport needs them) with
  `Authorization: Bearer cn_<agentId>_<random>`. Tokens are compared by
  SHA-256 hash against `secrets/agents.json`. Unknown or missing token: plain
  401 with no `WWW-Authenticate` OAuth metadata. Do not serve
  `/.well-known/oauth-protected-resource` or any authorization server routes:
  Claude Code ignores a static header when the server advertises OAuth
  (anthropics/claude-code#59467), and not being an OAuth server is what keeps
  us clear of the confused-deputy problem.
- Must work with the common MCP clients. Each was verified against a local
  instance (versions current on 26 Oct 2026):
  - Claude Code 2.1.310 (protocol versions up to 2026-07-28),
  - Codex CLI 0.164.0 (2025-03-26 and 2026-07-28),
  - Grok CLI 1.0.70,
  - Muse 1.4.13 (2024-11-05 only, literal `headers` only).
  Use whichever `@modelcontextprotocol/*` SDK version serves both the
  session-based Streamable HTTP of 2025-xx and the stateless 2026-07-28 form
  (`@modelcontextprotocol/sdk` 1.32.2 and the split `@modelcontextprotocol/server`
  / `client` / `node` 2.x packages were current on 2026-10-26). Decide by testing.
- In tailscale mode, record `Tailscale-User-Login` (if present) in the call
  log, but never use it for agent auth: every device on the tailnet sends
  the same login. In local mode nothing sets it, so it isn't recorded.
- Strip the inbound `Authorization` header; never pass any client token
  upstream.
- Added after review: request bodies over 1 MB get a 413, one agent id may
  have at most 32 tool calls running at once (held ones included), and a
  result over 10 MB becomes an error result. The heap is capped at
  384 MB, and a burst of 4 MB calls could exhaust it.
- Added after review: 2026-07-28 clients are told about tool changes with
  `notifications/tools/list_changed` on their `subscriptions/listen`
  stream, so a service the owner connects shows up in open sessions. Claude Code
  opens that stream; Grok 1.0.70 doesn't. The gateway serves 2025-era
  clients (Codex, Muse) statelessly, with no stream to send it on. Those
  three see changes in their next session.
- Added after review: right after a start, `tools/list` waits at most 1 s
  (from the start) for upstreams to connect, never longer. Codex 0.164.0
  starts its turn without a server's tools when `tools/list` is slow, and
  keeps going without them for the whole session.

## Agents

`agents.json`, one entry per agent:

```json
{ "id": "claude-work", "title": "Claude (work login)", "upstreams": ["*", "!tag:personal"],
  "client": { "type": "claude", "configDir": "~/.claude-work" } }
```

`upstreams` is a list of upstream ids or globs. Upstreams can carry
`"tags": ["work"]`; agent entries can use `"!tag:work"`. The shipped example
has two agents, `claude` (`~/.claude`) and `codex`, with every upstream.

Added 29 Oct: `client` says which client on the agents' Mac uses this
agent's token, for `install-clients.sh`: `type` is `claude`, `codex`, `grok`
or `muse`, and `configDir` that client's config folder when it isn't the
default (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `GROK_HOME`, Muse's settings
folder; `~/` is the agents' Mac's home). The gateway ignores it apart from
checking it. It lives here, on the gateway machine, so there is one list
of agents even when the gateway runs elsewhere; `connectors agent list
--json` hands it to the script.

`connectors agent add <id>` prints a new token once and stores its hash.
`connectors agent rotate <id>`, `connectors agent list`.

## Upstreams

`upstreams.json` (the shipped example has Notion and DeepWiki on, and
Sentry, Cloudflare, Gmail and Calendar present with `"enabled": false`):

```json
[
  { "id": "notion", "title": "Notion", "prefix": "notion",
    "type": "http", "url": "https://mcp.notion.com/mcp", "auth": { "type": "oauth" } },
  { "id": "sentry", "title": "Sentry", "prefix": "sentry",
    "type": "http", "url": "https://mcp.sentry.dev/mcp", "auth": { "type": "oauth" } },
  { "id": "cloudflare", "title": "Cloudflare", "prefix": "cf",
    "type": "http", "url": "https://mcp.cloudflare.com/mcp", "auth": { "type": "oauth" } },
  { "id": "deepwiki", "title": "DeepWiki", "prefix": "deepwiki",
    "type": "http", "url": "https://mcp.deepwiki.com/mcp", "auth": { "type": "none" } }
]
```

- Optional fields: `enabled` (default true), `tags`, `scopes`, `timeoutMs`,
  `auth.type: "bearer"` with the token in `secrets/upstream-tokens/<id>`, and
  `auth.client: "static"` to use `secrets/clients/<id>.json`
  (`client_id`, `client_secret`) instead of registering (Slack, say).
- `type: "stdio"` with `command`, `args`, `env` (values may reference files in
  `secrets/` but never inline secrets). Commands come from config only, never
  from a request. Log every launch.
- Prefixes: lowercase `[a-z0-9]{1,10}`, unique. Tool names exposed as
  `<prefix>__<tool>`, sanitised to `[a-zA-Z0-9_-]`, max 64 characters (Codex
  and OpenAI function names cap at 64). If longer, truncate and append a short
  hash, and keep a reverse map.
- Added after testing: Grok 1.0.70 names MCP tools `<server>__<tool>` and
  drops any whose full name has a second `__`, so an agent entry can set
  `"toolSeparator": "_"` to get `<prefix>_<tool>` names with no `__` at all
  (set for `grok`). Policy rules, the call log and approvals always use
  `<prefix>__<tool>` with the upstream's own tool name. See
  `docs/client-compat.md`.
- Connect lazily on startup in the background; cache each upstream's tool
  list; refresh on `notifications/tools/list_changed` and every 10 minutes.
  An upstream that forgets our session (it restarted) is reconnected as soon
  as its event stream starts failing, not at the next call.
  A down or signed-out upstream contributes no tools and is shown on the
  admin page; it must never break `tools/list` for the others.
- Added 29 Oct: an enabled upstream that needs sign-in (or setting up)
  lists one stub tool, `<prefix>__sign_in` (`<prefix>_sign_in` for "_"
  agents), with no arguments. Its description and its answer say the
  service is signed out and that the agent should ask the owner to open
  `<public URL>/admin/connect/<id>`. Without it an agent looking for Gmail
  found nothing and didn't know to ask. It has no `outputSchema`, so no
  client checks its plain-text answer against one, and its name is short
  and has no second `__` for Grok. The stub appearing or going away counts
  as a tool change for `list_changed`. A call to it when the service is
  signed in again says to list tools again.
- Tool descriptions get a short suffix naming the upstream when the title is
  ambiguous (two Notion workspaces), e.g. "(Notion, work workspace)".
- SSRF guard: only call configured upstream URLs; HTTPS only; refuse
  redirects to private/LAN/loopback ranges.

### Upstream sign-in (OAuth client)

- Implement the SDK's `OAuthClientProvider` backed by `secrets/oauth/<id>.json`.
  Try a static client first, then client ID metadata documents if available
  without a public URL (skip it otherwise), then dynamic client registration.
- Redirect URI: `<publicUrl>/oauth/callback`, so it follows the mode:
  `http://127.0.0.1:8795/oauth/callback` in local mode (loopback redirect
  URIs are allowed for native apps, RFC 8252, and by the providers tried),
  `https://<machine>.<tailnet>.ts.net:8443/oauth/callback` in tailscale
  mode. Only the owner's browser follows it, so neither needs to be on the
  internet. A client registered under one URL keeps it, so changing mode or
  port means Disconnect and Connect again for dynamically registered
  services, and a new redirect URI on a static client (Google).
- Start a sign-in only from the admin page (`POST /admin/upstreams/<id>/connect`,
  CSRF-protected), which redirects the browser to the provider. `state` is
  single-use, bound to the upstream id, expires in 10 minutes. The callback
  finishes the exchange, stores tokens keyed by issuer, and redirects back to
  `/admin`. The pages' CSP must let that redirect through: Chrome checks
  `form-action` on redirects after a form post, so it is
  `form-action 'self' https:` (with only `'self'`, Chrome silently cancelled
  every Connect; found in review with a real browser).
- Refresh tokens through the SDK. On a refresh failure mark the upstream
  "needs sign-in" and keep serving the others. Added after review: at most
  one refresh per upstream at a time. Calls whose 401 arrives during a
  refresh wait for it, because providers that rotate refresh tokens (OAuth
  2.1 requires it for public clients) reject the second use of one, and the
  SDK then deletes the tokens the first refresh saved.
- `POST /admin/upstreams/<id>/disconnect` deletes its tokens.
- Added 29 Oct: `GET /admin/connect/<id>` (same access checks as `/admin`)
  shows one upstream's status and its Connect (or Try again) button, which
  posts to the route above with a CSRF token. Threadbear and the sign-in
  stubs link here, so the path is fixed.

### Gmail and Google Calendar (added 29 Oct)

Google's hosted MCP servers (gmailmcp.googleapis.com,
calendarmcp.googleapis.com) only take Workspace accounts in the Workspace
Developer Preview, not personal Gmail accounts. So the gateway signs in to
Google itself and runs a small built-in stdio server per service. Each
install needs its own Google Cloud project and OAuth client: one shared
client for everyone would need Google's paid security assessment for Gmail
scopes. The README walks through it, including the "Google hasn't verified
this app" screen, which stays, since it's the owner's own unverified app.

- Config: `{ "type": "google", "service": "gmail" | "calendar", "account":
  "google" }`, ids `gmail` (prefix `gmail`) and `gcal` (prefix `gcal`), so
  the policy's `gmail__send*` and `gcal__*event*` rules apply as written.
- Upstreams with the same `account` share one sign-in. The Google "Web
  application" client is in `secrets/clients/<account>.json` (`client_id`,
  `client_secret`, flat or as the console downloads it under `web`), the
  tokens in `secrets/oauth/<account>.json` (0600). An account id can't be
  another upstream's id. Without the client file both upstreams are
  `needs_setup`, start no process, and don't affect the others.
- Sign-in reuses Connect and `/oauth/callback` (single-use state bound to
  the upstream id, CSRF, admin access). The authorization request has
  `access_type=offline`, `prompt=consent` (so a refresh token always comes
  back), PKCE S256, and the union of the account's scopes plus
  `openid email`, so the admin pages can show which Google account signed in
  (the same browser often has a work account too). The email is never in
  `/health` or the logs.
- Scopes: Gmail `gmail.readonly`, `gmail.compose`; Calendar
  `calendar.readonly`, `calendar.events`. If the owner unticks one service on
  Google's consent screen, that upstream stays signed out ("Google didn't
  grant access to ...") and the other works.
- Tokens: only the gateway reads the client and token files. It refreshes
  the access token two minutes before expiry, at most one refresh per
  account at a time, and sends the access token to the stdio server in each
  `tools/call`'s `_meta` (`connectors/google-access-token`).
  The server never sees the refresh token or client secret, logs nothing
  about calls, and makes no request without that token. If Google answers
  401, the server marks the result's `_meta`, and the gateway refreshes and
  retries once. `invalid_grant` on refresh deletes the tokens and marks
  every upstream on the account signed out ("Google sign-in expired or was
  revoked"); nothing else stops. The 10-minute refresh also checks the
  token, so a revoked sign-in shows within about an hour without a call.
  Disconnect on either upstream signs both out.
- The server (`src/google/server.ts`, built to `dist/google-mcp.mjs`) is a
  dependency-free newline-delimited JSON-RPC loop speaking the 2025-era
  protocol, started with `--max-old-space-size=64`, only once the account
  is signed in. It calls `gmail.googleapis.com` and
  `www.googleapis.com/calendar/v3` only, with redirects refused.
- Tools. Gmail: `search_threads`, `get_thread`, `get_message`,
  `list_labels`, `create_draft`, `send_message` (plain text; `to`, `cc`,
  `bcc` lists, `replyToMessageId` threads a reply). No "send draft": its
  approval page would show only a draft id. Calendar: `list_calendars`,
  `list_events` (time range, free-text query, recurring events expanded),
  `get_event`, `create_event`, `update_event` (patch). `update_event`
  refuses to change an event that has guests unless the call lists the
  attendees, so the `ifArgs: ["attendees"]` rule holds it and the owner sees the
  guest list. `notifyGuests` (default on when there are guests) sets
  `sendUpdates`.
- The OAuth consent screen must be "In production": in testing mode Google
  expires refresh tokens after 7 days.

## Policy and approvals

`config/policy.json`: ordered rules, first match wins, then `default`.

```json
{
  "default": "allow",
  "rules": [
    { "tool": "*__*send*", "action": "ask" },
    { "tool": "*__*reply*", "action": "ask" },
    { "tool": "*__*forward*", "action": "ask" },
    { "tool": "*__*post_message*", "action": "ask" },
    { "tool": "*__*delete*", "action": "ask" },
    { "tool": "*__*trash*", "action": "ask" },
    { "tool": "*__*share*", "action": "ask" },
    { "tool": "*__*permission*", "action": "ask" },
    { "tool": "*__*invite*", "action": "ask" },
    { "tool": "gcal__*event*", "ifArgs": ["attendees"], "action": "ask" }
  ]
}
```

- Rules may be scoped with `"agents": [...]`. `ifArgs` matches when any listed
  argument is present and non-empty. Agents edit pages all day, so page
  edits stay `allow`; only things that reach other people or can't be
  undone ask. Asking for everything would train the owner to approve
  without reading.
- `ask`:
  1. Store a pending approval (id, agent, upstream, tool, arguments, created,
     expires in 24 h) in SQLite.
  2. Notify: if `secrets/ntfy-topic` exists, POST to `https://ntfy.sh/<topic>`
     with only a title ("Codex wants to run gmail__send_message")
     and a click URL to the approval page. Never put arguments in the push.
  3. Hold the MCP call up to 45 s (Codex's default tool timeout is 60 s). If
     approved in time, forward it and return the real result. If denied,
     return an error result: "<Owner> declined this call." with their note
     if any.
  4. If still pending, return a normal (non-error) text result: "Waiting for
     <owner> to approve this at <url>. Tell <owner>, then call
     connectors__await_approval with id <id>. Don't try to approve it
     yourself." The approval id is bound to the agent that made the call.
     Added after review: that result has no structured content, which
     Claude Code and the MCP SDK clients reject for a tool that declared an
     `outputSchema`. So `tools/list` drops `outputSchema` from any tool the
     policy could hold for that agent (an `ask` rule with `ifArgs` counts).
     Its results still carry `structuredContent`.
  5. Added after review: an approved call has to run within an hour of the
     approval; after that it expires and the agent is told to make the call
     again. Otherwise an old approval could be picked up and run days later.
  6. Added after review: no approval for a service that needs signing in
     (the agent is told to ask the owner to connect it), and at most 20
     calls per agent waiting for approval at once.
  7. Added after review: when the gateway shuts down (every deploy), held
     calls answer at once with their approval id, so the agent can still
     await it after the restart, and running calls get 3 seconds to finish.
- Built-in tool `connectors__await_approval {id}` (always listed): waits up to
  45 s more; on approval runs the original call (exactly once) and returns
  its result; on denial or expiry says so; for another agent's id returns an
  error.
- Built-in tool `connectors__status`: lists upstreams this agent can use and
  whether each is signed in, so an agent can tell the owner what to connect.
- Approval page `/approvals/<id>`: agent, tool, upstream, pretty-printed
  arguments, Approve and Deny buttons, optional note. Approve and deny are
  POSTs with a CSRF token from the page. Changed after review: until the
  call runs, the page shows the arguments exactly as they will be sent,
  secret-looking values included, because it's the owner's only look at them;
  afterwards only the call log's redacted copy is kept. Arguments with a
  `__proto__` key anywhere are refused before the policy runs (a JavaScript
  upstream merging them could pick up values the owner never saw).
- Threat model, written down in the README: the gateway protects against an
  agent sending something by mistake. It does not protect against a rogue
  program running as the owner on the agents' Mac, which can read tokens
  from the Keychain, sign a browser in with `connectors open`, or reach the
  admin pages through Tailscale as the owner. Passkey-protected approvals
  are a later upgrade.

## Call log

SQLite table `calls`: id, ts, agent, tailscaleLogin, upstream, tool,
argsJson (truncated to 16 KB), argsSha256, decision (`allow`, `deny`,
`approved`, `declined`, `expired`), approvalId, durationMs, ok, error,
resultBytes. Keep 90 days; prune daily. The admin page shows the latest 200
with a filter by agent, upstream and decision, and a "sends" view (calls whose
decision came from an `ask` rule).

## Admin pages

Plain server-rendered HTML, no build step. Banner messages are kept on the
server and passed by id, never as text in the query string. Pages: `/admin`
(upstreams with status, tool count, Connect/Disconnect; agents; pending
approvals), `/admin/connect/<id>`, `/admin/calls`, `/approvals/<id>`. Keep
copy plain: no eyebrow or kicker labels, no em dashes. `GET /health` returns
JSON `{ ok, version, release, upstreams: { <id>: status } }` without auth.
Changed 29 Oct (Threadbear reads it, so keep it stable): each status is
`{ id, title, state, message, connectUrl, tools }`, `state` one of
`connected`, `connecting`, `signed_out`, `needs_setup`, `error`,
`disabled`, and `message` a fixed sentence from the gateway (an upstream's
own error text stays on the admin page). No emails or secrets.

Who may use `/admin*`, `/approvals/*` and `/oauth/*` depends on the mode.
Both modes check, on every POST, a CSRF token (an HMAC of the identity and
the action, keyed by `secrets/csrf-key`), `Sec-Fetch-Site` (only
`same-origin` or `none`) and `Origin` (only the gateway's own).

### Modes and admin access (added 29 Oct)

**Tailscale mode.** Requests must arrive through `tailscale serve`, i.e.
carry `Tailscale-User-Login`; direct loopback requests without it are
refused. Added after review: the login must also be in `adminLogins`, so
another tailnet user or a shared node can't approve or connect anything.
This is what the first deployment ran, unchanged.

**Local mode.** No Tailscale, so no login header to lean on. The gateway
listens on 127.0.0.1 only, and anything that can open a socket to it is on
this Mac. What's left to stop:

1. Other web pages in the owner's browser. Any site can make the browser
   send requests to `http://127.0.0.1:8795`.
   - Cross-site POSTs (CSRF): refused by the CSRF token, which a page on
     another origin can't read, and by the `Origin` and `Sec-Fetch-Site`
     checks. A page on `127.0.0.1:3000` (a dev server running npm
     packages, say) is same-site with the gateway, since sites ignore
     ports, but not same-origin, so it's refused too.
   - Reading the pages: the browser's same-origin policy stops a page on
     another origin from reading the responses, and the pages can't be
     framed (`frame-ancestors 'none'`, `X-Frame-Options: DENY`).
   - DNS rebinding: a page on `evil.example` can point its name at
     127.0.0.1, and then its requests are same-origin with itself and it
     can read the answers (approval arguments, the call log) and post with
     tokens it read. Refused by checking `Host`: it must be
     `127.0.0.1:<port>`, `localhost:<port>`, `[::1]:<port>` or
     `publicUrl`'s host. A rebinding page still sends its own name.
2. Other users on the same Mac, who can reach 127.0.0.1 too, and anything
   we didn't think of in (1). A per-install key: `secrets/admin-key` (0600,
   made on first start) keys a sign-in cookie, `connectors_admin_<port>`,
   which every admin request must carry. HttpOnly, `SameSite=Lax` and a
   one-year `Max-Age`. Lax rather than Strict because the browser comes
   back from a service's sign-in page to `/oauth/callback`, a cross-site
   top-level navigation that must still carry it; cross-site POSTs don't
   get Lax cookies anyway. Cookies ignore ports, so another server on
   127.0.0.1 that the browser visits receives it; the name carries the
   port so two installs don't clash, and a server like that already runs
   as some user on this Mac (see the threat model).
3. Getting the cookie to the browser without putting a long-lived secret on
   a command line or in browser history: `connectors open [path]` puts a
   one-time code (24 random bytes, stored as SHA-256 in `login_codes`,
   two minutes) in the database and opens
   `/admin/login?code=<code>&next=<path>`. That route checks the host,
   takes the code (single use), sets the cookie, and redirects to `next`,
   which must be an `/admin` or `/approvals` path (anything else becomes
   `/admin`). It answers with `Referrer-Policy: no-referrer`. `--print`
   prints the URL instead of opening it, for an app that opens it itself
   (Threadbear's runner can run `connectors open --print /admin/connect/<id>`).
   A browser without the cookie gets a 401 page naming the exact
   `connectors open <path>` command for the page it asked for, so the links
   agents hand out still lead somewhere.

The `Tailscale-User-Login` header means nothing in local mode, and isn't
recorded in the call log. Considered and left out: a password (one more
secret to manage, and anything running as the owner can read it from
wherever it's kept), and a check of `Sec-Fetch-Site` on GETs (it adds
nothing the host check and the cookie don't, and some browsers leave it
out).

## Wiring the agents on the agents' Mac

`scripts/install-clients.sh` (idempotent):
- The gateway is on this Mac (`<data>/bin/connectors`), or on `--host`,
  `CONNECTORS_GATEWAY_HOST` or `gatewayHost` from this Mac's settings,
  reached as `ssh <host> '"$HOME/Library/Application Support/Connectors/bin/connectors" ...'`.
- The agents and their `client` entries come from `connectors agent list
  --json`, and the MCP URL from the gateway's `publicUrl`
  (`connectors settings --json`) plus `/mcp`, so this Mac needs no copy of
  the gateway's config.
- For each agent with a client that's installed here, get a token
  (`connectors agent add <id>`, or `rotate` if the gateway has one this Mac
  doesn't) and store it in the login Keychain: service `connectors`,
  account `<agentId>`. Never print it.
- Write `~/.config/connectors/headers.sh` (0700) that prints
  `{"Authorization":"Bearer <token>"}` for the agent named in `$1`, read
  from the Keychain.
- Claude: for the agent's `configDir` (or `~/.claude`, with
  `CLAUDE_CONFIG_DIR` unset), run
  `claude mcp add-json --scope user connectors '{"type":"http","url":"<publicUrl>/mcp","headersHelper":"$HOME/.config/connectors/headers.sh <agentId>"}'`
  (remove an existing `connectors` entry first).
- Codex: `[mcp_servers.connectors]` in `<configDir or CODEX_HOME>/config.toml`
  with `url`, `http_headers_helper = "<headers.sh> <agentId>"`,
  `tool_timeout_sec = 300`. Edit the TOML carefully (it can be large and
  full of other settings); back it up first.
- Grok: `[mcp_servers.connectors]` in its `config.toml` with
  `bearer_token_file` pointing at a 0600 `~/.config/connectors/<agentId>.token`.
- Muse: `settings.json` `mcpServers.connectors` with a literal `headers`
  value (Muse can't read env or helpers). File stays 0600.
- Do not remove existing claude.ai connectors or Codex apps; they stay as
  the fallback until each service works through the gateway.

## Install and deploy (added 29 Oct)

- `scripts/deploy.sh` builds on the agents' Mac and installs a release on
  the gateway machine (this Mac with `--local`, or an ssh host from
  `--host`, `CONNECTORS_DEPLOY_HOST` or `gatewayHost`). Nothing is built or
  fetched on the gateway machine. The remote half reads the gateway
  machine's settings through the new release's own CLI, so its port, label
  and mode are its own. The first deploy runs `connectors init` there with
  the `--mode`, `--admin-login`, `--public-url` and `--owner` flags; later
  ones don't change the config. `tailscale serve` only runs in tailscale
  mode. A release carries only the example config, so a deploy can never
  overwrite an install's own.
- `scripts/install.sh` is the one command for a new user: `npm ci`, then
  `deploy.sh --skip-checks`, a `~/.local/bin/connectors` shim (local
  installs), `install-clients.sh`, and `connectors open`. With `--host` it
  also writes `gatewayHost` into this Mac's `settings.json`, so later runs
  go to the same place.
- The plist template (`ops/launchd/connectors.plist`) has `{{HOME}}` and
  `{{LABEL}}` and nothing else install-specific; mode, URL and logins come
  from `settings.json`. Releases from before the template was generic named
  it after the label, and a rollback to one still works.

## Tests

- Unit: policy matching, tool naming/truncation/reverse map, token auth,
  approval state machine (approve, deny, expiry, wrong agent, run once),
  call-log redaction and pruning, SSRF guard.
- Integration: a fake upstream MCP server over stdio and over HTTP; a fake
  OAuth-protected upstream with a minimal authorization server (DCR + PKCE +
  refresh) to exercise Connect, callback, token refresh and "needs sign-in".
- Added 29 Oct: a fake Google (authorize, token, Gmail and Calendar APIs)
  for setup, the connect page, the shared sign-in, the tools, refresh,
  `invalid_grant`, unticked scopes and the shipped policy's rules
  (`test/google.test.ts`).
- Real clients (a local instance, temporary tokens, cheap models):
  Claude Code (`claude -p --mcp-config ... --strict-mcp-config`), Codex
  (`codex exec -c 'mcp_servers.connectors.url=...'` with a bearer env var),
  Grok and Muse if they can be driven headless. Each must list the tools and
  make one call to the fake upstream and one to DeepWiki. Record results in
  `docs/client-compat.md`.
- Added after review: a headless-Chromium test (`npm run test:browser`)
  drives Connect through the fake provider and Approve on the approval
  page, because fetch doesn't apply the pages' CSP and so missed a
  `form-action` that blocked every Connect.
- Added 29 Oct: settings (defaults, overrides, local mode refusing
  non-loopback addresses), config files (the install's own over the
  example, per file), the CLI's `init`, `settings` and `open`, and local
  mode's admin access (the cookie, one-time codes, the host check, other
  origins and ports, `next` redirects) in `test/local-admin.test.ts`. All
  tests use made-up names.
- `npm test` runs everything that doesn't need real CLIs or the network;
  `npm run test:clients` runs the real-client checks, and
  `npm run test:deploy` runs `deploy.sh` against a fake gateway machine
  (tailscale mode over a fake ssh, then local mode on "this Mac").
