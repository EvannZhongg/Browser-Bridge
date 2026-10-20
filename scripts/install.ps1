param([switch]$ConfigureNosis)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
& npm.cmd ci --prefix $projectRoot
if ($LASTEXITCODE -ne 0) { throw 'Installing dependencies failed' }
& npm.cmd install --global $projectRoot
if ($LASTEXITCODE -ne 0) { throw 'Installing the browser-attach command failed' }
$setupArgs = @('setup')
if ($ConfigureNosis) { $setupArgs += '--nosis' }
& browser-attach.cmd @setupArgs
if ($LASTEXITCODE -ne 0) { throw 'Pairing/configuration failed' }
