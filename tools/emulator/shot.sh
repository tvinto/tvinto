#!/bin/bash
# tools/emulator/shot.sh NAME [DIR] -- screenshot the TV emulator to DIR/NAME.png
# (DIR defaults to the current directory). Pulled as a file rather than piped:
# a PowerShell `>` would re-encode the PNG (CLAUDE.md).
export MSYS_NO_PATHCONV=1
DIR=${2:-.}
# adb is a Windows program: hand it a Windows path, since the conversion Git
# Bash would do is switched off above for the device-side path.
OUT="$(cygpath -w "$DIR")\\$1.png"
adb shell screencap -p /sdcard/shot.png
adb pull /sdcard/shot.png "$OUT" >/dev/null && echo "shot $OUT"
