#!/usr/bin/env bash
# Update a self-hosted CodeWrench server to the branch tip in one step. Run it ON the server, as
# the user that owns the service, from the server's checkout.
#
#   scripts/codewrench-server-update.sh           update, rebuild, restart when no agent is running
#   scripts/codewrench-server-update.sh --wait    same, but wait for running agents to finish
#   scripts/codewrench-server-update.sh --force   restart even if agents are running
#   scripts/codewrench-server-update.sh --mac-later   restart even though the Mac app is older
#
# Restarting ends any run in progress. With "Continue threads after restarts" on and the service
# stopping the server before its agents (KillMode=mixed), interrupted runs resume by themselves.
#
# The Mac app must not be older than the server: on 2026-10-07 an older app lost its connection
# to a newer server every 15 seconds for an hour. scripts/codewrench-mac-update.sh records the
# commit it installs in $BACKUP_DIR/mac-commit, and this script will not restart onto a commit
# the Mac app does not have yet. Update the Mac first, or pass --mac-later.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVICE="${CODEWRENCH_SERVICE:-codewrench.service}"
BRANCH="${CODEWRENCH_BRANCH:-$(git -C "$REPO" branch --show-current)}"
BACKUP_DIR="${CODEWRENCH_SERVER_BACKUP_DIR:-$HOME/codewrench-backups}"
PORT="${CODEWRENCH_PORT:-3773}"
NODE_BIN_DIR="${CODEWRENCH_NODE_BIN_DIR:-$HOME/.local/node24/bin}"
BUILT_MARK="$BACKUP_DIR/built-commit"
RUNNING_MARK="$BACKUP_DIR/running-commit"
MAC_MARK="$BACKUP_DIR/mac-commit"

mode=idle
mac_later=false
for arg in "$@"; do
  case "$arg" in
    --wait) mode=wait ;;
    --force) mode=force ;;
    --mac-later) mac_later=true ;;
    *) echo "Unknown option: $arg" >&2; exit 2 ;;
  esac
done

# Agents are the service's direct children other than its tunnel client and shells.
running_agents() {
  local main
  main="$(systemctl --user show -p MainPID --value "$SERVICE")"
  [ "$main" != 0 ] || { echo 0; return; }
  ps --ppid "$main" -o comm --no-headers | grep -vcE '^(cloudflared|bash|sh)$' || true
}

cd "$REPO"
before="$(git rev-parse --short HEAD)"
git fetch -q origin "$BRANCH"
git merge --ff-only -q FETCH_HEAD
after="$(git rev-parse --short HEAD)"
mkdir -p "$BACKUP_DIR"
# The commit the build on disk was made from, and the commit the running service was started on.
# A build that was left waiting for agents to finish is restarted by the next run, not skipped.
built="$(cat "$BUILT_MARK" 2>/dev/null || true)"
running="$(cat "$RUNNING_MARK" 2>/dev/null || true)"
if [ "$built" = "$after" ] && [ "$running" = "$after" ] && [ -d apps/server/dist ]; then
  echo "Already running $after. Nothing to do."
  exit 0
fi

# The system Node on a server is often older than the repository needs.
[ ! -d "$NODE_BIN_DIR" ] || PATH="$NODE_BIN_DIR:$PATH"
export PATH="$REPO/node_modules/.bin:$PATH"
if [ "$built" = "$after" ] && [ -d apps/server/dist ]; then
  echo "$after is already built; restarting onto it."
else
  echo "Updating $before -> $after"
  vp i >/dev/null
  [ ! -d apps/server/dist ] || cp -a apps/server/dist "$BACKUP_DIR/dist-$before-$(date -u +%Y%m%dT%H%M%SZ)"
  vp run --filter @t3tools/web build >/dev/null
  (cd apps/server && node scripts/cli.ts build >/dev/null)
  echo "$after" >"$BUILT_MARK"
  echo "Built $after"
fi

# The Mac app is new enough when it was built from this commit or a later one.
mac="$(cat "$MAC_MARK" 2>/dev/null || true)"
if [ -n "$mac" ] && git cat-file -e "$mac^{commit}" 2>/dev/null && git merge-base --is-ancestor HEAD "$mac"; then
  echo "The Mac app is on $(git rev-parse --short "$mac"), which includes $after."
elif $mac_later; then
  echo "The Mac app is on ${mac:-an unrecorded commit}, which does not include $after. Restarting anyway (--mac-later);" \
    "update the Mac with scripts/codewrench-mac-update.sh straight after." >&2
else
  echo "The Mac app is on ${mac:-an unrecorded commit}, which does not include $after. The new build is in place but NOT running yet." >&2
  echo "An older Mac app can keep losing its connection to a newer server. On the Mac, pull this branch and run" >&2
  echo "scripts/codewrench-mac-update.sh (it records its commit here), then rerun this. Or rerun with --mac-later." >&2
  exit 4
fi

agents="$(running_agents)"
if [ "$agents" != 0 ]; then
  case "$mode" in
    idle)
      echo "$agents agent(s) are running. The new build is in place but NOT running yet." >&2
      echo "Rerun with --wait to restart when they finish, or --force to restart now." >&2
      exit 3
      ;;
    wait)
      echo "Waiting for $agents agent(s) to finish..."
      until [ "$(running_agents)" = 0 ]; do sleep 15; done
      ;;
    force) echo "Restarting with $agents agent(s) running (--force)." ;;
  esac
fi

systemctl --user restart "$SERVICE"
for _ in $(seq 1 30); do
  if curl -fsS -o /dev/null --max-time 3 "http://127.0.0.1:$PORT/.well-known/t3/environment"; then
    echo "$after" >"$RUNNING_MARK"
    echo "Server is up on $after"
    exit 0
  fi
  sleep 2
done
echo "The service restarted but is not answering on port $PORT. Check: journalctl --user -u $SERVICE" >&2
exit 1
