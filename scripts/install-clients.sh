#!/usr/bin/env bash
# Wires the agents on this Mac to a Connectors gateway, on this Mac or on
# another machine over ssh. Running it again is safe.
#
#   scripts/install-clients.sh             wire everything that's installed
#   scripts/install-clients.sh --host studio   the gateway runs on ssh host "studio"
#   scripts/install-clients.sh --dry-run   say what would change, change nothing
#   scripts/install-clients.sh --rotate    make new tokens for every agent first
#   scripts/install-clients.sh --only codex,grok
#   scripts/install-clients.sh --remove    take the connectors entries out again
#
# The agents come from the gateway's agents.json (`connectors agent list`),
# and each one's "client" says what to wire: {"type": "claude"} for
# ~/.claude, or {"type": "claude", "configDir": "~/some/folder"} for
# another Claude config folder; likewise codex (CODEX_HOME), grok
# (GROK_HOME) and muse (its settings folder). Agents without a client are
# skipped. The MCP URL is the gateway's publicUrl plus /mcp.
#
# For each agent it gets a token from the gateway (`connectors agent add`,
# or `rotate` if the gateway already has one this Mac doesn't), keeps it in
# the login Keychain (service "connectors", account <agent id>) and never
# prints it. Then:
#   Claude: `claude mcp add-json --scope user connectors` with a
#     headersHelper that reads the Keychain.
#   Codex: [mcp_servers.connectors] in config.toml with
#     http_headers_helper. The file is backed up first.
#   Grok: [mcp_servers.connectors] in config.toml with bearer_token_file
#     pointing at a 0600 file. Backed up first.
#   Muse: mcpServers.connectors in settings.json with a literal
#     Authorization header (Muse can't run helpers). Backed up, 0600.
# Existing claude.ai connectors and Codex apps are left alone. Codex's and
# Grok's configs are checked with their own CLIs afterwards and put back if
# they don't read. A client that fails doesn't stop the others; the script
# lists what was wired, skipped and failed, and exits 1 if anything failed.
#
# Which gateway: --host, else CONNECTORS_GATEWAY_HOST, else gatewayHost in
# this Mac's settings.json (<data folder>/config/settings.json), else the
# gateway installed on this Mac.
#
# Environment, mostly for testing this script:
#   CONNECTORS_HOME           this Mac's data folder (default ~/Library/Application Support/Connectors)
#   CONNECTORS_URL            gateway MCP URL (default: the gateway's publicUrl + /mcp)
#   CONNECTORS_CLI            run this local command instead of the gateway's CLI
#   CONNECTORS_KEYCHAIN_SERVICE  Keychain service name (default connectors)
#   CONNECTORS_SECURITY_BIN   the security command (default /usr/bin/security)
#   CODEX_HOME, GROK_HOME     defaults for agents whose client has no configDir

set -euo pipefail

SERVICE="${CONNECTORS_KEYCHAIN_SERVICE:-connectors}"
SECURITY="${CONNECTORS_SECURITY_BIN:-/usr/bin/security}"
DATA="${CONNECTORS_HOME:-$HOME/Library/Application Support/Connectors}"
# Where the gateway keeps its data on another machine. $HOME is expanded
# there, not here.
# shellcheck disable=SC2016
REMOTE_DATA='$HOME/Library/Application Support/Connectors'
CONFIG_DIR="$HOME/.config/connectors"
HEADERS="$CONFIG_DIR/headers.sh"
STAMP="$(date +%Y%m%d-%H%M%S)"

dry_run=0
rotate=0
remove=0
only=""
host="${CONNECTORS_GATEWAY_HOST:-}"

usage() {
  sed -n '2,46p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) dry_run=1 ;;
    --rotate) rotate=1 ;;
    --remove) remove=1 ;;
    --only)
      only="${2:?--only needs a comma-separated list of agent ids}"
      shift
      ;;
    --only=*) only="${1#--only=}" ;;
    --host)
      host="${2:?--host needs an ssh host}"
      shift
      ;;
    --host=*) host="${1#--host=}" ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
  shift
done

say() { printf '%s\n' "$*"; }
die() {
  printf 'install-clients: %s\n' "$*" >&2
  exit 1
}

# Commands that change something go through here, so --dry-run is honest.
act() {
  if [ "$dry_run" = 1 ]; then
    printf '  would run: %s\n' "$*"
  else
    "$@"
  fi
}

wanted() {
  [ -z "$only" ] && return 0
  case ",$only," in *",$1,"*) return 0 ;; esac
  return 1
}

case "$HEADERS" in
  *" "*) die "$HEADERS has a space in it, which the clients' helper commands can't take." ;;
esac

# --- Tokens -----------------------------------------------------------------

# The gateway's connectors CLI, by full path (ssh doesn't load a login PATH).
connectors_cli() {
  if [ -n "${CONNECTORS_CLI:-}" ]; then
    # shellcheck disable=SC2086 # CONNECTORS_CLI is a command line on purpose.
    $CONNECTORS_CLI "$@"
  elif [ -n "$host" ]; then
    # Arguments are agent ids ([a-z0-9-]) and fixed words, so they're safe
    # in the remote command.
    # shellcheck disable=SC2029
    ssh "$host" "\"$REMOTE_DATA/bin/connectors\" $*"
  else
    "$DATA/bin/connectors" "$@"
  fi
}

keychain_has() {
  "$SECURITY" find-generic-password -s "$SERVICE" -a "$1" >/dev/null 2>&1
}

keychain_token() {
  "$SECURITY" find-generic-password -s "$SERVICE" -a "$1" -w
}

# `security -i` reads the command from stdin, so the token never shows up
# in a process list.
keychain_store() {
  printf 'add-generic-password -U -s %s -a %s -w %s\n' "$SERVICE" "$1" "$2" | "$SECURITY" -i >/dev/null
  keychain_has "$1" || die "Couldn't save the token for $1 in the Keychain."
}

ensure_token() {
  local agent="$1" token status
  if [ "$rotate" = 0 ] && keychain_has "$agent"; then
    say "  token: already in the Keychain"
    return 0
  fi
  if [ "$dry_run" = 1 ]; then
    say "  would get a token from $GATEWAY and keep it in the Keychain ($SERVICE/$agent)"
    return 0
  fi
  if [ "$rotate" = 1 ]; then
    set +e
    token="$(connectors_cli agent rotate "$agent")"
    status=$?
    set -e
    if [ "$status" != 0 ]; then token="$(connectors_cli agent add "$agent")"; fi
  else
    set +e
    token="$(connectors_cli agent add "$agent")"
    status=$?
    set -e
    if [ "$status" = 3 ]; then
      say "  The gateway already has a token for $agent that this Mac doesn't; replacing it"
      token="$(connectors_cli agent rotate "$agent")"
    elif [ "$status" != 0 ]; then
      die "Couldn't get a token for $agent from $GATEWAY (exit $status)."
    fi
  fi
  [[ "$token" =~ ^cn_${agent}_[0-9a-f]{64}$ ]] || die "$GATEWAY didn't send back a token for $agent."
  keychain_store "$agent" "$token"
  say "  token: saved in the Keychain"
}

write_headers_helper() {
  act mkdir -p "$CONFIG_DIR"
  act chmod 700 "$CONFIG_DIR"
  if [ "$dry_run" = 1 ]; then
    say "  would write $HEADERS"
    return 0
  fi
  cat >"$HEADERS.tmp" <<EOF
#!/bin/sh
# Written by connectors/scripts/install-clients.sh. Prints the Authorization
# header for one Connectors agent, read from the login Keychain.
set -eu
agent="\${1:?usage: headers.sh <agent id>}"
token="\$('$SECURITY' find-generic-password -s '$SERVICE' -a "\$agent" -w)"
printf '{"Authorization":"Bearer %s"}\n' "\$token"
EOF
  chmod 700 "$HEADERS.tmp"
  mv -f "$HEADERS.tmp" "$HEADERS"
}

backup() {
  local file="$1"
  [ -f "$file" ] || return 0
  act cp -p "$file" "$file.bak-connectors-$STAMP"
  say "  backup: $file.bak-connectors-$STAMP"
}

# --- Config files -------------------------------------------------------------

# Replaces (mode set, with the new table as $3) or removes (mode remove) the
# [mcp_servers.connectors] table in a TOML file, keeping every other line as
# it is. Mode check only looks. Refuses forms it can't edit safely, such as
# an inline table or dotted keys.
toml_table() {
  local file="$1" mode="$2" body="${3:-}"
  /usr/bin/python3 - "$file" "$mode" "$body" <<'PY'
import os, re, sys
path, mode, body = sys.argv[1], sys.argv[2], sys.argv[3]
if mode != "set":
    body = ""
text = open(path, encoding="utf-8").read() if os.path.exists(path) else ""
lines = text.splitlines(keepends=True)
header = re.compile(r'^\s*\[\s*mcp_servers\s*\.\s*(?:connectors|"connectors")\s*(?:\.[^\]]*)?\]\s*(?:#.*)?$')
any_header = re.compile(r'^\s*\[')
other_forms = re.compile(r'^\s*(?:mcp_servers\s*\.\s*)?"?connectors"?\s*(?:\.|=)')
out, skipping, in_mcp, at_root = [], False, False, True
for line in lines:
    if any_header.match(line):
        at_root = False
        skipping = bool(header.match(line))
        in_mcp = re.match(r'^\s*\[\s*mcp_servers\s*\]', line) is not None
        if skipping:
            continue
    elif not skipping and (in_mcp or at_root) and other_forms.match(line):
        sys.exit(f"{path} sets connectors in a form this script doesn't edit; change it by hand.")
    if not skipping:
        out.append(line)
result = "".join(out).rstrip("\n")
if body:
    result = (result + "\n\n" if result else "") + body.rstrip("\n")
result += "\n"
if mode == "check":
    sys.exit(0)
tmp = f"{path}.tmp-connectors"
with open(tmp, "w", encoding="utf-8") as handle:
    handle.write(result)
os.chmod(tmp, os.stat(path).st_mode & 0o777 if os.path.exists(path) else 0o600)
os.replace(tmp, path)
PY
}

# Sets (or removes) mcpServers.connectors in Muse's settings.json. Mode
# check only looks. The token comes in through the environment, not the
# command line.
muse_settings() {
  local file="$1" mode="$2"
  CONNECTORS_URL_VALUE="$URL" /usr/bin/python3 - "$file" "$mode" <<'PY'
import json, os, sys
path, mode = sys.argv[1], sys.argv[2]
data = {}
if os.path.exists(path):
    with open(path, encoding="utf-8") as handle:
        try:
            data = json.load(handle)
        except json.JSONDecodeError as error:
            sys.exit(f"{path} isn't plain JSON ({error.msg} on line {error.lineno}); change it by hand.")
if not isinstance(data, dict):
    sys.exit(f"{path} isn't a JSON object; change it by hand.")
servers = data.get("mcpServers")
if servers is None:
    servers = {}
if not isinstance(servers, dict):
    sys.exit(f"{path} has an mcpServers that isn't an object; change it by hand.")
if mode == "check":
    sys.exit(0)
if mode == "set":
    servers["connectors"] = {
        "type": "http",
        "url": os.environ["CONNECTORS_URL_VALUE"],
        "headers": {"Authorization": "Bearer " + os.environ["CONNECTORS_TOKEN_VALUE"]},
    }
    data["mcpServers"] = servers
else:
    servers.pop("connectors", None)
    if servers:
        data["mcpServers"] = servers
    else:
        data.pop("mcpServers", None)
os.makedirs(os.path.dirname(path), exist_ok=True)
tmp = f"{path}.tmp-connectors"
fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
with os.fdopen(fd, "w", encoding="utf-8") as handle:
    json.dump(data, handle, indent=2)
    handle.write("\n")
os.chmod(tmp, 0o600)
os.replace(tmp, path)
PY
}

# --- Clients ------------------------------------------------------------------

# Sets the paths for one agent's client from its type and configDir:
# CLAUDE_DIR (empty for ~/.claude), CODEX_CONFIG, GROK_CONFIG,
# GROK_TOKEN_FILE and MUSE_SETTINGS.
set_paths() {
  local agent="$1" type="$2" dir="$3"
  # "~/" in agents.json is this Mac's home folder. The tildes are matched
  # literally on purpose (SC2088).
  # shellcheck disable=SC2088
  case "$dir" in "~/"*) dir="$HOME/${dir#\~/}" ;; "~") dir="$HOME" ;; esac
  CLAUDE_DIR=""
  case "$type" in
    claude) CLAUDE_DIR="$dir" ;;
    codex) CODEX_CONFIG="${dir:-${CODEX_HOME:-$HOME/.codex}}/config.toml" ;;
    grok)
      GROK_CONFIG="${dir:-${GROK_HOME:-$HOME/.grok}}/config.toml"
      GROK_TOKEN_FILE="$CONFIG_DIR/$agent.token"
      ;;
    muse) MUSE_SETTINGS="${dir:-$HOME/.config/muse}/settings.json" ;;
  esac
}

# Prints why an agent's client isn't on this Mac and succeeds, or fails if
# it's there. Checked before a token is minted, so absent clients get none.
missing_client() {
  local agent="$1" type="$2"
  case "$type" in
    claude)
      if ! command -v claude >/dev/null 2>&1; then
        echo "claude isn't installed"
      elif [ -n "$CLAUDE_DIR" ] && [ ! -d "$CLAUDE_DIR" ]; then
        echo "$CLAUDE_DIR doesn't exist"
      else
        return 1
      fi
      ;;
    codex)
      if [ -f "$CODEX_CONFIG" ]; then return 1; fi
      echo "$CODEX_CONFIG doesn't exist"
      ;;
    grok)
      if command -v grok >/dev/null 2>&1 || [ -f "$GROK_CONFIG" ]; then return 1; fi
      echo "grok isn't installed"
      ;;
    muse)
      if [ -d "$(dirname "$MUSE_SETTINGS")" ] || command -v muse >/dev/null 2>&1; then return 1; fi
      echo "muse isn't installed"
      ;;
    "")
      echo "agents.json gives $agent no client"
      ;;
    *)
      echo "this script doesn't know how to wire a $type client"
      ;;
  esac
}

# The wire_* functions run in a subshell with set -e (see the main loop),
# so any failing command stops that client, and only that client.

wire_claude() {
  local agent="$1" dir="$CLAUDE_DIR"
  local where="${dir:-~/.claude}"
  # No configDir means ~/.claude, so CLAUDE_CONFIG_DIR must be unset even
  # if this script runs inside a Claude session that set it.
  local -a run_claude
  if [ -n "$dir" ]; then
    run_claude=(env "CLAUDE_CONFIG_DIR=$dir" claude)
  else
    run_claude=(env -u CLAUDE_CONFIG_DIR claude)
  fi
  if [ "$remove" = 1 ]; then
    act "${run_claude[@]}" mcp remove --scope user connectors || true
    say "  removed connectors from Claude in $where"
    return 0
  fi
  local json
  json="$(printf '{"type":"http","url":"%s","headersHelper":"%s %s"}' "$URL" "$HEADERS" "$agent")"
  if [ "$dry_run" = 1 ]; then
    say "  would set connectors in Claude ($where): $json"
    return 0
  fi
  "${run_claude[@]}" mcp remove --scope user connectors >/dev/null 2>&1 || true
  "${run_claude[@]}" mcp add-json --scope user connectors "$json" >/dev/null
  say "  Claude ($where): connectors added with headersHelper"
}

wire_codex() {
  toml_table "$CODEX_CONFIG" check
  local body
  body="$(printf '[mcp_servers.connectors]\nurl = "%s"\nhttp_headers_helper = "%s %s"\n# Calls that wait for approval hold for up to 45 seconds.\ntool_timeout_sec = 300\n' "$URL" "$HEADERS" "$agent")"
  if [ "$dry_run" = 1 ]; then
    if [ "$remove" = 1 ]; then say "  would remove [mcp_servers.connectors] from $CODEX_CONFIG"; else
      say "  would set in $CODEX_CONFIG:"
      printf '%s\n' "$body" | sed 's/^/    /'
    fi
    return 0
  fi
  backup "$CODEX_CONFIG"
  if [ "$remove" = 1 ]; then
    toml_table "$CODEX_CONFIG" remove
    say "  Codex: removed [mcp_servers.connectors]"
    return 0
  fi
  toml_table "$CODEX_CONFIG" set "$body"
  # Codex must still read its config, and see the server; if not, undo.
  if command -v codex >/dev/null 2>&1; then
    local seen
    seen="$(CODEX_HOME="$(dirname "$CODEX_CONFIG")" codex mcp get connectors --json 2>/dev/null || true)"
    if [[ "$seen" != *"$URL"* ]]; then
      cp -p "$CODEX_CONFIG.bak-connectors-$STAMP" "$CODEX_CONFIG"
      die "Codex didn't accept the new config, so $CODEX_CONFIG is back as it was."
    fi
  else
    say "  note: codex isn't on PATH, so the new config wasn't checked with 'codex mcp get'"
  fi
  say "  Codex: [mcp_servers.connectors] set with http_headers_helper"
}

wire_grok() {
  if [ -f "$GROK_CONFIG" ]; then toml_table "$GROK_CONFIG" check; fi
  local body
  body="$(printf '[mcp_servers.connectors]\nurl = "%s"\nbearer_token_file = "%s"\ntool_timeout_sec = 300\n' "$URL" "$GROK_TOKEN_FILE")"
  if [ "$dry_run" = 1 ]; then
    if [ "$remove" = 1 ]; then say "  would remove [mcp_servers.connectors] from $GROK_CONFIG and delete $GROK_TOKEN_FILE"; else
      say "  would write $GROK_TOKEN_FILE (0600) and set in $GROK_CONFIG:"
      printf '%s\n' "$body" | sed 's/^/    /'
    fi
    return 0
  fi
  backup "$GROK_CONFIG"
  if [ "$remove" = 1 ]; then
    if [ -f "$GROK_CONFIG" ]; then toml_table "$GROK_CONFIG" remove; fi
    rm -f "$GROK_TOKEN_FILE"
    say "  Grok: removed [mcp_servers.connectors] and its token file"
    return 0
  fi
  mkdir -p "$(dirname "$GROK_CONFIG")"
  # Grok reads the file on every request; replace it in one rename.
  (
    umask 077
    keychain_token "$agent" >"$GROK_TOKEN_FILE.tmp"
  )
  chmod 600 "$GROK_TOKEN_FILE.tmp"
  mv -f "$GROK_TOKEN_FILE.tmp" "$GROK_TOKEN_FILE"
  toml_table "$GROK_CONFIG" set "$body"
  # Grok must still read its config, and see the server; if not, undo.
  if command -v grok >/dev/null 2>&1; then
    local seen
    seen="$(GROK_HOME="$(dirname "$GROK_CONFIG")" grok mcp list --json 2>/dev/null || true)"
    if [[ "$seen" != *"$URL"* ]]; then
      if [ -f "$GROK_CONFIG.bak-connectors-$STAMP" ]; then
        cp -p "$GROK_CONFIG.bak-connectors-$STAMP" "$GROK_CONFIG"
      else
        toml_table "$GROK_CONFIG" remove
      fi
      die "Grok didn't accept the new config, so $GROK_CONFIG is back as it was."
    fi
  else
    say "  note: grok isn't on PATH, so the new config wasn't checked with 'grok mcp list'"
  fi
  say "  Grok: [mcp_servers.connectors] set with bearer_token_file"
}

wire_muse() {
  if [ "$dry_run" = 1 ]; then
    if [ "$remove" = 1 ]; then say "  would remove mcpServers.connectors from $MUSE_SETTINGS"; else
      say "  would set mcpServers.connectors in $MUSE_SETTINGS (literal header) and make it 0600"
    fi
    return 0
  fi
  backup "$MUSE_SETTINGS"
  if [ -f "$MUSE_SETTINGS.bak-connectors-$STAMP" ]; then chmod 600 "$MUSE_SETTINGS.bak-connectors-$STAMP"; fi
  if [ "$remove" = 1 ]; then
    if [ -f "$MUSE_SETTINGS" ]; then muse_settings "$MUSE_SETTINGS" remove; fi
    say "  Muse: removed mcpServers.connectors"
    return 0
  fi
  local token
  token="$(keychain_token "$agent")"
  CONNECTORS_TOKEN_VALUE="$token" muse_settings "$MUSE_SETTINGS" set
  say "  Muse: mcpServers.connectors set; $MUSE_SETTINGS is 0600"
}

# Refuses a config file the script can't edit before a token is minted for it.
check_config() {
  case "$1" in
    codex) toml_table "$CODEX_CONFIG" check ;;
    grok) if [ -f "$GROK_CONFIG" ]; then toml_table "$GROK_CONFIG" check; fi ;;
    muse) if [ -f "$MUSE_SETTINGS" ]; then muse_settings "$MUSE_SETTINGS" check; fi ;;
  esac
}

remove_token() {
  local agent="$1"
  if keychain_has "$agent"; then
    act "$SECURITY" delete-generic-password -s "$SERVICE" -a "$agent" >/dev/null
    say "  token: removed from the Keychain (the gateway still has its hash; run 'connectors agent remove $agent' there)"
  fi
}

# --- Main ---------------------------------------------------------------------

# Which gateway, for messages and for connectors_cli.
if [ -z "$host" ] && [ -z "${CONNECTORS_CLI:-}" ] && [ -f "$DATA/config/settings.json" ]; then
  host="$(/usr/bin/python3 -c 'import json, sys; print(json.load(open(sys.argv[1])).get("gatewayHost") or "")' "$DATA/config/settings.json")"
fi
case "$host" in
  *[!A-Za-z0-9._@-]*) die "$host isn't an ssh host name." ;;
esac
if [ -n "${CONNECTORS_CLI:-}" ]; then GATEWAY="the gateway"; elif [ -n "$host" ]; then GATEWAY="$host"; else GATEWAY="this Mac's gateway"; fi
if [ -z "$host" ] && [ -z "${CONNECTORS_CLI:-}" ] && [ ! -x "$DATA/bin/connectors" ]; then
  die "There's no gateway installed on this Mac ($DATA/bin/connectors). Install it with scripts/install.sh, or pass --host for one on another machine."
fi

# The agents and the URL come from the gateway, so this Mac needs no copy
# of its config. One line per agent: id, client type, client configDir.
agents_json="$(connectors_cli agent list --json)" || die "Couldn't list the agents on $GATEWAY."
AGENTS="$(printf '%s' "$agents_json" | /usr/bin/python3 -c '
import json, sys
for agent in json.load(sys.stdin)["agents"]:
    client = agent.get("client") or {}
    print("\t".join([agent["id"], client.get("type", ""), client.get("configDir", "")]))
')"
if [ -n "${CONNECTORS_URL:-}" ]; then
  URL="$CONNECTORS_URL"
else
  settings_json="$(connectors_cli settings --json)" || die "Couldn't read the settings on $GATEWAY."
  URL="$(printf '%s' "$settings_json" | /usr/bin/python3 -c 'import json, sys; print(json.load(sys.stdin)["settings"]["publicUrl"] + "/mcp")')"
fi

if [ "$remove" = 0 ]; then write_headers_helper; fi

wired=()
skipped=()
failed=()
while IFS=$'\t' read -r agent type dir; do
  [ -n "$agent" ] || continue
  wanted "$agent" || continue
  say "$agent"
  set_paths "$agent" "$type" "$dir"
  case "$type" in
    claude) client=wire_claude ;;
    codex) client=wire_codex ;;
    grok) client=wire_grok ;;
    muse) client=wire_muse ;;
    *) client=none ;;
  esac
  if reason="$(missing_client "$agent" "$type")"; then
    say "  skipped: $reason"
    skipped+=("$agent")
    # A token for a client that's gone still comes out of the Keychain.
    if [ "$remove" = 1 ]; then remove_token "$agent"; fi
    continue
  fi
  # A subshell with set -e of its own: in an `if` or after `||`, bash
  # ignores set -e inside functions, which once let a refused edit carry on
  # and report success. Here any failing command stops this client, the
  # status is kept, and the other clients still get their turn. Its stdin
  # is closed so nothing in it eats the agent list.
  set +e
  (
    set -e
    check_config "$type"
    if [ "$remove" = 0 ]; then ensure_token "$agent"; fi
    "$client" "$agent"
    if [ "$remove" = 1 ]; then remove_token "$agent"; fi
  ) </dev/null
  status=$?
  set -e
  if [ "$status" = 0 ]; then
    wired+=("$agent")
  else
    say "  FAILED: $agent wasn't $([ "$remove" = 1 ] && echo "unwired" || echo "wired") (see above)"
    failed+=("$agent")
  fi
done <<<"$AGENTS"

say ""
say "Done: ${wired[*]:-none}. Skipped: ${skipped[*]:-none}. Failed: ${failed[*]:-none}."
if [ "$dry_run" = 1 ]; then say "Dry run: nothing changed."; fi
if [ "${#failed[@]}" -gt 0 ]; then exit 1; fi
