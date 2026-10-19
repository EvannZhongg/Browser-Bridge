param([string]$Python = 'python', [switch]$ConfigureNosis)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$venvPython = Join-Path $projectRoot '.venv\Scripts\python.exe'
if (-not (Test-Path -LiteralPath $venvPython)) {
    & $Python -m venv (Join-Path $projectRoot '.venv')
    if ($LASTEXITCODE -ne 0) { throw 'Creating the Python environment failed' }
}
if (Get-Command uv -ErrorAction SilentlyContinue) {
    & uv sync --project $projectRoot --frozen
} else {
    & $venvPython -m ensurepip --upgrade
    if ($LASTEXITCODE -ne 0) { throw 'Preparing pip failed' }
    & $venvPython -m pip install -e $projectRoot
}
if ($LASTEXITCODE -ne 0) { throw 'Installing dependencies failed' }
$setupArgs = @('-m', 'browser_bridge.setup', 'setup')
if ($ConfigureNosis) { $setupArgs += '--nosis' }
& $venvPython @setupArgs
if ($LASTEXITCODE -ne 0) { throw 'Pairing/configuration failed' }
