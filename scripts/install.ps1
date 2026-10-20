param([switch]$ConfigureNosis)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$env:BROWSER_BRIDGE_HOME = Join-Path $projectRoot '.local\runtime'
& npm.cmd ci --prefix $projectRoot
if ($LASTEXITCODE -ne 0) { throw 'Installing dependencies failed' }
& npm.cmd install --global $projectRoot
if ($LASTEXITCODE -ne 0) { throw 'Installing the browser-bridge command failed' }
$setupArgs = @('setup', '--extension-dir', (Join-Path $projectRoot 'extension'))
if ($ConfigureNosis) { $setupArgs += '--nosis' }
& browser-bridge.cmd @setupArgs
if ($LASTEXITCODE -ne 0) { throw 'Pairing/configuration failed' }
