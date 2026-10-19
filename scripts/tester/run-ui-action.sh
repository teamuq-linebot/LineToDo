#!/usr/bin/env bash
set -uo pipefail
cd /c/Users/david/line-todo || exit 9
SEEDDIR="/c/Users/david/AppData/Local/Temp/line-todo-ui-test"
rm -rf "$SEEDDIR"
./node_modules/.bin/electron scripts/tester/seed-then-quit.cjs "$SEEDDIR" 2>/dev/null | grep "\[seed\] byStatus"
echo "--- shot-board: argv = <dir> <png> board <arg5=x> action ---"
# shot-board argv: [2]=dir [3]=png [4]=tab [5]=(bottom?) [6]=(action?)
./node_modules/.bin/electron scripts/shot-board.cjs "$SEEDDIR" "$SEEDDIR/board.png" board x action 2>/dev/null | grep "\[shot\]"
