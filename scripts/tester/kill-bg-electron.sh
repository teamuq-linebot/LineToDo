#!/usr/bin/env bash
# Kill any electron.exe spawned from line-todo node_modules (seed harness lingering).
powershell.exe -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='electron.exe'\" | Where-Object { \$_.CommandLine -like '*line-todo*seed-board*' } | ForEach-Object { Stop-Process -Id \$_.ProcessId -Force; Write-Output ('killed '+\$_.ProcessId) }"
