# Starts a command outside the assistant's process tree, with no window.
#
# The builds, the emulator and the test servers are started through WMI
# (Win32_Process Create) because Gradle's daemon and a local D1 do not run
# inside the assistant's sandbox -- see CLAUDE.md. A plain Create opens a
# console window on a user's desktop, in front of whatever they are doing
# (a game, 31 October). ShowWindow 0 starts it hidden.
#
#   powershell -File tools/run-hidden.ps1 -CommandLine 'cmd /c tools\build-apk.cmd'
#
# Prints the new process's id. Its output goes wherever the command line sends
# it; nothing is shown.
param(
    [Parameter(Mandatory = $true)][string]$CommandLine,
    [string]$Directory = ''
)

# Not as the parameter's default: Windows PowerShell 5.1 leaves $PSScriptRoot
# empty there when the script is run with -File.
if (-not $Directory) {
    $Directory = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
}

$startup = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ ShowWindow = [uint16]0 }
$result = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
    CommandLine               = $CommandLine
    CurrentDirectory          = $Directory
    ProcessStartupInformation = $startup
}
if ($result.ReturnValue -ne 0) {
    Write-Error "Win32_Process Create returned $($result.ReturnValue)"
    exit 1
}
$result.ProcessId
