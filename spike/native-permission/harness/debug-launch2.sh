#!/bin/sh
# Same as debug-launch.sh but the executed bootstrap file lives OUTSIDE installDir
# (a separate host dir), mirroring the real Core host bootstrap. Expect install_* = true.
E44="/c/teamuq/teamuq-electron/node_modules/electron/dist/electron.exe"
ROOTF="C:/teamuq/line-todo/.teamuq/worktrees/fulltrust-plugin-20261001/spike/native-permission"
ROOTB='C:\teamuq\line-todo\.teamuq\worktrees\fulltrust-plugin-20261001\spike\native-permission'
HOST="C:/Users/david/AppData/Local/Temp/xxhost"
DATA="C:/Users/david/AppData/Local/Temp/xx/data"
mkdir -p "$HOST"
printf 'console.log("boot")\n' > "$HOST/host-bootstrap.mjs"
export ELECTRON_RUN_AS_NODE=1
"$E44" --permission \
  "--allow-fs-read=$HOST/host-bootstrap.mjs" \
  "--allow-fs-read=$ROOTF" \
  "--allow-fs-read=$DATA" \
  "--allow-fs-write=$DATA" \
  "$ROOTF/harness/debug-perm.mjs" "$ROOTB" "$DATA" 2>/dev/null
rm -rf "$HOST"
