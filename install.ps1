#Requires -Version 5.1
<#
.SYNOPSIS
  Install script for omo-webchat on Windows.

.DESCRIPTION
  Downloads the released Windows archive, verifies its SHA-256 against the
  release checksums.txt, installs omo-webchat.exe, and puts the install
  directory on the user PATH. Mirrors install.sh for POSIX.

.PARAMETER Version
  Install a specific release tag (e.g. v0.1.0). Defaults to $env:VERSION, then
  to the latest release.

.PARAMETER InstallDir
  Install location. Defaults to $env:INSTALL_DIR, then to
  %LOCALAPPDATA%\Programs\omo-webchat.

.PARAMETER BaseUrl
  Download base for the release assets. Defaults to the GitHub release URL for
  the resolved tag; override it to install from a mirror.

.PARAMETER NoPathUpdate
  Skip modifying the user PATH.

.EXAMPLE
  irm https://raw.githubusercontent.com/DevNewbie1826/omo-webchat/main/install.ps1 | iex

.EXAMPLE
  & ([scriptblock]::Create((irm https://raw.githubusercontent.com/DevNewbie1826/omo-webchat/main/install.ps1))) -Version v0.1.0
#>
[CmdletBinding()]
param(
    [string]$Version = $env:VERSION,
    [string]$InstallDir = $env:INSTALL_DIR,
    [string]$BaseUrl,
    [switch]$NoPathUpdate
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$Repo = 'DevNewbie1826/omo-webchat'
$Binary = 'omo-webchat'
$ExeName = "$Binary.exe"

function Write-Info { param([string]$Message) Write-Host "==> $Message" -ForegroundColor Blue }
function Write-Warn { param([string]$Message) Write-Host "warning: $Message" -ForegroundColor Yellow }
function Stop-WithError { param([string]$Message) Write-Host "error: $Message" -ForegroundColor Red; exit 1 }

function Get-TargetArch {
    $arch = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString().ToLowerInvariant()
    switch ($arch) {
        'x64' { return 'amd64' }
        'arm64' { return 'arm64' }
        default { Stop-WithError "unsupported architecture: $arch (supported: x64, arm64)" }
    }
}

function Get-LatestTag {
    try {
        $release = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/releases/latest" -UseBasicParsing
    }
    catch {
        Stop-WithError "could not query the latest release ($($_.Exception.Message)). Pass -Version vX.Y.Z explicitly."
    }
    return $release.tag_name
}

if ([string]::IsNullOrWhiteSpace($InstallDir)) {
    $InstallDir = Join-Path $env:LOCALAPPDATA 'Programs\omo-webchat'
}

$arch = Get-TargetArch
$tag = if ([string]::IsNullOrWhiteSpace($Version)) { Get-LatestTag } else { $Version }
if ([string]::IsNullOrWhiteSpace($tag)) {
    Stop-WithError 'could not determine the latest release. Pass -Version vX.Y.Z explicitly.'
}
if ([string]::IsNullOrWhiteSpace($BaseUrl)) {
    $BaseUrl = "https://github.com/$Repo/releases/download/$tag"
}
$BaseUrl = $BaseUrl.TrimEnd('/')

Write-Info "installing $Binary $tag (windows/$arch)"

$asset = "${Binary}_windows_${arch}.zip"
$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("omo-webchat-install-" + [System.Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $tmp -Force | Out-Null

try {
    $archivePath = Join-Path $tmp $asset
    $checksumPath = Join-Path $tmp 'checksums.txt'

    foreach ($download in @(@{ Name = $asset; Path = $archivePath }, @{ Name = 'checksums.txt'; Path = $checksumPath })) {
        $url = "$BaseUrl/$($download.Name)"
        try {
            Invoke-WebRequest -Uri $url -OutFile $download.Path -UseBasicParsing
        }
        catch {
            Stop-WithError "download failed: $url ($($_.Exception.Message))"
        }
    }

    $expected = $null
    foreach ($line in Get-Content -LiteralPath $checksumPath) {
        $fields = $line -split '\s+', 2
        if ($fields.Count -eq 2 -and $fields[1].Trim() -eq $asset) {
            $expected = $fields[0].Trim()
            break
        }
    }
    if ([string]::IsNullOrWhiteSpace($expected)) {
        Stop-WithError "checksum for $asset not found in checksums.txt"
    }

    $actual = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash
    if ($actual -ne $expected.ToUpperInvariant()) {
        Stop-WithError "checksum mismatch for ${asset}: expected $expected, got $actual"
    }

    $extractDir = Join-Path $tmp 'extract'
    New-Item -ItemType Directory -Path $extractDir -Force | Out-Null
    try {
        Expand-Archive -LiteralPath $archivePath -DestinationPath $extractDir -Force
    }
    catch {
        Stop-WithError "could not extract ${asset}: $($_.Exception.Message)"
    }

    $extracted = Get-ChildItem -LiteralPath $extractDir -Recurse -Filter $ExeName | Select-Object -First 1
    if (-not $extracted) {
        Stop-WithError "archive did not contain $ExeName"
    }

    try {
        New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
    }
    catch {
        Stop-WithError "cannot create ${InstallDir}: $($_.Exception.Message)"
    }

    $target = Join-Path $InstallDir $ExeName
    try {
        Copy-Item -LiteralPath $extracted.FullName -Destination $target -Force
    }
    catch {
        Stop-WithError "cannot write ${target}: $($_.Exception.Message). Stop a running omo-webchat, or pass -InstallDir <dir>."
    }
    Write-Info "installed $target"
}
finally {
    Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
}

$processPath = ($env:PATH -split ';') | Where-Object { $_ -and ($_.TrimEnd('\') -ieq $InstallDir.TrimEnd('\')) }
if (-not $processPath) {
    $env:PATH = "$InstallDir;$env:PATH"
}

if ($NoPathUpdate) {
    Write-Warn "-NoPathUpdate given; add $InstallDir to your PATH yourself."
}
else {
    $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    $onUserPath = ($userPath -split ';') | Where-Object { $_ -and ($_.TrimEnd('\') -ieq $InstallDir.TrimEnd('\')) }
    if (-not $onUserPath) {
        $updated = if ([string]::IsNullOrWhiteSpace($userPath)) { $InstallDir } else { $userPath.TrimEnd(';') + ';' + $InstallDir }
        [Environment]::SetEnvironmentVariable('Path', $updated, 'User')
        Write-Info "added $InstallDir to your user PATH (open a new terminal to pick it up)"
    }
}

if (-not (Get-Command omo -ErrorAction SilentlyContinue)) {
    Write-Warn "'omo' is required at runtime to create chats but was not found on your PATH."
    Write-Warn 'install it with:  npm install -g omo-ai@beta'
}

Write-Host ''
Write-Host 'Done. Run it with:'
Write-Host ''
Write-Host "  $Binary --password <secret>"
Write-Host ''
Write-Host 'then open http://localhost:8080 in your browser.'
