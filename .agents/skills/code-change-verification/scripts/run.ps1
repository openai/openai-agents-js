Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$repoRoot = $null

try {
    $repoRoot = (& git -C $scriptDir rev-parse --show-toplevel 2>$null)
} catch {
    $repoRoot = $null
}

if (-not $repoRoot) {
    $repoRoot = Resolve-Path (Join-Path $scriptDir "..\..\..\..")
}

Set-Location $repoRoot

function Invoke-PnpmStep {
    param(
        [Parameter(Mandatory = $true)][string[]]$Args
    )

    $commandText = "pnpm " + ($Args -join " ")
    Write-Host "Running $commandText..."
    & pnpm @Args

    if ($LASTEXITCODE -ne 0) {
        Write-Error "code-change-verification: $commandText failed with exit code $LASTEXITCODE."
        exit $LASTEXITCODE
    }
}

Invoke-PnpmStep -Args @("i")
Invoke-PnpmStep -Args @("build")
Invoke-PnpmStep -Args @("-r", "build-check")
Invoke-PnpmStep -Args @("-r", "-F", "@openai/*", "dist:check")
Invoke-PnpmStep -Args @("lint")
Invoke-PnpmStep -Args @("test")

Write-Host "code-change-verification: all commands passed."
