# Local release fixtures; run with BOTH Windows PowerShell 5.1 and PowerShell 7.
param([string]$ServerExecutable, [string]$CaseName, [string]$Installer)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$repoDir = Split-Path -Parent $PSScriptRoot
if (-not $Installer) { $Installer = Join-Path $repoDir 'install.ps1' }
$windows = $env:OS -eq 'Windows_NT'
$shell = (Get-Process -Id $PID).Path
Write-Host "ENGINE=$shell VERSION=$($PSVersionTable.PSVersion) OS=$([Environment]::OSVersion) PROCESS_ARCH=$env:PROCESSOR_ARCHITECTURE NATIVE_ARCH=$env:PROCESSOR_ARCHITEW6432"
$runtimeType = 'System.Runtime.InteropServices.RuntimeInformation' -as [type]
Write-Host "RUNTIME_INFORMATION_AVAILABLE=$($null -ne $runtimeType)"
$work = Join-Path ([IO.Path]::GetTempPath()) ('omo-installer-suite-' + [guid]::NewGuid().ToString('N'))
$oldTemp = @{}
foreach ($key in @('TEMP', 'TMP', 'TMPDIR')) { $oldTemp[$key] = [Environment]::GetEnvironmentVariable($key) }
$originalUserPath = [Environment]::GetEnvironmentVariable('Path', 'User')
New-Item -ItemType Directory -Path $work | Out-Null
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$failures = New-Object 'System.Collections.Generic.List[string]'
try {
    if ($windows -and -not $ServerExecutable -and -not $CaseName) {
        $ServerExecutable = Join-Path $work 'release-server.exe'
        Push-Location $repoDir
        $oldCGO = $env:CGO_ENABLED
        try {
            $env:CGO_ENABLED = '0'
            & go build -trimpath -ldflags '-s -w' -o $ServerExecutable ./cmd/server
            if ($LASTEXITCODE -ne 0) { throw 'release server build failed (build frontend first)' }
        } finally { $env:CGO_ENABLED = $oldCGO; Pop-Location }
    }
    $cases = @(
        @{ Name='fresh-optout'; Mode='scriptblock'; NoPath=$true },
        @{ Name='upgrade'; Existing=$true },
        @{ Name='path-update' },
        @{ Name='relative-dir'; Relative=$true },
        @{ Name='dedupe'; Kind='dedupe' },
        @{ Name='iex-success'; Mode='iex'; Selection='env' },
        @{ Name='iex-mismatch'; Mode='iex'; Kind='mismatch'; Existing=$true; Failure=$true; Selection='env' },
        @{ Name='iex-download'; Mode='iex'; Kind='missing-archive'; Existing=$true; Failure=$true; Selection='env' },
        @{ Name='environment'; Selection='env'; NoPath=$true },
        @{ Name='latest-default-dir'; Selection='latest'; NoPath=$true },
        @{ Name='latest-error'; Selection='latest'; Kind='latest-error'; Failure=$true },
        @{ Name='explicit-over-env'; NoPath=$true },
        @{ Name='mirror'; Selection='mirror'; NoPath=$true },
        @{ Name='arch-x64'; Arch='AMD64'; NoPath=$true },
        @{ Name='arch-arm64'; Arch='ARM64'; ExpectedArch='arm64'; NoPath=$true },
        @{ Name='arch-emulated-arm64'; Arch='AMD64'; NativeArch='ARM64'; ExpectedArch='arm64'; NoPath=$true },
        @{ Name='arch-wow64-x64'; Arch='x86'; NativeArch='AMD64'; NoPath=$true },
        @{ Name='arch-unsupported'; Arch='x86'; Failure=$true },
        @{ Name='arch-native-unsupported'; NativeArch='IA64'; Failure=$true },
        @{ Name='directory-fresh'; Kind='directory'; Failure=$true }
    )
    foreach ($kind in @('mismatch','malformed','unlisted','missing-checksums','missing-archive','invalid-zip','missing-exe','directory')) {
        $cases += @{ Name="$kind-existing"; Kind=$kind; Existing=$true; Failure=$true }
    }
    if ($windows) { $cases += @{ Name='held-lock'; Kind='locked'; Existing=$true; Failure=$true } }
    if ($windows) {
        $cases += @{ Name='reinstall-equivalent-path'; Kind='reinstall' }
        $cases += @{ Name='native-engine'; Arch=$env:PROCESSOR_ARCHITECTURE; NativeArch=$env:PROCESSOR_ARCHITEW6432; NoPath=$true }
    }
    if ($ServerExecutable) { $cases += @{ Name='real-server'; Kind='real-server'; NoPath=$true } }
    if ($CaseName) {
        $cases = @($cases | Where-Object { $_.Name -eq $CaseName })
        if ($cases.Count -ne 1) { throw "unknown or unavailable case: $CaseName" }
    }
    foreach ($spec in $cases) {
        $root = Join-Path $work $spec.Name
        $release = Join-Path $root 'release'
        $scratch = Join-Path $root 'scratch'
        New-Item -ItemType Directory -Path $release, $scratch -Force | Out-Null
        $c = @{ Name=$spec.Name; Root=$root; Release=$release; Scratch=$scratch; Installer=$installer
            Target=(Join-Path $root 'install with spaces'); InstallDir=(Join-Path $root 'install with spaces')
            Mode='call'; Kind='valid'; Existing=$false; Failure=$false; NoPath=$false
            Selection='explicit'; Arch='AMD64'; NativeArch=''; ExpectedArch='amd64' }
        foreach ($key in $spec.Keys) { $c[$key] = $spec[$key] }
        if ($spec.ContainsKey('Relative')) { $c.InstallDir = 'install with spaces' }
        if ($c.Selection -eq 'env' -and $c.Mode -ne 'iex') { $c.Target = Join-Path $root 'env install' }
        if ($c.Selection -eq 'latest') { $c.Target = Join-Path $root 'local appdata/Programs/omo-webchat' }
        $payload = Join-Path $root 'payload'
        if ($c.Kind -eq 'real-server') { Copy-Item -LiteralPath $ServerExecutable -Destination $payload }
        else { [IO.File]::WriteAllText($payload, "new-install-$($c.ExpectedArch)") }
        $c.Digest = (Get-FileHash -LiteralPath $payload).Hash
        # Build distinct architecture ZIPs. Expected selection comes from case
        # inputs, never from the installer's detector or the test host detector.
        foreach ($arch in @('amd64','arm64')) {
            $asset = "omo-webchat_windows_$arch.zip"
            $archive = Join-Path $release $asset
            $zip = [IO.Compression.ZipFile]::Open($archive, 'Create')
            try {
                if ($c.Kind -eq 'directory') { $null = $zip.CreateEntry('omo-webchat.exe/') }
                elseif ($c.Kind -eq 'missing-exe') { $null = $zip.CreateEntry('README.txt') }
                else {
                    $entry = $zip.CreateEntry('nested/omo-webchat.exe')
                    $stream = $entry.Open()
                    try {
                        $bytes = if ($arch -eq $c.ExpectedArch) { [IO.File]::ReadAllBytes($payload) } else { [Text.Encoding]::UTF8.GetBytes("wrong-architecture-$arch") }
                        $stream.Write($bytes, 0, $bytes.Length)
                    } finally { $stream.Dispose() }
                }
            } finally { $zip.Dispose() }
            if ($c.Kind -eq 'invalid-zip') { [IO.File]::WriteAllText($archive, 'not a ZIP') }
            $digest = (Get-FileHash -LiteralPath $archive).Hash
            if ($c.Kind -eq 'mismatch') { $digest = '0' * 64 }
            if ($c.Kind -eq 'malformed') { $digest = 'not-sha256' }
            $listed = if ($c.Kind -eq 'unlisted') { "wrong-$asset" } else { $asset }
            Add-Content -LiteralPath (Join-Path $release 'checksums.txt') -Value "$digest  $listed"
        }
        if ($c.Kind -eq 'missing-checksums') { Remove-Item -LiteralPath (Join-Path $release 'checksums.txt') }
        if ($c.Kind -eq 'missing-archive') { Remove-Item -Path (Join-Path $release '*.zip') }
        $config = Join-Path $root 'config.json'
        $c | ConvertTo-Json | Set-Content -LiteralPath $config
        foreach ($key in $oldTemp.Keys) { [Environment]::SetEnvironmentVariable($key, $scratch) }
        # Capture stderr without Windows PowerShell's native-stderr promotion.
        $stdout = Join-Path $root 'stdout.log'
        $stderr = Join-Path $root 'stderr.log'
        $process = Start-Process -FilePath $shell -ArgumentList @('-NoProfile','-File', ('"' + (Join-Path $PSScriptRoot 'installer_case.ps1') + '"'), '-Config', ('"' + $config + '"')) -PassThru -RedirectStandardOutput $stdout -RedirectStandardError $stderr
        # Retain the process handle before exit: .NET Framework otherwise
        # loses ExitCode after Start-Process returns (Windows PowerShell 5.1).
        $null = $process.Handle
        if (-not $process.WaitForExit(60000)) { $process.Kill(); throw "case timeout: $($c.Name)" }
        $process.WaitForExit()
        $output = (Get-Content -LiteralPath $stdout -Raw) + (Get-Content -LiteralPath $stderr -Raw)
        Write-Host $output
        if ($process.ExitCode -ne 0 -or $output -notmatch "PASS_CASE=$([regex]::Escape($c.Name)) CONTINUED=true") { $failures.Add($c.Name) }
        if (@(Get-ChildItem -LiteralPath $scratch -Filter 'omo-webchat-install-*').Count -ne 0) { $failures.Add("scratch-$($c.Name)") }
        if ([Environment]::GetEnvironmentVariable('Path','User') -cne $originalUserPath) { $failures.Add("user-path-restoration-$($c.Name)") }
    }
    # Actual standalone -File boundary, not a wrapper's exit code. A local
    # missing download gives a deterministic rejection without public network.
    $stdout = Join-Path $work 'standalone.stdout'
    $stderr = Join-Path $work 'standalone.stderr'
    $process = Start-Process -FilePath $shell -ArgumentList @('-NoProfile','-File', ('"' + $installer + '"'), '-Version','v-test','-BaseUrl','file:///installer-contract-does-not-exist','-InstallDir', ('"' + (Join-Path $work 'standalone') + '"'), '-NoPathUpdate') -PassThru -RedirectStandardOutput $stdout -RedirectStandardError $stderr
    # Retain the process handle before exit: .NET Framework otherwise
    # loses ExitCode after Start-Process returns (Windows PowerShell 5.1).
    $null = $process.Handle
    if (-not $process.WaitForExit(30000)) { $process.Kill(); throw 'standalone timeout' }
    $process.WaitForExit()
    Write-Host "STANDALONE_REJECTION_EXIT=$($process.ExitCode)"
    if ($null -eq $process.ExitCode -or $process.ExitCode -eq 0) { $failures.Add('standalone rejection') }
    if (@(Get-ChildItem -LiteralPath $scratch -Filter 'omo-webchat-install-*').Count -ne 0) { $failures.Add('standalone cleanup') }
    if (Test-Path -LiteralPath (Join-Path $work 'standalone/omo-webchat.exe')) { $failures.Add('standalone installed rejected payload') }
    if ([Environment]::GetEnvironmentVariable('Path','User') -cne $originalUserPath) { $failures.Add('standalone User PATH preservation') }
    if ($failures.Count) { throw "Failed cases: $($failures -join ', ')" }
} finally {
    foreach ($key in $oldTemp.Keys) { [Environment]::SetEnvironmentVariable($key, $oldTemp[$key]) }
    if ($windows) { [Environment]::SetEnvironmentVariable('Path', $originalUserPath, 'User') }
    Remove-Item -LiteralPath $work -Recurse -Force
}
Write-Host "PASS: installer contracts; Windows=$windows; realServer=$([bool]$ServerExecutable); suite scratch removed=$(-not (Test-Path -LiteralPath $work))"
