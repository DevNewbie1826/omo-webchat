param([string]$Config)
# Child-process fixture boundary: downloads only; hashing, extraction, PATH,
# file locking and installer invocation remain real.
$ErrorActionPreference = 'Stop'
$c = Get-Content -LiteralPath $Config -Raw | ConvertFrom-Json
$windows = $env:OS -eq 'Windows_NT'
$originalUserPath = [Environment]::GetEnvironmentVariable('Path', 'User')
$lock = $null
function Assert($Condition, [string]$Message) {
    if (-not $Condition) { throw "ASSERT: $Message" }
}
function global:Invoke-WebRequest {
    param([string]$Uri, [string]$OutFile, [switch]$UseBasicParsing)
    $global:requests.Add($Uri)
    Copy-Item -LiteralPath (Join-Path $c.Release ($Uri -split '/')[-1]) -Destination $OutFile -Force -ErrorAction Stop
}
function global:Invoke-RestMethod {
    param([string]$Uri, [switch]$UseBasicParsing)
    $global:requests.Add($Uri)
    if ($Uri -eq 'https://fixture.invalid/install.ps1') { return Get-Content -LiteralPath $c.Installer -Raw }
    Assert ($Uri -eq 'https://api.github.com/repos/DevNewbie1826/omo-webchat/releases/latest') 'unexpected API URI'
    if ($c.Kind -eq 'latest-error') { throw 'fixture API rejection' }
    return [pscustomobject]@{ tag_name = 'v-latest' }
}
$global:requests = New-Object 'System.Collections.Generic.List[string]'
try {
    Set-Location -LiteralPath $c.Root
    $env:VERSION = 'v-env'
    $env:INSTALL_DIR = Join-Path $c.Root 'env install'
    $env:LOCALAPPDATA = Join-Path $c.Root 'local appdata'
    # Windows supplies these at the runtime boundary, including WOW64's native
    # architecture. Do not replace Get-TargetArch or add public test switches.
    $env:PROCESSOR_ARCHITECTURE = $c.Arch
    $env:PROCESSOR_ARCHITEW6432 = $c.NativeArch
    $env:PATH = 'C:\Keep With Spaces;C:\Unrelated;'
    $seedPath = 'C:\User Keep;C:\Another;'
    if ($c.Kind -eq 'dedupe') {
        $equivalent = $c.Target.ToUpperInvariant() + '\'
        $env:PATH = "$equivalent;$env:PATH"
        $seedPath += "$equivalent;"
    }
    if ($windows) { [Environment]::SetEnvironmentVariable('Path', $seedPath, 'User') }
    $beforePath = $env:PATH
    $beforeUser = [Environment]::GetEnvironmentVariable('Path', 'User')
    $target = Join-Path $c.Target 'omo-webchat.exe'
    if ($c.Existing) {
        New-Item -ItemType Directory -Path $c.Target -Force | Out-Null
        [IO.File]::WriteAllText($target, 'old-install-sentinel')
        $oldDigest = (Get-FileHash -LiteralPath $target).Hash
    }
    if ($c.Kind -eq 'locked') {
        Assert $windows 'held-lock acceptance requires Windows'
        $lock = [IO.File]::Open($target, 'Open', 'Read', 'Read')
    }
    $arguments = @{ Version = 'v-explicit'; InstallDir = $c.InstallDir; NoPathUpdate = $c.NoPath }
    if ($c.Selection -eq 'mirror') { $arguments.BaseUrl = 'https://fixture.invalid/mirror/' }
    if ($c.Selection -eq 'env') { $arguments.Remove('Version'); $arguments.Remove('InstallDir') }
    if ($c.Selection -eq 'latest') {
        $env:VERSION = ''
        $env:INSTALL_DIR = ''
        $arguments.Remove('Version'); $arguments.Remove('InstallDir')
    }
    if ($c.Mode -eq 'iex') { $env:INSTALL_DIR = $c.Target }
    Set-StrictMode -Off
    $ErrorActionPreference = 'Continue'
    $ProgressPreference = 'Continue'
    $caught = $false
    try {
        if ($c.Mode -eq 'iex') {
            irm https://fixture.invalid/install.ps1 | iex
        } elseif ($c.Mode -eq 'scriptblock') {
            & ([scriptblock]::Create((irm https://fixture.invalid/install.ps1))) @arguments
        } else {
            & $c.Installer @arguments
        }
    } catch {
        $caught = $true
        Write-Host "CAUGHT: $($_.Exception.Message)"
    }
    # Capture state before re-enabling strict assertions; never guess defaults.
    $afterError = $ErrorActionPreference
    $afterProgress = $ProgressPreference
    $strictLeaked = $false
    try { $null = $undefinedInstallerContractVariable } catch { $strictLeaked = $true }
    $ErrorActionPreference = 'Stop'
    Set-StrictMode -Version Latest
    Assert ($afterError -eq 'Continue') 'caller ErrorActionPreference leaked'
    Assert ($afterProgress -eq 'Continue') 'caller ProgressPreference leaked'
    Assert (-not $strictLeaked) 'caller strict mode leaked'
    Assert ($caught -eq $c.Failure) 'catchable failure/success and caller continuation'
    if ($lock) { $lock.Dispose(); $lock = $null }
    if ($c.Failure) {
        if ($c.Existing) {
            Assert ((Get-FileHash -LiteralPath $target).Hash -eq $oldDigest) 'old executable digest changed'
        } else { Assert (-not (Test-Path -LiteralPath $target)) 'rejected payload installed' }
    } else {
        Assert (Test-Path -LiteralPath $target -PathType Leaf) 'regular executable missing'
        Assert ((Get-FileHash -LiteralPath $target).Hash -eq $c.Digest) 'installed executable bytes differ'
        if ($c.Kind -eq 'real-server') {
            & $target --help
            Assert ($LASTEXITCODE -eq 0) 'installed real server --help exit'
            Write-Host 'REAL_SERVER_HELP_EXIT=0'
        }
    }
    $afterUser = [Environment]::GetEnvironmentVariable('Path', 'User')
    if ($c.NoPath -or $c.Failure -or $c.Kind -eq 'dedupe') {
        Assert ($env:PATH -ceq $beforePath) 'process PATH changed'
        Assert ($afterUser -ceq $beforeUser) 'User PATH changed'
    } else {
        Assert ($env:PATH -ceq "$($c.Target);$beforePath") 'absolute process PATH/preserved unrelated entries'
        if ($windows) {
            Assert ($afterUser -ceq ($beforeUser.TrimEnd(';') + ';' + $c.Target)) 'absolute User PATH/preserved unrelated entries'
        }
        Set-Location -LiteralPath $c.Release
        $savedEntry = ($env:PATH -split ';')[0]
        Assert ((Get-FileHash -LiteralPath (Join-Path $savedEntry 'omo-webchat.exe')).Hash -eq $c.Digest) 'saved path changes meaning after chdir'
    }
    if (-not $c.Failure) {
        $base = if ($c.Selection -eq 'mirror') { 'https://fixture.invalid/mirror' }
            elseif ($c.Selection -eq 'latest') { 'https://github.com/DevNewbie1826/omo-webchat/releases/download/v-latest' }
            elseif ($c.Selection -eq 'env' -or $c.Mode -eq 'iex') { 'https://github.com/DevNewbie1826/omo-webchat/releases/download/v-env' }
            else { 'https://github.com/DevNewbie1826/omo-webchat/releases/download/v-explicit' }
        Assert ($requests.Contains("$base/omo-webchat_windows_$($c.ExpectedArch).zip")) 'selected asset/tag/base differs'
        Assert ($requests.Contains("$base/checksums.txt")) 'checksum URI differs'
        $latest = 'https://api.github.com/repos/DevNewbie1826/omo-webchat/releases/latest'
        Assert ($requests.Contains($latest) -eq ($c.Selection -eq 'latest')) 'latest/env/explicit precedence'
    }
    Assert (@(Get-ChildItem -LiteralPath $c.Scratch -Filter 'omo-webchat-install-*').Count -eq 0) 'installer scratch remains'
    Write-Host "PASS_CASE=$($c.Name) CONTINUED=true PATH=true BYTES=true CLEANUP=true REQUESTS=$($requests -join ',')"
} finally {
    if ($lock) { $lock.Dispose() }
    if ($windows) { [Environment]::SetEnvironmentVariable('Path', $originalUserPath, 'User') }
}
