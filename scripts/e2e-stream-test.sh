#!/usr/bin/env bash
# e2e-stream-test.sh — end-to-end evidence for the live message stream.
#
# 1. Seed watch_json's checkpoint to a past ts so --follow's first poll replays
#    the most recent real LINE messages (proving live delivery, not just backlog).
# 2. Launch the built Electron app with LINE_TODO_DEBUG=1, capturing main stdout
#    (which now includes forwarded [renderer] console lines).
# 3. Let it run a few polls, then kill it. The log proves:
#       [smoke] window-created            -> window up
#       [watcher] spawn: ...              -> child started
#       [renderer] [stream] recv ...      -> renderer received pushed messages
set -u

REPO=/c/Users/david/line-todo
LINE_REPO=/c/Users/david/line-cua-win
STATE="$LINE_REPO/.watch_json_state"
LOG="$REPO/scripts/e2e-stream.log"

# checkpoint just before the newest ~10 messages (2025-11-18 ~15:46)
SEED_TS=1763451999400

# Seed checkpoint (sig=null so the stat-gate is forced to run the first poll)
printf '{"last_ts": %s, "sig": null}\n' "$SEED_TS" > "$STATE"
echo "[test] seeded checkpoint last_ts=$SEED_TS -> $STATE"

rm -f "$LOG"

# Launch the app. electron is the local devDependency; run the built output.
cd "$REPO" || exit 1
LINE_TODO_DEBUG=1 ELECTRON_DISABLE_SECURITY_WARNINGS=1 \
  ./node_modules/.bin/electron . > "$LOG" 2>&1 &
APP_PID=$!
echo "[test] launched electron pid=$APP_PID, log=$LOG"

# Wait for the window + a couple of follow polls (interval=15s -> give ~20s)
SECS=0
MAX=40
while [ $SECS -lt $MAX ]; do
  if grep -q "\[renderer\] \[stream\] recv" "$LOG" 2>/dev/null; then
    echo "[test] renderer received messages after ${SECS}s"
    break
  fi
  sleep 2
  SECS=$((SECS + 2))
done

# Give one more moment to flush
sleep 2

# Kill the app (taskkill to take down the whole electron tree on Windows)
taskkill //PID $APP_PID //T //F >/dev/null 2>&1
echo "[test] killed pid=$APP_PID after ${SECS}s"
echo "===== LOG (filtered evidence) ====="
grep -E "\[smoke\]|\[watcher\]|\[watch_json\.py\]|\[renderer\]|window-created" "$LOG" | head -60
echo "===== LOG (tail, raw) ====="
tail -20 "$LOG"
