# Windows-only mutation receipts for registry deduplication and held-file errors.
# Mutate an isolated installer copy, never the checkout; normal acceptance
# remains the required full suite in both engines.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$shell = (Get-Process -Id $PID).Path
$source = Get-Content -LiteralPath (Join-Path (Split-Path $PSScriptRoot) 'install.ps1') -Raw
$work = Join-Path ([IO.Path]::GetTempPath()) ('omo-installer-mutation-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $work | Out-Null
try {
    $installer = Join-Path $work 'install.ps1'
    $mutations = @(
        @{ Case='reinstall-equivalent-path'; From='if (-not $onUserPath) {'; To='if ($true) {' },
        @{ Case='held-lock'; From='Stop-WithError "cannot write'; To='Write-Warn "cannot write' }
    )
    foreach ($mutation in $mutations) {
        if (-not $source.Contains($mutation.From)) { throw 'mutation boundary missing' }
        foreach ($phase in @('GREEN', 'RED', 'RESTORED_GREEN')) {
            $contents = if ($phase -eq 'RED') { $source.Replace($mutation.From, $mutation.To) } else { $source }
            Set-Content -LiteralPath $installer -Value $contents
            $stdout = Join-Path $work 'stdout.log'
            $stderr = Join-Path $work 'stderr.log'
            $args = @('-NoProfile', '-File', ('"' + (Join-Path $PSScriptRoot 'install_ps1_test.ps1') + '"'), '-CaseName', $mutation.Case, '-Installer', ('"' + $installer + '"'))
            $child = Start-Process -FilePath $shell -ArgumentList $args -PassThru -RedirectStandardOutput $stdout -RedirectStandardError $stderr
            # Retain the process handle before exit: .NET Framework otherwise
            # loses ExitCode after Start-Process returns (Windows PowerShell 5.1).
            $null = $child.Handle
            if (-not $child.WaitForExit(120000)) { $child.Kill(); throw 'mutation test timeout' }
            $child.WaitForExit()
            Get-Content -LiteralPath $stdout, $stderr | Write-Host
            Write-Host "MUTATION=$($mutation.Case) PHASE=$phase EXIT=$($child.ExitCode)"
            if (($phase -eq 'RED') -ne ($child.ExitCode -ne 0)) { throw "unexpected mutation result: $($mutation.Case) $phase" }
        }
    }
} finally {
    Remove-Item -LiteralPath $work -Recurse -Force
}
Write-Host "MUTATION_CLEANUP=$(-not (Test-Path -LiteralPath $work))"
