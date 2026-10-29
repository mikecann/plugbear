#!/usr/bin/env bash
# `npm run test:deploy`: runs scripts/deploy.sh end to end against a fake
# gateway machine on this Mac. test/deploy/bin/ssh runs the "remote" side here with
# HOME set to a temp folder and fake launchctl and tailscale, so nothing
# touches the real launchd, Tailscale or another machine. The gateway really starts,
# on 127.0.0.1:8795, from the deployed release and the pinned Node.
#
# Checks: first deploy (settings.json from the flags, bootstrap, Node copy,
# wrapper, tailscale serve),
# a second deploy (kickstart), a release that won't start (automatic
# rollback, and the failed release is deleted), a launchctl bootstrap that
# fails (automatic rollback), --rollback (skipping a release that never
# came up), tailscale serve status failing or 8443 taken by something else
# (left alone), pruning to three releases, and a --rollback whose target
# won't start (back to the live one). Then a deploy to "this Mac" (--local,
# with HOME pointed at another temp folder) in local mode.

set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
HERE="$REPO/test/deploy"
LABEL="local.connectors"

if /usr/sbin/lsof -nP -iTCP:8795 -sTCP:LISTEN >/dev/null 2>&1; then
  echo "Something already listens on 127.0.0.1:8795; stop it first." >&2
  exit 1
fi

FAKE_REMOTE_HOME="$(mktemp -d "${TMPDIR:-/tmp}/connectors-fake-gateway.XXXXXX")"
export FAKE_REMOTE_HOME
export CONNECTORS_DEPLOY_HOST=fake-gateway
export CONNECTORS_DEPLOY_SSH="$HERE/bin/ssh"
# Reaches the fake remote side through test/deploy/bin/ssh.
export CONNECTORS_HEALTH_WAIT=10
# This Mac's settings.json must not choose the target.
export CONNECTORS_HOME="$FAKE_REMOTE_HOME/this-mac"
ROOT="$FAKE_REMOTE_HOME/Library/Application Support/Connectors"

cleanup() {
  HOME="$FAKE_REMOTE_HOME" "$HERE/bin/launchctl" bootout "gui/$(id -u)/$LABEL" >/dev/null 2>&1 || true
}
trap cleanup EXIT

fail() {
  echo "FAIL: $*" >&2
  echo "Fake gateway: $FAKE_REMOTE_HOME" >&2
  exit 1
}

live() { basename "$(readlink "$ROOT/app")"; }
releases() { find "$ROOT/releases" -mindepth 1 -maxdepth 1 -type d -exec basename {} \; | sort | tr '\n' ' '; }
health_release() {
  curl -fsS --max-time 3 http://127.0.0.1:8795/health | /usr/bin/python3 -c 'import json,sys; print(json.load(sys.stdin).get("release") or "")'
}
deploy() { "$REPO/scripts/deploy.sh" --skip-checks --allow-dirty "$@"; }

echo "== First deploy"
deploy --mode tailscale --public-url http://127.0.0.1:8795 --admin-login sam@example.com >"$FAKE_REMOTE_HOME/deploy1.log" 2>&1 || {
  cat "$FAKE_REMOTE_HOME/deploy1.log"
  fail "first deploy"
}
first="$(live)"
settings="$ROOT/config/settings.json"
/usr/bin/python3 -c 'import json,sys; s=json.load(open(sys.argv[1])); assert s["mode"]=="tailscale" and s["adminLogins"]==["sam@example.com"], s' "$settings" ||
  fail "settings.json wasn't written from the flags"
[ -f "$ROOT/config/agents.json" ] || fail "agents.json wasn't written from the example"
[ ! -f "$ROOT/releases/$first/config/agents.json" ] || fail "a release carries its own agents.json"
grep -q "{{" "$FAKE_REMOTE_HOME/Library/LaunchAgents/$LABEL.plist" && fail "plist has unrendered placeholders"
[ "$(health_release)" = "$first" ] || fail "/health doesn't report $first"
[ -f "$ROOT/node/v26.12.1/.verified" ] || fail "Node wasn't verified on the fake gateway"
[ "$(readlink "$ROOT/app/bin/node")" = "$ROOT/node/v26.12.1/bin/node" ] || fail "release bin/node isn't the pinned Node"
[ "$(stat -f %Lp "$ROOT/secrets")" = 700 ] || fail "secrets/ isn't 0700"
plutil -lint "$FAKE_REMOTE_HOME/Library/LaunchAgents/$LABEL.plist" >/dev/null || fail "installed plist isn't valid"
grep -q "$FAKE_REMOTE_HOME/Library/Application Support/Connectors/app/bin/node" "$FAKE_REMOTE_HOME/Library/LaunchAgents/$LABEL.plist" ||
  fail "plist wasn't rendered with HOME"
grep -q '"Proxy":"http://127.0.0.1:8795"' "$FAKE_REMOTE_HOME/.fake-tailscale.json" || fail "tailscale serve wasn't set up"
# The plist sets NODE_ENV=production, but there's no DSN and the fake
# launchd turns Sentry off anyway.
grep -q "connectors .* listening on" "$FAKE_REMOTE_HOME/Library/Logs/connectors.log" || fail "no listening line in the log"
! grep -q "sentry: reporting errors" "$FAKE_REMOTE_HOME/Library/Logs/connectors.log" || fail "Sentry started in the deploy test"
HOME="$FAKE_REMOTE_HOME" "$ROOT/bin/connectors" agent list >/dev/null || fail "the bin/connectors wrapper doesn't run"
# The example agents.json has claude and codex.
token="$(HOME="$FAKE_REMOTE_HOME" "$ROOT/bin/connectors" agent add codex 2>/dev/null)"
[[ "$token" =~ ^cn_codex_ ]] || fail "agent add through the wrapper didn't print a token"
status="$(curl -s -o /dev/null -w '%{http_code}' -X POST -H "Authorization: Bearer $token" \
  -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  --data '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"deploy-test","version":"1"}}}' \
  http://127.0.0.1:8795/mcp)"
[ "$status" = 200 ] || fail "/mcp didn't accept the new token (HTTP $status)"
echo "ok: $first is live, Node pinned, wrapper, token and /mcp work, published on :8443"

echo "== Second deploy"
sleep 1
cp "$settings" "$FAKE_REMOTE_HOME/settings-before.json"
# Init flags don't change an existing settings.json.
deploy --mode local >"$FAKE_REMOTE_HOME/deploy2.log" 2>&1 || {
  cat "$FAKE_REMOTE_HOME/deploy2.log"
  fail "second deploy"
}
second="$(live)"
[ "$second" != "$first" ] || fail "app didn't move"
[ "$(health_release)" = "$second" ] || fail "/health doesn't report $second"
grep -q "Already published" "$FAKE_REMOTE_HOME/deploy2.log" || fail "tailscale serve was set up twice"
grep -q "Copying Node" "$FAKE_REMOTE_HOME/deploy2.log" && fail "Node was copied again"
cmp -s "$settings" "$FAKE_REMOTE_HOME/settings-before.json" || fail "a later deploy changed settings.json"
# The token from the first release still works: secrets/ survive deploys.
HOME="$FAKE_REMOTE_HOME" "$ROOT/bin/connectors" agent list --json | grep -q '"hasToken": true' || fail "agent token lost"
echo "ok: $second replaced $first; Node and secrets kept"

echo "== A release that won't start"
sleep 1
mkdir -p "$FAKE_REMOTE_HOME/.fake-launchd"
touch "$FAKE_REMOTE_HOME/.fake-launchd/break-next"
if deploy >"$FAKE_REMOTE_HOME/deploy3.log" 2>&1; then fail "a broken release deployed"; fi
grep -q "Going back to $second" "$FAKE_REMOTE_HOME/deploy3.log" || {
  cat "$FAKE_REMOTE_HOME/deploy3.log"
  fail "no automatic rollback"
}
[ "$(live)" = "$second" ] || fail "app isn't back on $second"
[ "$(health_release)" = "$second" ] || fail "$second isn't serving after the rollback"
[ "$(releases)" = "$first $second " ] || fail "the failed release was kept: $(releases)"
echo "ok: the broken release was rolled back to $second and deleted"

echo "== A launchctl bootstrap that keeps failing"
sleep 1
# A changed plist makes the deploy boot the job out and bootstrap it again.
echo '<!-- changed -->' >>"$FAKE_REMOTE_HOME/Library/LaunchAgents/$LABEL.plist"
echo 3 >"$FAKE_REMOTE_HOME/.fake-launchd/fail-bootstrap"
if deploy >"$FAKE_REMOTE_HOME/deploy-bootstrap.log" 2>&1; then fail "a deploy whose bootstrap failed succeeded"; fi
grep -q "Going back to $second" "$FAKE_REMOTE_HOME/deploy-bootstrap.log" || {
  cat "$FAKE_REMOTE_HOME/deploy-bootstrap.log"
  fail "no rollback after the bootstrap failed"
}
[ "$(live)" = "$second" ] || fail "app isn't back on $second after the failed bootstrap"
[ "$(health_release)" = "$second" ] || fail "$second isn't serving after the failed bootstrap"
[ "$(releases)" = "$first $second " ] || fail "the failed release was kept: $(releases)"
echo "ok: a failed bootstrap went back to $second"

echo "== --rollback"
# A release that never came up, from before failed ones were deleted, sits
# between the two good ones. --rollback must skip it.
cp -R "$ROOT/releases/$first" "$ROOT/releases/${first}x"
rm -f "$ROOT/releases/${first}x/.went-live"
"$REPO/scripts/deploy.sh" --rollback >"$FAKE_REMOTE_HOME/rollback.log" 2>&1 || {
  cat "$FAKE_REMOTE_HOME/rollback.log"
  fail "--rollback"
}
[ "$(live)" = "$first" ] || fail "--rollback didn't go to $first (it's on $(live))"
[ "$(health_release)" = "$first" ] || fail "$first isn't serving after --rollback"
echo "ok: --rollback went from $second to $first, past a release that never came up"

echo "== tailscale serve status failing, then 8443 taken"
sleep 1
touch "$FAKE_REMOTE_HOME/.fake-tailscale-status-fails"
rm -f "$FAKE_REMOTE_HOME/.fake-tailscale-serves"
deploy >"$FAKE_REMOTE_HOME/deploy4.log" 2>&1 || {
  cat "$FAKE_REMOTE_HOME/deploy4.log"
  fail "deploy 4"
}
rm -f "$FAKE_REMOTE_HOME/.fake-tailscale-status-fails"
grep -q "Couldn't read 'tailscale serve status'" "$FAKE_REMOTE_HOME/deploy4.log" || fail "no warning when serve status failed"
[ ! -f "$FAKE_REMOTE_HOME/.fake-tailscale-serves" ] || fail "tailscale serve ran without knowing what 8443 serves"
taken='{"TCP":{"8443":{"TCPForward":"127.0.0.1:9999"}}}'
printf '%s\n' "$taken" >"$FAKE_REMOTE_HOME/.fake-tailscale.json"
sleep 1
deploy >"$FAKE_REMOTE_HOME/deploy5.log" 2>&1 || {
  cat "$FAKE_REMOTE_HOME/deploy5.log"
  fail "deploy 5"
}
grep -q "already serves a TCP forward to 127.0.0.1:9999; leaving tailscale serve alone" "$FAKE_REMOTE_HOME/deploy5.log" ||
  fail "8443's TCP forward wasn't seen"
[ "$(cat "$FAKE_REMOTE_HOME/.fake-tailscale.json")" = "$taken" ] || fail "tailscale serve config changed"
[ ! -f "$FAKE_REMOTE_HOME/.fake-tailscale-serves" ] || fail "tailscale serve ran over 8443's TCP forward"
echo "ok: tailscale serve left alone both times"

echo "== Pruning"
count="$(find "$ROOT/releases" -mindepth 1 -maxdepth 1 -type d | wc -l | tr -d ' ')"
[ "$count" = 3 ] || fail "$count releases kept, not 3: $(releases)"
[ ! -d "$ROOT/releases/${first}x" ] || fail "the release that never came up was kept"
[ "$(health_release)" = "$(live)" ] || fail "the last deploy isn't serving"
echo "ok: 3 releases kept, $(live) live"

echo "== --rollback to a release that won't start"
newest="$(live)"
touch "$FAKE_REMOTE_HOME/.fake-launchd/break-next"
if "$REPO/scripts/deploy.sh" --rollback >"$FAKE_REMOTE_HOME/rollback2.log" 2>&1; then fail "a failed --rollback reported success"; fi
grep -q "Going back to $newest" "$FAKE_REMOTE_HOME/rollback2.log" || {
  cat "$FAKE_REMOTE_HOME/rollback2.log"
  fail "no return to $newest"
}
[ "$(live)" = "$newest" ] || fail "app isn't back on $newest"
[ "$(health_release)" = "$newest" ] || fail "$newest isn't serving after the failed --rollback"
echo "ok: a --rollback whose target won't start went back to $newest"

trap - EXIT
cleanup

echo "== A local-mode deploy to this Mac"
LOCAL_HOME="$FAKE_REMOTE_HOME/local-home"
mkdir -p "$LOCAL_HOME"
LOCAL_ROOT="$LOCAL_HOME/Library/Application Support/Connectors"
# deploy.sh runs the "remote" side itself here, so the fakes come in
# through the environment. The Node and npm caches stay the real ones.
REAL_HOME="$HOME"
local_deploy() {
  HOME="$LOCAL_HOME" CONNECTORS_HOME="$LOCAL_HOME/data" \
    CONNECTORS_NODE_CACHE="${CONNECTORS_NODE_CACHE:-$REAL_HOME/Library/Caches/connectors/node}" npm_config_cache="$REAL_HOME/.npm" \
    CONNECTORS_LAUNCHCTL="$HERE/bin/launchctl" CONNECTORS_TAILSCALE="$HERE/bin/tailscale" \
    CONNECTORS_DEPLOY_HOST="" CONNECTORS_DEPLOY_SSH="$HERE/bin/no-ssh" "$REPO/scripts/deploy.sh" --skip-checks --allow-dirty --local "$@"
}
local_deploy --owner Ana >"$FAKE_REMOTE_HOME/deploy-local.log" 2>&1 || {
  cat "$FAKE_REMOTE_HOME/deploy-local.log"
  fail "local deploy"
}
[ -L "$LOCAL_ROOT/app" ] || fail "no app symlink on this Mac"
/usr/bin/python3 -c 'import json,sys; s=json.load(open(sys.argv[1])); assert s=={"mode":"local","ownerName":"Ana"}, s' "$LOCAL_ROOT/config/settings.json" ||
  fail "local settings.json isn't local mode"
grep -q "Local mode, so tailscale serve isn't needed" "$FAKE_REMOTE_HOME/deploy-local.log" || fail "tailscale serve ran in local mode"
[ ! -f "$LOCAL_HOME/.fake-tailscale-serves" ] || fail "tailscale serve ran in local mode"
[ "$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8795/admin)" = 401 ] || fail "local admin page isn't asking for sign-in"
grep -q "Checking http://127.0.0.1:8795/health" "$FAKE_REMOTE_HOME/deploy-local.log" || fail "no health check against the local URL"
HOME="$LOCAL_HOME" "$HERE/bin/launchctl" bootout "gui/$(id -u)/$LABEL" >/dev/null 2>&1 || true
echo "ok: deployed to this Mac in local mode, no tailscale serve, admin pages want a sign-in"

echo "PASS: deploy.sh against a fake gateway"
# The fake gateway holds a 140 MB copy of Node; keep it only when asked.
if [ "${KEEP_FAKE_GATEWAY:-0}" = 1 ]; then echo "Kept $FAKE_REMOTE_HOME"; else rm -rf "$FAKE_REMOTE_HOME"; fi
