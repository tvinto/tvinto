#!/bin/bash
# tools/emulator/tvbuild.sh -- web build, cap sync, APK build (through WMI, as
# tools/build-apk.cmd must run outside the sandbox), install on the running
# TV emulator, relaunch, and forward its WebView to port 9333 for tv.js.
#
# Pin versionName in android/app/build.gradle to 9.0.0 first, or the device
# goes on running the web bundle it downloaded (CLAUDE.md), and put it back
# before building anything to publish. It was 1.0.99 until the published web
# bundle itself reached 1.0.99 (13 October); a pin has to be above it.
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT/frontend" || exit 1
npm run build 2>&1 | grep -iE " error|✘|Output location" || exit 1
npx cap sync android 2>&1 | tail -1
rm -f ../tools/build-apk.log
WIN_ROOT="$(cygpath -w "$ROOT")"
# Hidden: a plain Win32_Process Create opens a console on a user's screen
# (31 October). tools/run-hidden.ps1 starts it with no window.
PS=/c/WINDOWS/System32/WindowsPowerShell/v1.0/powershell.exe
"$PS" -NoProfile -ExecutionPolicy Bypass -File "$WIN_ROOT\\tools\\run-hidden.ps1" -CommandLine "cmd /c $WIN_ROOT\\tools\\build-apk.cmd" >/dev/null
until grep -q "EXIT=" ../tools/build-apk.log 2>/dev/null; do sleep 4; done
grep -E "error:|BUILD|EXIT" ../tools/build-apk.log
adb install -r android/app/build/outputs/apk/debug/app-debug.apk | tail -1
# The user in front: a temporary one for a walk on the fake provider, while
# user 0 holds a user's account. An install wakes the app in every user,
# so user 0's is stopped again at once unless it is the one being tested.
U=$(adb shell am get-current-user | tr -d '\r')
[ "$U" != 0 ] && adb shell am force-stop --user 0 app.tvinto
adb shell am force-stop --user "$U" app.tvinto
# Through a link that leads nowhere, which skips startup autoplay: nothing plays on its own.
adb shell am start --user "$U" -a android.intent.action.VIEW -d "tvinto://nothing" -n app.tvinto/.MainActivity >/dev/null
sleep 18
PID=$(adb shell ps -A | grep "^u${U}_" | grep 'app.tvinto$' | awk '{print $2}' | head -1)
adb forward --remove-all
adb forward tcp:9333 localabstract:webview_devtools_remote_$PID >/dev/null
echo "attached to $PID (user $U)"
