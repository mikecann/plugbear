# Client compatibility

Which MCP clients work with the gateway, how each one was
configured, and what it actually sent. Checked on 2026-10-26 on an Apple silicon MacBook (macOS
26.6.2) against a local gateway on 127.0.0.1 with a temp data folder, the
fake stdio upstream (`test/fixtures/fakeStdioServer.ts`) and DeepWiki
(`https://mcp.deepwiki.com/mcp`, no auth). Each client got its own temporary
agent token. None of the clients' real configs changed: checksums of
`~/.codex/config.toml`, `~/.grok/config.toml`, `~/.grok/trusted_folders.toml`
and `~/.config/muse/settings.json` were the same before and after every run.

Rerun with:

```bash
npx -y -p node@26 npm run test:clients                  # list, fake__echo, DeepWiki
npx -y -p node@26 npm run test:clients -- --approvals   # plus one held call each
npx -y -p node@26 npm run test:clients -- --only grok
```

A client passes when the gateway logged its `tools/list` and one successful
call each to `fake__echo` (with the run's nonce) and a DeepWiki tool. Every
client listed 15 tools: the 2 built-ins, 10 fake tools and 3 DeepWiki tools.
(The first runs listed 12; the review added `send_report`, `stats` and `big`
to the fakes.)

## Results

| Client | Version | How it was configured | Protocol it used | Result |
| --- | --- | --- | --- | --- |
| Claude Code | 2.1.310 | `claude -p --strict-mcp-config --mcp-config` with a literal `Authorization` header | 2026-07-28, stateless | Pass, 8 s |
| Claude Code | 2.1.310 | same, with `headersHelper` (what install-clients.sh writes) | 2026-07-28, stateless | Pass, 7 s |
| Codex CLI | 0.164.0 | `codex exec -c mcp_servers.connectors.url=... -c ...bearer_token_env_var=...` | 2025-06-18, sessionless | Pass, 10 s |
| Codex CLI | 0.164.0 | same, with `http_headers_helper` (what install-clients.sh writes) | 2025-06-18, sessionless | Pass, 16 s |
| Grok CLI | 1.0.70 | project `.grok/config.toml` with `bearer_token_file`, `GROK_FOLDER_TRUST=0` | 2026-07-28, stateless | Pass, 13 s, with `toolSeparator: "_"` |
| Muse | 1.4.13 | project `.mcp.json` with a literal `headers` value, `--trust-workspace` | 2025-06-18, sessionless | Pass, 30 s |

Times are from the run after the review fixes (work folder
`connectors-clients-sbVrwg`); the first runs were within a few seconds of
these.

Models: Claude `claude-haiku-5-5` (account claude-3), Codex `gpt-6-luna` with
low reasoning, Grok `grok-4.7-build-fast`, Muse its default with low
reasoning.

### Held calls (`--approvals`)

Each client called `fake__send_report`, which the default policy holds for
approval and which declares an `outputSchema`, like DeepWiki's tools do. (The
first runs used `fake__send_message`, which has none; see "Held tools that
declare an outputSchema" below for why that mattered.) The test approved it
on the approval page 50 seconds after it was made, so the first call had
already answered "Waiting for <owner>" after the 45-second hold and the client
had to call `connectors__await_approval`.

| Client | Calls it made | Result |
| --- | --- | --- |
| Claude Code (header) | `fake__send_report`, then `connectors__await_approval` once | Ran once after approval, reply had the result, 56 s |
| Claude Code (headersHelper) | same | Same, 56 s |
| Codex (env var token) | same | Same, 57 s |
| Codex (headers helper) | same | Same, 58 s |
| Grok | `fake_send_report`, then `connectors_await_approval` once | Same, 59 s |
| Muse | `fake__send_report`, then `connectors__await_approval` once | Same, 77 s |

Every client treated "Waiting for <owner>..." as a normal result, called the
await tool with the id by itself, and got the real result back. The call log
shows exactly one `approved` run per client. Claude Code passes a result's
`structuredContent` to the model, so its reply was `{"sent":true,"to":"ana"}`
rather than the text. In one earlier run Codex (headers helper) got the
"Waiting" answer and then failed with OpenAI's "Selected model is at
capacity"; the approved call stayed unrun, and the rerun passed. Codex's default 60-second tool
timeout wasn't hit, because neither the hold nor the await waits more than
45 seconds.

## What each client sent

Taken from the gateway's `CONNECTORS_DEBUG_MCP=1` log, which records the
`MCP-Protocol-Version` header, whether there was a session id, the JSON-RPC
method names and the response type for every request (never params).

- Claude Code: `server/discover`, `tools/list`, `tools/call` with
  `MCP-Protocol-Version: 2026-07-28`, no session, plain JSON responses. It
  never sent `initialize`.
- Codex: `initialize` with no protocol header, then `notifications/initialized`,
  `tools/list` and `tools/call` with `2025-06-18`. No session id (the gateway
  doesn't issue one), SSE responses. It shows tools as
  `connectors/fake__echo`.
- Grok: `server/discover`, `tools/list`, `tools/call` with `2026-07-28`, no
  session, plain JSON responses.
- Muse: `initialize` already carrying `MCP-Protocol-Version: 2025-06-18`, then
  the same as Codex. The plan expected Muse to speak only 2024-11-05; this
  version negotiated 2025-06-18.
- None of them opened a GET event stream or sent DELETE.
- Since the review, the gateway advertises `tools.listChanged` to
  2026-07-28 clients. Claude Code then opens a `subscriptions/listen`
  stream in every session; Grok 1.0.70 doesn't.

## Findings

### Grok drops tool names with a second `__`

Grok names MCP tools `<server>__<tool>`, so `fake__echo` from the
`connectors` server becomes `connectors__fake__echo`, and Grok 1.0.70 drops
every tool whose full name has more than one `__`. It connected, listed 12
tools and registered none of them; the model then reported the tools as
missing. In one of three runs it retried 80 seconds later over 2025-03-26 and
the calls went through; in the others it gave up.

Fix: agents can set `"toolSeparator": "_"` in `config/agents.json` (set for
`grok`). That agent sees `fake_echo`, `deepwiki_read_wiki_structure`,
`connectors_await_approval` and `connectors_status`, with no `__` anywhere
(runs of underscores in upstream names are collapsed, and hashed long names
never end in `__`). Policy rules, the call log, approvals and pushes still use
`<prefix>__<tool>` with the upstream's own name, so `*__*send*` still holds
Grok's `fake_send_message`. With this, Grok passed on the stateless protocol
in 18 to 21 seconds.

### Grok only reads a project's MCP servers in a trusted folder

A project `.grok/config.toml` is ignored until the folder is trusted.
`--trust` would record the temp folder in `~/.grok/trusted_folders.toml`, so
the test sets `GROK_FOLDER_TRUST=0` for its one process instead. This doesn't
affect real use: install-clients.sh writes the user-level
`~/.grok/config.toml`, which needs no trust. That shape (`url`,
`bearer_token_file`, `tool_timeout_sec`) was also checked with
`GROK_HOME=<temp> grok mcp doctor`: Grok read it and tried the handshake.

### Codex and Claude read the config install-clients.sh writes

- `CODEX_HOME=<temp> codex mcp get connectors --json` on the exact table
  install-clients.sh writes shows `streamable_http`, the URL,
  `http_headers_helper` (redacted by Codex) and `tool_timeout_sec: 300`.
- `CLAUDE_CONFIG_DIR=<temp> claude mcp add-json --scope user connectors
  '{"type":"http","url":...,"headersHelper":"... claude-3"}'` is accepted.
- The real-client runs above used `headersHelper` and `http_headers_helper`
  pointing at a stand-in for `headers.sh`, so the helper path is covered end
  to end.

### Muse

`muse exec --trust-workspace` trusts the workspace for that run only
(`workspace trust: trusted source=run-flag`) and `~/.config/muse` didn't
change. The user-level `~/.config/muse/settings.json` entry that
install-clients.sh writes has the same `mcpServers.connectors` shape as the
project `.mcp.json` that passed; Muse's own messages describe "a
streamable-HTTP entry under mcpServers in settings.json". That file wasn't
exercised by a real Muse run, because doing so means writing the real user settings.
`muse exec -c mcpServers.connectors=...` can't add a new server ("unknown
key"), so it can't be used to test it either.

### Held tools that declare an outputSchema (found in review)

Claude Code 2.1.310 and both MCP SDK clients check a tool's result against
the `outputSchema` it declared in `tools/list`, and reject a result without
`structuredContent`: "Tool X has an output schema but did not return
structured content". The "Waiting for <owner>" answer is plain text, so for a
held tool with an `outputSchema` Claude never saw the approval id, never
called `connectors__await_approval`, and an approval given later never
ran. Codex, Grok and Muse didn't check. DeepWiki declares an `outputSchema`
on all three of its tools, so real upstreams do this.

Fix: `tools/list` drops `outputSchema` from any tool the policy could hold
for that agent (an `ask` rule with `ifArgs` counts). Allowed tools keep
theirs, and every result still carries `structuredContent`. The held-call
runs above now use `fake__send_report`, which has an `outputSchema`, and
`test/limits.test.ts` checks it with both SDK clients.

### Tool changes reach Claude Code only, in an open session

When an upstream adds a tool, or the owner connects a service, the gateway
refreshes its cache within about a second and sends
`notifications/tools/list_changed` on every open `subscriptions/listen`
stream. A real Claude Code session (stream-json, `claude-haiku-5-5`) called
a tool added upstream between two turns; before the fix it answered "NOT
FOUND". Grok 1.0.70 doesn't open a listen stream, and Codex and Muse use the
2025-era protocol, which the gateway serves without sessions, so there is no
stream to send the notification on. Those three see new tools in their next
session.

### Codex and a slow `tools/list`

Codex 0.164.0 (`codex exec`) starts its turn without a server's tools when
that server's `tools/list` is slow, and then has none of them for the whole
session. The gateway used to hold the first `tools/list` for up to 8 s while
upstreams connected after a start. Now it waits at most 1 s from the start
of the process. With a hanging upstream and Codex started 0.5 s after the
gateway: a 2.5 s wait lost the tools in one of two runs, a 1 s wait kept
them in three of three. With every upstream ready, Codex coped with a 2 s
`tools/list`, so the limit isn't fixed; it depends on how fast Codex itself
starts the turn.

### A restart during a held call

Every deploy restarts the gateway. A held call used to get its connection
reset, so the agent never saw the approval id. Now the gateway answers held
calls at once with the usual "Waiting for <owner> ... id" before it stops, and
gives other running calls 3 seconds. In a real Claude Code session the
gateway restarted 12 s into a hold: Claude got the id, and after the restart
`connectors__await_approval` ran the call once.

### Muse renames tool names over 48 characters

Muse names MCP tools `mcp__connectors.<name>` and caps the whole name at 64
characters with its own hash, so a gateway name over 48 characters gets a
different name in Muse (for example
`mcp__connectors.fake__list_every_single_thing_in_t__07eed1415eac`). Calls
still work, but a prompt that names the gateway's exact tool won't match.
Left as it is for now: few tool names are that long, and avoiding it would
mean a per-agent name length limit in the gateway's naming.

### Sign-in stubs (added 29 Oct, not rerun against the real CLIs)

A signed-out service lists `<prefix>__sign_in` with an empty-object input
schema and no `outputSchema`, and answers with plain text that isn't an
error. Checked against what each client is known to do above: the names are
well under Muse's 48-character limit and Codex's 64, Grok gets
`<prefix>_sign_in` with no `__`, and no client has a schema to check the
text against. The stub coming and going changes the tool list, so Claude
Code hears about it as `list_changed`; the others see it next session, like
any tool change. `test/google.test.ts` covers both the 2025-era and the
2026-07-28 SDK clients.

## SDK choice

- Server side: `@modelcontextprotocol/server` 2.4.0, `createMcpHandler`. One
  handler answers the stateless 2026-07-28 form (`server/discover`, plain
  JSON) that Claude Code and Grok use and the 2025-era `initialize` handshake
  that Codex and Muse use, building a fresh low-level `Server` per request
  from the gateway's cached tool lists. No sessions to keep, which suits a
  small process.
- Upstream side: `@modelcontextprotocol/client` 2.4.0 with
  `StreamableHTTPClientTransport` and `StdioClientTransport`, the guarded
  fetch and the gateway's `OAuthClientProvider`. DeepWiki and the fakes are
  2025-era servers and it connects to them fine.
- `@modelcontextprotocol/sdk` 1.32.2 is only a dev dependency: the fake
  upstreams and the 2025-era test client are built on it, because the real
  upstreams are 2025-era servers. Its newest protocol is 2025-11-25 and it
  has no `server/discover`, so it can't serve the 2026-07-28 clients.
