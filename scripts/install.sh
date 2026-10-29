#!/usr/bin/env bash
# Installs Connectors: builds it, sets up the data folder, its config and
# its LaunchAgent (scripts/deploy.sh), wires the agents on this Mac
# (scripts/install-clients.sh) and opens the admin page. Running it again
# updates the gateway and leaves your config alone.
#
#   scripts/install.sh                          on this Mac, local mode
#   scripts/install.sh --tailscale              on this Mac, published on your tailnet
#   scripts/install.sh --host studio --tailscale  on the Mac you reach as `ssh studio`
#
# Without --host (or --local) it goes where it went last time: gatewayHost
# in this Mac's settings.json, or this Mac.
#
# Options:
#   --admin-login LOGIN  tailscale mode: the Tailscale login allowed on the
#                        admin pages (default: the one signed in on the target)
#   --public-url URL     tailscale mode: https://<machine>.<tailnet>.ts.net:8443
#                        (default: read from Tailscale on the target)
#   --owner NAME         what agents call you ("Waiting for Sam to approve this")
#   --no-clients         don't wire the agents on this Mac
#   --no-open            don't open the admin page at the end
#
# Needs an Apple silicon Mac, and Node.js with npm on this Mac to build
# (any recent version; the gateway runs on the Node that ops/node.json
# pins, which the deploy downloads and checks).

set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
DATA="${CONNECTORS_HOME:-$HOME/Library/Application Support/Connectors}"
host=""
host_given=0
deploy_args=()
clients=1
open_admin=1

usage() {
  sed -n '2,26p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

while [ $# -gt 0 ]; do
  case "$1" in
    --host)
      host="${2:?--host needs an ssh host}"
      host_given=1
      shift
      ;;
    --local)
      host=""
      host_given=1
      ;;
    --tailscale) deploy_args+=(--mode tailscale) ;;
    --admin-login | --public-url | --owner)
      deploy_args+=("$1" "${2:?$1 needs a value}")
      shift
      ;;
    --no-clients) clients=0 ;;
    --no-open) open_admin=0 ;;
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
  printf 'install: %s\n' "$*" >&2
  exit 1
}

if [ "$host_given" = 0 ] && [ -f "$DATA/config/settings.json" ]; then
  host="$(/usr/bin/python3 -c 'import json, sys; print(json.load(open(sys.argv[1])).get("gatewayHost") or "")' "$DATA/config/settings.json")"
fi
case "$host" in
  *[!A-Za-z0-9._@-]*) die "$host isn't an ssh host name." ;;
esac
[ "$(uname -s)" = Darwin ] || die "Connectors runs on macOS (it uses launchd and the Keychain)."
[ "$(uname -m)" = arm64 ] || die "ops/node.json pins Node for Apple silicon, and this Mac isn't one."
command -v npx >/dev/null 2>&1 || die "Install Node.js (with npm) first, for example from https://nodejs.org. It's only used to build."
[ -x /usr/bin/python3 ] || die "The scripts need /usr/bin/python3. Run 'xcode-select --install' first."

cd "$REPO"
node_version="$(sed -n 's/.*"version": *"v\([^"]*\)".*/\1/p' ops/node.json)"
if [ ! -d node_modules ] || [ package-lock.json -nt node_modules ]; then
  say "Installing dependencies"
  npx -y -p "node@$node_version" npm ci
fi

if [ -n "$host" ]; then
  # This Mac's settings.json remembers where the gateway is, for later
  # deploys and install-clients.sh. An existing one is left alone.
  mkdir -p "$DATA/config"
  /usr/bin/python3 - "$DATA/config/settings.json" "$host" <<'PY'
import json, os, sys
path, host = sys.argv[1], sys.argv[2]
data = json.load(open(path)) if os.path.exists(path) else {}
current = data.get("gatewayHost")
if current and current != host:
    print(f"{path} says the gateway is on {current}; leaving it. Pass --host each time, or edit it.", file=sys.stderr)
    sys.exit(0)
data["gatewayHost"] = host
with open(path, "w") as handle:
    json.dump(data, handle, indent=2)
    handle.write("\n")
PY
  say "Installing the gateway on $host"
  "$REPO/scripts/deploy.sh" --host "$host" --skip-checks --allow-dirty ${deploy_args[@]+"${deploy_args[@]}"}
else
  say "Installing the gateway on this Mac"
  "$REPO/scripts/deploy.sh" --local --skip-checks --allow-dirty ${deploy_args[@]+"${deploy_args[@]}"}
  # `connectors open` is how a browser signs in to the admin pages, so put
  # the command where a shell finds it.
  # A small script, not a symlink: the wrapper finds its data folder from
  # where it is.
  mkdir -p "$HOME/.local/bin"
  printf '#!/bin/sh\n# Written by connectors scripts/install.sh.\nexec "%s/bin/connectors" "$@"\n' "$DATA" >"$HOME/.local/bin/connectors"
  chmod 755 "$HOME/.local/bin/connectors"
  case ":$PATH:" in
    *":$HOME/.local/bin:"*) ;;
    *) echo "Add ~/.local/bin to your PATH to run 'connectors' by name, or run $HOME/.local/bin/connectors." ;;
  esac
fi

if [ "$clients" = 1 ]; then
  say "Wiring the agents on this Mac"
  if [ -n "$host" ]; then
    "$REPO/scripts/install-clients.sh" --host "$host" || echo "Some agents weren't wired; see above. Fix it and run scripts/install-clients.sh again."
  else
    "$REPO/scripts/install-clients.sh" || echo "Some agents weren't wired; see above. Fix it and run scripts/install-clients.sh again."
  fi
fi

if [ "$open_admin" = 1 ]; then
  say "Opening the admin page"
  if [ -n "$host" ]; then
    # shellcheck disable=SC2016 # Expanded on the other machine.
    url="$(ssh "$host" '"$HOME/Library/Application Support/Connectors/bin/connectors" open /admin --print')"
    case "$url" in
      https://*) open "$url" ;;
      *) echo "The gateway on $host is in local mode, so its admin page only opens on $host: run 'connectors open' there." ;;
    esac
  else
    "$DATA/bin/connectors" open /admin
  fi
fi

say "Done. Press Connect for each service on the admin page; your agents see its tools from their next session."
