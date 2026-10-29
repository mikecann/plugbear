# Agent guidance for connectors

Connectors is an MCP gateway: it signs in to each service once and gives
every agent (Claude Code logins, Codex, Grok, Muse, any MCP client) one MCP
URL, with "ask first" approval rules and a call log. Read `docs/plan.md`
before changing anything; it's the spec. The README is the user guide.

## Rules

- Test first for anything non-trivial. `npm test` must pass before a commit;
  `npm run test:deploy` checks the deploy script and `npm run test:clients`
  the real CLIs.
- Never print, log or commit a secret (agent tokens, OAuth tokens, client
  secrets, the admin key, the ntfy topic). Show names and paths only.
  Secrets live in `<data folder>/secrets/` (default
  `~/Library/Application Support/Connectors/secrets/`), mode 0600/0700.
- Nothing personal in the repo: an install's own settings, agents,
  upstreams and policy live in `<data folder>/config/`, never in `config/`
  (which only has the `*.example.json` files). Tests, docs and examples use
  made-up names (Sam, Ana, studio, example.com).
- Never pass an inbound token upstream, never act as an OAuth server, and only
  call configured upstream URLs.
- Run on Node 26 (`node:sqlite` truncates text at NUL on older versions).
- Admin and approval pages: plain copy, no eyebrow or kicker labels, no em
  dashes.
- Keep the process small (the heap is capped at 384 MB): gateway machines
  are often shared with other services.
