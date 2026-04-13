Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
& node (Join-Path $scriptDir "run.mjs") @args
exit $LASTEXITCODE
