#!/usr/bin/env bash
set -uo pipefail
cd /c/Users/david/line-todo || exit 9
SEEDDIR="/c/Users/david/AppData/Local/Temp/line-todo-ui-test"
./node_modules/.bin/electron scripts/tester/seed-then-quit.cjs "$SEEDDIR" 2>/dev/null >/dev/null
echo "--- shot-board settings tab, scroll bottom ---"
./node_modules/.bin/electron scripts/shot-board.cjs "$SEEDDIR" "$SEEDDIR/settings.png" settings bottom 2>/dev/null | grep "\[shot\]"
