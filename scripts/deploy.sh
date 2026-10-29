#!/usr/bin/env bash
# Installs or updates the Connectors gateway, on this Mac or on another Mac
# over ssh: builds here, copies the release over, points `app` at it,
# restarts the LaunchAgent and waits for /health. If the new release
# doesn't come up, `app` goes back to the previous one. Nothing is built or
# fetched on the other machine.
#
#   scripts/deploy.sh               check, build and deploy
#   scripts/deploy.sh --host studio deploy to ssh host "studio"
#   scripts/deploy.sh --local       deploy to this Mac, whatever settings say
#   scripts/deploy.sh --skip-checks build and deploy without typecheck/tests
#   scripts/deploy.sh --rollback    go back to the previous release
#   scripts/deploy.sh --no-publish  leave `tailscale serve` alone
#   scripts/deploy.sh --dry-run     build and stage, then stop before the target
#
# The first deploy to a machine also writes its settings.json (connectors
# init), from these options; later deploys leave it alone:
#   --mode local|tailscale  --admin-login LOGIN  --public-url URL  --owner NAME
#
# Which machine: --host or --local, else CONNECTORS_DEPLOY_HOST, else
# gatewayHost in this Mac's settings.json, else this Mac. The target's own
# settings.json decides its port, mode, LaunchAgent label and whether to
# run `tailscale serve`.
#
# On the target, under ~/Library/Application Support/Connectors/:
#   releases/<id>/  dist/connectors.mjs and google-mcp.mjs, config/ (the examples), ops/,
#                   release.json, bin/node, and .went-live once it has served /health
#                   (only those are rollback targets; a release that never
#                   came up is deleted)
#   app             symlink to the live release
#   node/<version>/ the pinned official Node (ops/node.json), bin/node only
#   bin/connectors  wrapper so ssh can run the CLI by full path
#   config/, secrets/, state/ are never touched by a deploy (apart from
#   the first deploy's settings.json and agents.json).
# Logs go to ~/Library/Logs/connectors.log.
#
# Environment, mostly for testing this script:
#   CONNECTORS_DEPLOY_HOST  ssh host
#   CONNECTORS_DEPLOY_SSH   ssh command (default ssh)
#   CONNECTORS_HOME         this Mac's data folder, for its settings.json
#   CONNECTORS_NODE_CACHE   where the Node download is cached on this Mac

set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
SSH="${CONNECTORS_DEPLOY_SSH:-ssh}"
DATA="${CONNECTORS_HOME:-$HOME/Library/Application Support/Connectors}"
NODE_CACHE="${CONNECTORS_NODE_CACHE:-$HOME/Library/Caches/connectors/node}"
# rsync paths are relative to the remote home and go through the remote
# shell, hence the escaped space.
REMOTE_ROOT_RSYNC='Library/Application\ Support/Connectors'
LOCAL_ROOT="$HOME/Library/Application Support/Connectors"

skip_checks=0
rollback=0
publish=1
dry_run=0
allow_dirty=0
host="${CONNECTORS_DEPLOY_HOST:-}"
host_given=0
[ -n "$host" ] && host_given=1
init_args=()

usage() {
  sed -n '2,41p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

while [ $# -gt 0 ]; do
  case "$1" in
    --skip-checks) skip_checks=1 ;;
    --rollback) rollback=1 ;;
    --no-publish) publish=0 ;;
    --dry-run) dry_run=1 ;;
    --allow-dirty) allow_dirty=1 ;;
    --host)
      host="${2:?--host needs an ssh host}"
      host_given=1
      shift
      ;;
    --local)
      host=""
      host_given=1
      ;;
    --mode | --admin-login | --public-url | --owner)
      init_args+=("$1" "${2:?$1 needs a value}")
      shift
      ;;
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

say() { printf '==> %s\n' "$*"; }
die() {
  printf 'deploy: %s\n' "$*" >&2
  exit 1
}

# The target from settings, if no flag or variable chose one.
if [ "$host_given" = 0 ] && [ -f "$DATA/config/settings.json" ]; then
  host="$(/usr/bin/python3 -c 'import json, sys; print(json.load(open(sys.argv[1])).get("gatewayHost") or "")' "$DATA/config/settings.json")"
fi
case "$host" in
  *[!A-Za-z0-9._@-]*) die "$host isn't an ssh host name." ;;
esac
TARGET="${host:-this Mac}"

# shellcheck disable=SC2029 # The remote command is built here on purpose.
remote() {
  if [ -n "$host" ]; then
    $SSH "$host" "$@"
  else
    /bin/sh -c "$*"
  fi
}

# Copies a folder to <data folder>/<relative path> on the target.
copy_dir() {
  local from="$1" to="$2"
  if [ -n "$host" ]; then
    rsync -a --delete -e "$SSH" "$from" "$host:$REMOTE_ROOT_RSYNC/$to"
  else
    mkdir -p "$LOCAL_ROOT/$to"
    rsync -a --delete "$from" "$LOCAL_ROOT/$to"
  fi
}

# Runs the remote half of this script (below) on the target with bash.
remote_step() {
  local step="$1"
  shift
  {
    printf 'set -euo pipefail\n'
    declare -f remote_lib
    printf 'remote_lib\n'
    printf '%q ' "$step" "$@"
    printf '\n'
  } | remote "/bin/bash -s"
}

# Everything that runs on the target. Defined as a function so it ships
# with the script and shellcheck reads it; remote_step sends it over ssh (or
# runs it here), and the functions inside are called from there (SC2329).
# The node -e snippets are JavaScript, so their $ and backticks are meant
# literally (SC2016). CONNECTORS_LAUNCHCTL, CONNECTORS_TAILSCALE and
# CONNECTORS_HEALTH_WAIT let the deploy test (test/deploy/run.sh) swap in
# fakes and wait less; normally they're unset.
# shellcheck disable=SC2329,SC2016
remote_lib() {
  ROOT="$HOME/Library/Application Support/Connectors"
  LAUNCHCTL="${CONNECTORS_LAUNCHCTL:-launchctl}"
  HEALTH_WAIT="${CONNECTORS_HEALTH_WAIT:-60}"
  LOG="$HOME/Library/Logs/connectors.log"
  DOMAIN="gui/$(id -u)"

  # Sets LABEL, PORT, MODE, SERVE_PORT, PUBLIC_URL and PLIST from the
  # target's settings, read by a release's own CLI (the new one when
  # activating, the live one when rolling back).
  read_settings() {
    local release="$1" values
    values="$("$release/bin/node" "$release/dist/connectors.mjs" settings --json --home "$ROOT" |
      "$release/bin/node" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const t=JSON.parse(s).settings;console.log([t.launchdLabel,t.port,t.mode,t.servePort,t.publicUrl].join(" "))})')" || {
      echo "Couldn't read the settings with $release." >&2
      return 1
    }
    read -r LABEL PORT MODE SERVE_PORT PUBLIC_URL <<<"$values"
    PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
  }

  tailscale_cli() {
    local candidate
    if [ -n "${CONNECTORS_TAILSCALE:-}" ]; then
      printf '%s\n' "$CONNECTORS_TAILSCALE"
      return 0
    fi
    for candidate in /Applications/Tailscale.app/Contents/MacOS/Tailscale /usr/local/bin/tailscale /opt/homebrew/bin/tailscale; do
      if [ -x "$candidate" ]; then
        printf '%s\n' "$candidate"
        return 0
      fi
    done
    command -v tailscale || return 1
  }

  # Prints "<release id or none> <node version or none>".
  prepare() {
    local node_version="$1"
    mkdir -p "$ROOT/releases" "$ROOT/node" "$ROOT/bin" "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
    mkdir -p "$ROOT/secrets" "$ROOT/state"
    chmod 700 "$ROOT" "$ROOT/secrets" "$ROOT/state"
    local live="none" node="none"
    if [ -L "$ROOT/app" ]; then live="$(basename "$(readlink "$ROOT/app")")"; fi
    # A release live from before .went-live existed counts as one that came up.
    if [ "$live" != none ] && [ -d "$ROOT/releases/$live" ]; then touch "$ROOT/releases/$live/.went-live"; fi
    if [ -f "$ROOT/node/$node_version/.verified" ]; then node="$node_version"; fi
    printf '%s %s\n' "$live" "$node"
  }

  # Something else on our port would make the health check lie.
  check_port() {
    local holder job
    holder="$(/usr/sbin/lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t 2>/dev/null | head -1 || true)"
    job="$("$LAUNCHCTL" print "$DOMAIN/$LABEL" 2>/dev/null || true)"
    if [ -n "$holder" ] && ! printf '%s\n' "$job" | grep -Eq "^[[:space:]]*pid = $holder\$"; then
      echo "Port $PORT is in use by pid $holder, which isn't $LABEL." >&2
      return 1
    fi
  }

  check_node() {
    local node_version="$1" sha="$2"
    local dir="$ROOT/node/$node_version"
    [ -x "$dir/bin/node" ] || { echo "No Node at $dir" >&2; return 1; }
    "$dir/bin/node" --input-type=module -e '
      import { DatabaseSync } from "node:sqlite";
      const db = new DatabaseSync(":memory:");
      db.exec("CREATE TABLE t (body TEXT)");
      db.prepare("INSERT INTO t VALUES (?)").run("a\u0000b");
      const ok = db.prepare("SELECT body FROM t").get().body === "a\u0000b";
      if (process.version !== process.argv[1] || !ok) {
        console.error(`node ${process.version}, NUL-safe sqlite ${ok}`);
        process.exit(1);
      }' "$node_version"
    printf '{"sha256":"%s","checkedAt":"%s"}\n' "$sha" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >"$dir/.verified"
  }

  health_release() {
    curl -fsS --max-time 3 "http://127.0.0.1:$PORT/health" 2>/dev/null |
      "$ROOT/app/bin/node" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const h=JSON.parse(s);console.log(h.ok?h.release??"":"")}catch{console.log("")}})' 2>/dev/null || true
  }

  wait_healthy() {
    local id="$1"
    for _ in $(seq 1 "$HEALTH_WAIT"); do
      if [ "$(health_release)" = "$id" ]; then return 0; fi
      sleep 1
    done
    return 1
  }

  # Swaps the app symlink in one rename, so it always points somewhere.
  point_app_at() {
    local id="$1"
    "$ROOT/releases/$id/bin/node" -e '
      const fs = require("node:fs");
      const [root, id] = process.argv.slice(1);
      const next = `${root}/app.next-${process.pid}`;
      fs.symlinkSync(`releases/${id}`, next);
      fs.renameSync(next, `${root}/app`);' "$ROOT" "$id"
  }

  # launchd can refuse a bootstrap that comes right after a bootout
  # ("Bootstrap failed: 5: Input/output error"), so wait for the old job to
  # go and try a few times.
  bootstrap() {
    local attempt
    for _ in $(seq 1 20); do
      "$LAUNCHCTL" print "$DOMAIN/$LABEL" >/dev/null 2>&1 || break
      sleep 0.5
    done
    for attempt in 1 2 3; do
      if "$LAUNCHCTL" bootstrap "$DOMAIN" "$PLIST"; then return 0; fi
      echo "launchctl bootstrap failed (try $attempt of 3)." >&2
      sleep 2
    done
    return 1
  }

  # Installs the live release's plist and (re)starts the job. Returns
  # non-zero on any failure instead of exiting: callers use it in an `if`,
  # where set -e is off, so a failure takes the rollback path.
  restart() {
    local rendered template="$ROOT/app/ops/launchd/connectors.plist"
    # Releases from before the generic template named it after the label.
    [ -f "$template" ] || template="$ROOT/app/ops/launchd/$LABEL.plist"
    rendered="$(mktemp)" || return 1
    sed -e "s|{{HOME}}|$HOME|g" -e "s|{{LABEL}}|$LABEL|g" "$template" >"$rendered" || return 1
    plutil -lint "$rendered" >/dev/null || { echo "The rendered plist isn't valid." >&2; rm -f "$rendered"; return 1; }
    # A big log is moved aside before the restart reopens it.
    if [ -f "$LOG" ] && [ "$(stat -f %z "$LOG")" -gt 52428800 ]; then mv -f "$LOG" "$LOG.1"; fi
    if "$LAUNCHCTL" print "$DOMAIN/$LABEL" >/dev/null 2>&1; then
      if cmp -s "$rendered" "$PLIST"; then
        rm -f "$rendered"
        "$LAUNCHCTL" kickstart -k "$DOMAIN/$LABEL" || return 1
        return 0
      fi
      "$LAUNCHCTL" bootout "$DOMAIN/$LABEL" || true
    fi
    mv -f "$rendered" "$PLIST" || return 1
    bootstrap
  }

  write_wrapper() {
    local wrapper="$ROOT/bin/connectors"
    cat >"$wrapper.tmp" <<'WRAPPER'
#!/bin/sh
# Written by scripts/deploy.sh. Runs the live release's CLI on its pinned
# Node, so `ssh <host> '"$HOME/Library/Application Support/Connectors/bin/connectors" agent list'`
# works without a login shell's PATH.
# It always means this data folder, whatever CONNECTORS_HOME says.
root="$(cd "$(dirname "$0")/.." && pwd -P)"
CONNECTORS_HOME="$root" exec "$root/app/bin/node" "$root/app/dist/connectors.mjs" "$@"
WRAPPER
    chmod 755 "$wrapper.tmp"
    mv -f "$wrapper.tmp" "$wrapper"
  }

  activate() {
    local id="$1" node_version="$2"
    shift 2
    local release="$ROOT/releases/$id"
    [ -f "$release/dist/connectors.mjs" ] || { echo "$release is incomplete" >&2; return 1; }
    ln -sfn "$ROOT/node/$node_version/bin/node" "$release/bin/node"
    # The first deploy writes settings.json and agents.json; later ones
    # leave them as they are.
    "$release/bin/node" "$release/dist/connectors.mjs" init --home "$ROOT" "$@"
    # The new release must read the config before it goes live.
    read_settings "$release"
    "$release/bin/node" "$release/dist/connectors.mjs" agent list --home "$ROOT" >/dev/null
    check_port
    local previous="none"
    if [ -L "$ROOT/app" ]; then previous="$(basename "$(readlink "$ROOT/app")")"; fi
    point_app_at "$id"
    write_wrapper
    if restart && wait_healthy "$id"; then
      touch "$release/.went-live"
      echo "Release $id is live."
      prune_releases
      return 0
    fi
    echo "Release $id didn't report healthy within $HEALTH_WAIT seconds. Last log lines:" >&2
    tail -n 20 "$LOG" >&2 || true
    if [ "$previous" != "none" ] && [ "$previous" != "$id" ] && [ -d "$ROOT/releases/$previous" ]; then
      echo "Going back to $previous." >&2
      point_app_at "$previous"
      if restart && wait_healthy "$previous"; then
        echo "$previous is live again." >&2
        # Never a rollback target: it didn't come up.
        rm -rf "$release"
        echo "Deleted the failed release $id." >&2
      else
        echo "$previous isn't healthy either." >&2
      fi
    fi
    return 1
  }

  # Releases that have served /health, oldest first. Release ids start with
  # a UTC timestamp, so they sort by age.
  good_releases() {
    local dir
    for dir in "$ROOT/releases"/*/; do
      if [ -f "$dir.went-live" ]; then basename "$dir"; fi
    done | sort
  }

  rollback() {
    local live previous
    read_settings "$ROOT/app"
    live="$(basename "$(readlink "$ROOT/app")")"
    previous="$(good_releases | awk -v live="$live" '$0 < live' | tail -1)"
    [ -n "$previous" ] || { echo "No release older than $live has been live, so there's nothing to go back to." >&2; return 1; }
    echo "Rolling back from $live to $previous."
    point_app_at "$previous"
    if restart && wait_healthy "$previous"; then
      echo "$previous is live."
      return 0
    fi
    echo "$previous didn't come up. Going back to $live." >&2
    tail -n 20 "$LOG" >&2 || true
    point_app_at "$live"
    if restart && wait_healthy "$live"; then echo "$live is live again." >&2; else echo "$live isn't healthy either." >&2; fi
    return 1
  }

  # Keeps the live release and the two newest others that have been live,
  # and deletes any release that never came up.
  prune_releases() {
    local live dir id
    live="$(basename "$(readlink "$ROOT/app")")"
    for dir in "$ROOT/releases"/*/; do
      id="$(basename "$dir")"
      if [ "$id" != "$live" ] && [ ! -f "$dir.went-live" ]; then rm -rf "${ROOT:?}/releases/$id"; fi
    done
    good_releases | sort -r | { grep -vx "$live" || true; } | tail -n +3 | while read -r old; do
      rm -rf "${ROOT:?}/releases/$old"
    done
  }

  # The live release's public URL, for the check at the end.
  public_url() {
    read_settings "$ROOT/app"
    printf '%s %s\n' "$MODE" "$PUBLIC_URL"
  }

  # Publishes the gateway on the tailnet unless the port already serves
  # something else, which it leaves alone. If it can't read what's served,
  # it doesn't guess. Only in tailscale mode.
  publish() {
    local ts status
    read_settings "$ROOT/app"
    PUBLISH_PORT="$SERVE_PORT"
    if [ "$MODE" != tailscale ]; then
      echo "Local mode, so tailscale serve isn't needed."
      return 0
    fi
    ts="$(tailscale_cli)" || { echo "Tailscale CLI not found; skipping tailscale serve." >&2; return 0; }
    if ! status="$("$ts" serve status --json 2>/dev/null)"; then
      echo "Couldn't read 'tailscale serve status', so tailscale serve is left alone." >&2
      echo "Check port $PUBLISH_PORT by hand, then run: $ts serve --bg --https=$PUBLISH_PORT http://127.0.0.1:$PORT" >&2
      return 0
    fi
    local current
    # Prints "free", the one proxy target on the port, "unknown" for output
    # it can't read, or a short description of anything else there.
    current="$(printf '%s' "$status" | "$ROOT/app/bin/node" -e '
      let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
        const port = process.argv[1];
        let status;
        try { status = JSON.parse(s.trim() || "{}"); } catch { return console.log("unknown"); }
        if (!status || typeof status !== "object" || Array.isArray(status)) return console.log("unknown");
        const proxies = [];
        for (const [hostPort, site] of Object.entries(status.Web ?? {})) {
          if (!hostPort.endsWith(`:${port}`)) continue;
          for (const handler of Object.values(site?.Handlers ?? {})) proxies.push(handler?.Proxy ?? "a non-proxy handler");
        }
        const tcp = (status.TCP ?? {})[port];
        if (proxies.length === 1) console.log(proxies[0]);
        else if (proxies.length > 1) console.log(`${proxies.length} handlers`);
        else if (tcp) console.log(tcp.TCPForward ? `a TCP forward to ${tcp.TCPForward}` : "something");
        else console.log("free");
      });' "$PUBLISH_PORT")"
    case "$current" in
      unknown)
        echo "Couldn't read 'tailscale serve status --json', so tailscale serve is left alone." >&2
        ;;
      free)
        if "$ts" serve --bg --https="$PUBLISH_PORT" "http://127.0.0.1:$PORT"; then
          echo "Published on :$PUBLISH_PORT."
        else
          echo "tailscale serve failed; the gateway runs, but only on its machine's loopback." >&2
        fi
        ;;
      "http://127.0.0.1:$PORT" | "http://localhost:$PORT" | "127.0.0.1:$PORT")
        echo "Already published on :$PUBLISH_PORT."
        ;;
      *)
        echo "Port $PUBLISH_PORT already serves $current; leaving tailscale serve alone." >&2
        ;;
    esac
  }
}

# --- On this Mac ---------------------------------------------------------

cd "$REPO"

if [ "$rollback" = 1 ]; then
  say "Rolling back on $TARGET"
  remote_step rollback
  exit 0
fi

node_field() {
  sed -n "s/.*\"$1\": *\"\([^\"]*\)\".*/\1/p" "$REPO/ops/node.json"
}
NODE_VERSION="$(node_field version)"
NODE_FILE="$(node_field file)"
NODE_SHA="$(node_field sha256)"
[ -n "$NODE_VERSION" ] && [ -n "$NODE_FILE" ] && [ -n "$NODE_SHA" ] || die "ops/node.json is missing version, file or sha256"

dirty=false
if git rev-parse --git-dir >/dev/null 2>&1; then
  if [ -n "$(git status --porcelain)" ]; then
    dirty=true
    [ "$allow_dirty" = 1 ] || die "The working tree has uncommitted changes. Commit them, or pass --allow-dirty."
  fi
  sha="$(git rev-parse HEAD)"
else
  # A download without git history: the release id says so.
  sha="0000000000000000000000000000000000000000"
  dirty=true
fi
id="$(date -u +%Y%m%dT%H%M%SZ)-${sha:0:8}"

if [ "$skip_checks" = 1 ]; then
  say "Building (checks skipped)"
  npx -y -p "node@${NODE_VERSION#v}" npm run build
else
  say "Typecheck, tests and build"
  npx -y -p "node@${NODE_VERSION#v}" npm run check
fi

# The official Node, checked against the pin here, and only its bin/node
# goes to the target (an Apple silicon Mac, like this one).
node_dir="$NODE_CACHE/$NODE_VERSION"
if [ ! -x "$node_dir/bin/node" ]; then
  say "Downloading $NODE_FILE"
  work="$(mktemp -d)"
  curl -fsSL "https://nodejs.org/dist/$NODE_VERSION/$NODE_FILE" -o "$work/$NODE_FILE"
  actual="$(shasum -a 256 "$work/$NODE_FILE" | awk '{print $1}')"
  [ "$actual" = "$NODE_SHA" ] || die "$NODE_FILE has SHA-256 $actual, but ops/node.json pins $NODE_SHA"
  tar -xzf "$work/$NODE_FILE" -C "$work"
  mkdir -p "$node_dir/bin"
  cp "$work/${NODE_FILE%.tar.gz}/bin/node" "$node_dir/bin/node"
  cp "$work/${NODE_FILE%.tar.gz}/LICENSE" "$node_dir/LICENSE"
  rm -rf "$work"
fi
[ "$("$node_dir/bin/node" --version)" = "$NODE_VERSION" ] || die "$node_dir/bin/node isn't $NODE_VERSION"

say "Staging release $id"
stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT
mkdir -p "$stage/dist" "$stage/config" "$stage/ops/launchd" "$stage/bin"
cp dist/connectors.mjs dist/google-mcp.mjs "$stage/dist/"
# Only the examples: each machine's own config lives in its data folder.
cp config/*.example.json "$stage/config/"
cp ops/node.json "$stage/ops/"
cp ops/launchd/connectors.plist "$stage/ops/launchd/"
version="$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' package.json | head -1)"
printf '{\n  "id": "%s",\n  "sha": "%s",\n  "version": "%s",\n  "dirty": %s,\n  "builtAt": "%s",\n  "node": "%s"\n}\n' \
  "$id" "$sha" "$version" "$dirty" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$NODE_VERSION" >"$stage/release.json"

# The staged bundle must run on the pinned Node and accept the examples.
check_home="$(mktemp -d)"
"$node_dir/bin/node" "$stage/dist/connectors.mjs" agent list --home "$check_home" >/dev/null
rm -rf "$check_home"
# The built-in Google server must start too (it exits when stdin closes).
"$node_dir/bin/node" "$stage/dist/google-mcp.mjs" gmail </dev/null 2>/dev/null
sed -e "s|{{HOME}}|$HOME|g" -e "s|{{LABEL}}|local.connectors|g" "$stage/ops/launchd/connectors.plist" | plutil -lint - >/dev/null

if [ "$dry_run" = 1 ]; then
  say "Dry run: release $id is staged and checked; stopping before $TARGET"
  exit 0
fi

say "Preparing $TARGET"
prepared="$(remote_step prepare "$NODE_VERSION")" || die "Preparing $TARGET failed."
read -r live remote_node <<<"$prepared"
echo "Live release: $live. Node $NODE_VERSION on $TARGET: $([ "$remote_node" = none ] && echo missing || echo present)."

if [ "$remote_node" = none ]; then
  say "Copying Node $NODE_VERSION to $TARGET"
  copy_dir "$node_dir/" "node/$NODE_VERSION/"
  remote_step check_node "$NODE_VERSION" "$NODE_SHA"
fi

say "Copying release $id to $TARGET"
copy_dir "$stage/" "releases/$id/"

say "Activating $id"
remote_step activate "$id" "$NODE_VERSION" ${init_args[@]+"${init_args[@]}"}

if [ "$publish" = 1 ]; then
  say "Publishing with tailscale serve"
  remote_step publish
fi

read -r mode public_url <<<"$(remote_step public_url | tail -1)"
# A local-mode gateway on another machine only answers there.
if [ "$mode" = local ] && [ -n "$host" ]; then
  echo "$TARGET runs in local mode, so its gateway only answers on $TARGET itself."
  exit 0
fi
say "Checking $public_url/health"
if curl -fsS --max-time 10 "$public_url/health"; then
  echo
else
  echo "Couldn't reach $public_url/health from this Mac. It's live on $TARGET's loopback; check tailscale serve." >&2
fi
