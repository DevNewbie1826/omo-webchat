# Exercise install.ps1 against local release fixtures.
#
# The installer is run in a child PowerShell process whose Invoke-WebRequest is
# shadowed by a fixture-serving function, so no network is touched and the
# child's exit code is observable when the installer fails closed.
#
#   pwsh -NoProfile -File test/install_ps1_test.ps1

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repoDir = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$installer = Join-Path $repoDir 'install.ps1'
$hostArch = if ([System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture -eq 'Arm64') { 'arm64' } else { 'amd64' }
$asset = "omo-webchat_windows_${hostArch}.zip"
$exeName = 'omo-webchat.exe'
$validContents = 'verified fixture'
$tamperedContents = 'tampered fixture'
$shell = if ($PSVersionTable.PSEdition -eq 'Core') { 'pwsh' } else { 'powershell' }

$work = Join-Path ([System.IO.Path]::GetTempPath()) ("omo-webchat-install-ps1-" + [System.Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $work -Force | Out-Null

function Fail {
    param([string]$Message)
    Write-Host "FAIL: $Message" -ForegroundColor Red
    exit 1
}

function New-ArchiveFixture {
    param([string]$Name, [string]$Contents)
    $stage = Join-Path $work "stage-$Name"
    New-Item -ItemType Directory -Path $stage -Force | Out-Null
    Set-Content -LiteralPath (Join-Path $stage $exeName) -Value $Contents -NoNewline
    $archive = Join-Path $work "$Name.zip"
    Compress-Archive -Path (Join-Path $stage '*') -DestinationPath $archive -Force
    return $archive
}

$harness = Join-Path $work 'harness.ps1'
@'
param([string]$Installer, [string]$InstallDir)
function global:Invoke-WebRequest {
    param([string]$Uri, [string]$OutFile, [switch]$UseBasicParsing)
    $name = ($Uri -split '/')[-1]
    $source = Join-Path $env:FIXTURE_RELEASE_DIR $name
    if (-not (Test-Path -LiteralPath $source)) { throw "fixture 404: $name" }
    Copy-Item -LiteralPath $source -Destination $OutFile -Force
}
$global:LASTEXITCODE = 0
& $Installer -Version v9.9.9-test -BaseUrl 'https://fixture.invalid/download' -InstallDir $InstallDir -NoPathUpdate
exit $LASTEXITCODE
'@ | Set-Content -LiteralPath $harness

# Runs one installer case and returns its exit code plus combined output.
function Invoke-Installer {
    param([string]$CaseName, [string]$Archive, [string]$ChecksumAsset, [string]$DigestArchive, [switch]$OmitArchive)
    if (-not $DigestArchive) { $DigestArchive = $Archive }
    $caseDir = Join-Path $work $CaseName
    $releaseDir = Join-Path $caseDir 'release'
    $installDir = Join-Path $caseDir 'install'
    New-Item -ItemType Directory -Path $releaseDir -Force | Out-Null

    if (-not $OmitArchive) {
        Copy-Item -LiteralPath $Archive -Destination (Join-Path $releaseDir $asset) -Force
    }
    $digest = (Get-FileHash -LiteralPath $DigestArchive -Algorithm SHA256).Hash
    Set-Content -LiteralPath (Join-Path $releaseDir 'checksums.txt') -Value "$digest  $ChecksumAsset"

    $env:FIXTURE_RELEASE_DIR = $releaseDir
    $output = & $shell -NoProfile -File $harness -Installer $installer -InstallDir $installDir 2>&1 | Out-String
    $code = $LASTEXITCODE
    Remove-Item Env:FIXTURE_RELEASE_DIR

    return [pscustomobject]@{
        Case       = $CaseName
        Code       = $code
        Output     = $output
        InstallDir = $installDir
        Installed  = Join-Path $installDir $exeName
    }
}

$validArchive = New-ArchiveFixture -Name 'valid' -Contents $validContents
$tamperedArchive = New-ArchiveFixture -Name 'tampered' -Contents $tamperedContents

try {
    $ok = Invoke-Installer -CaseName 'verified-install' -Archive $validArchive -ChecksumAsset $asset
    if ($ok.Code -ne 0) { Fail "$($ok.Case): installer failed unexpectedly:`n$($ok.Output)" }
    if (-not (Test-Path -LiteralPath $ok.Installed)) { Fail "$($ok.Case): installer did not install $exeName" }
    if ((Get-Content -LiteralPath $ok.Installed -Raw) -ne $validContents) { Fail "$($ok.Case): installed binary contents differ" }

    # checksums.txt carries the valid archive's digest; the served archive is the tampered one.
    $mismatch = Invoke-Installer -CaseName 'checksum-mismatch' -Archive $tamperedArchive -DigestArchive $validArchive -ChecksumAsset $asset
    if ($mismatch.Code -eq 0) { Fail 'checksum-mismatch: installer accepted a tampered archive' }
    if ($mismatch.Output -notmatch 'checksum mismatch') { Fail "checksum-mismatch: missing rejection error:`n$($mismatch.Output)" }
    if (Test-Path -LiteralPath $mismatch.Installed) { Fail 'checksum-mismatch: tampered binary was installed' }

    $unlisted = Invoke-Installer -CaseName 'checksum-unlisted' -Archive $validArchive -ChecksumAsset 'omo-webchat_linux_amd64.tar.gz'
    if ($unlisted.Code -eq 0) { Fail 'checksum-unlisted: installer accepted an archive with no checksum entry' }
    if ($unlisted.Output -notmatch 'not found in checksums\.txt') { Fail "checksum-unlisted: missing rejection error:`n$($unlisted.Output)" }
    if (Test-Path -LiteralPath $unlisted.Installed) { Fail 'checksum-unlisted: binary was installed after rejection' }

    $missing = Invoke-Installer -CaseName 'download-failure' -Archive $validArchive -ChecksumAsset $asset -OmitArchive
    if ($missing.Code -eq 0) { Fail 'download-failure: installer succeeded without the release asset' }
    if ($missing.Output -notmatch 'download failed') { Fail "download-failure: missing download error:`n$($missing.Output)" }
    if (Test-Path -LiteralPath $missing.Installed) { Fail 'download-failure: binary was installed after a failed download' }
}
finally {
    Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host 'PASS: verified Windows install succeeds into the requested directory; tampered, unlisted, and undownloadable archives fail closed without installing anything.'
