# Tab Layout Memory - installer for the Windows helper.
# Builds the helper with the C# compiler built into Windows and registers it
# with Chrome, Edge, Brave and Chromium for the current user (no admin needed).

$ErrorActionPreference = 'Stop'
$HostName    = 'com.tablayoutmemory.host'
$ExtensionId = 'nfoakjoifinjnlmanogdmmaobcjneilh'

$root     = $PSScriptRoot
$hostDir  = Join-Path $root 'host'
$source   = Join-Path $hostDir 'TabLayoutHost.cs'
$exe      = Join-Path $hostDir 'TabLayoutHost.exe'
$manifest = Join-Path $hostDir "$HostName.json"

Write-Host 'Tab Layout Memory setup' -ForegroundColor Cyan

# 1. Find the built-in C# compiler (.NET Framework 4.x ships with Windows 10/11).
$csc = @(
    "$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319\csc.exe",
    "$env:WINDIR\Microsoft.NET\Framework\v4.0.30319\csc.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $csc) { throw 'Could not find the .NET Framework C# compiler (csc.exe). Enable ".NET Framework 4.8" in Windows Features and try again.' }

# 2. Build the helper.
Write-Host 'Building helper...'
& $csc /nologo /optimize+ /target:exe /platform:anycpu "/out:$exe" "$source"
if ($LASTEXITCODE -ne 0 -or -not (Test-Path $exe)) { throw 'Building the helper failed (see messages above).' }

# 3. Write the native messaging manifest (UTF-8 without BOM).
$json = [ordered]@{
    name            = $HostName
    description     = 'Tab Layout Memory helper: reads and switches the Windows keyboard layout'
    path            = $exe
    type            = 'stdio'
    allowed_origins = @("chrome-extension://$ExtensionId/")
} | ConvertTo-Json
[System.IO.File]::WriteAllText($manifest, $json, (New-Object System.Text.UTF8Encoding($false)))

# 4. Register it for each Chromium-based browser (harmless if a browser isn't installed).
$browsers = [ordered]@{
    'Google Chrome' = 'HKCU:\Software\Google\Chrome\NativeMessagingHosts'
    'Microsoft Edge' = 'HKCU:\Software\Microsoft\Edge\NativeMessagingHosts'
    'Brave'          = 'HKCU:\Software\BraveSoftware\Brave-Browser\NativeMessagingHosts'
    'Chromium'       = 'HKCU:\Software\Chromium\NativeMessagingHosts'
}
foreach ($b in $browsers.GetEnumerator()) {
    New-Item -Path "$($b.Value)\$HostName" -Value $manifest -Force | Out-Null
    Write-Host "  registered for $($b.Key)"
}

Write-Host ''
Write-Host 'Done. Next:' -ForegroundColor Green
Write-Host "  1. Open chrome://extensions (or edge://extensions), turn on Developer mode."
Write-Host "  2. Click 'Load unpacked' and pick this folder:  $(Join-Path $root 'extension')"
Write-Host "  3. The extension ID shown should be:  $ExtensionId"
Write-Host "Keep this folder where it is - the browser runs the helper from here."
