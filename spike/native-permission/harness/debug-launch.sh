#!/bin/sh
# Launch debug-perm.mjs under Electron 44 with the exact flags the harness produced.
E44="/c/teamuq/teamuq-electron/node_modules/electron/dist/electron.exe"
ROOTF="C:/teamuq/line-todo/.teamuq/worktrees/fulltrust-plugin-20261001/spike/native-permission"
ROOTB='C:\teamuq\line-todo\.teamuq\worktrees\fulltrust-plugin-20261001\spike\native-permission'
DATA="C:/Users/david/AppData/Local/Temp/xx/data"
export ELECTRON_RUN_AS_NODE=1
"$E44" --permission \
  "--allow-fs-read=$ROOTF/harness/child-experiment.mjs" \
  "--allow-fs-read=$ROOTF" \
  "--allow-fs-read=$DATA" \
  "--allow-fs-write=$DATA" \
  "$ROOTF/harness/debug-perm.mjs" "$ROOTB" "$DATA" 2>/dev/null
