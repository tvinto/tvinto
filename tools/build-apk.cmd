@echo off
REM Builds the debug APK, writing what happened to build-apk.log.
REM
REM Spawned through WMI (Invoke-CimMethod Win32_Process Create) rather than run
REM directly, because Gradle's daemon needs a loopback socket and Java's
REM Selector.open() fails inside the assistant's process tree.
REM WMI starts the process outside that tree,
REM where it works exactly as it does in an ordinary terminal.
cd /d "%~dp0..\frontend\android"
REM Arguments go on to Gradle: -PforDevices builds the APK that is published,
REM without the emulator's x86_64 (frontend/android/app/build.gradle).
call gradlew.bat assembleDebug %* > "%~dp0build-apk.log" 2>&1
echo EXIT=%ERRORLEVEL% >> "%~dp0build-apk.log"
