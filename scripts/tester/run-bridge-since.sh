#!/usr/bin/env bash
# Tester harness: run watch_json.py with --since (does NOT mutate the App checkpoint),
# pull messages from the last ~3 days, cap small, print first lines + counts.
set -uo pipefail
PY="C:/Users/david/line-cua-win/.venv/Scripts/python.exe"
SCRIPT="C:/Users/david/line-cua-win/src/watch_json.py"
SRCDIR="C:/Users/david/line-cua-win/src"
# 3 days ago in epoch-ms
SINCE_MS=$(( ($(date +%s) - 3*24*3600) * 1000 ))
echo "[bridge-test] SINCE_MS=$SINCE_MS"
OUT="/c/Users/david/line-todo/scripts/tester/bridge_out.ndjson"
cd "$SRCDIR" || exit 9
PYTHONUTF8=1 PYTHONIOENCODING=utf-8 "$PY" "$SCRIPT" --since "$SINCE_MS" --limit 50 >"$OUT" 2>/c/Users/david/line-todo/scripts/tester/bridge_err.log
RC=$?
echo "[bridge-test] exit_code=$RC"
echo "[bridge-test] stdout_lines=$(wc -l < "$OUT")"
echo "[bridge-test] stderr:"; cat /c/Users/david/line-todo/scripts/tester/bridge_err.log
echo "[bridge-test] first 3 stdout lines:"; head -3 "$OUT"
exit $RC
