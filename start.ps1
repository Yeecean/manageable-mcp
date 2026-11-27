param(
  [ValidateSet('stdio', 'http')]
  [string]$Transport = 'http',
  [int]$Port = 8080
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

npm.cmd run build
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

$cliArgs = @(
  'dist/index.js',
  'serve',
  '--config', 'servers.example.json',
  '--transport', $Transport
)

if ($Transport -eq 'http') {
  $cliArgs += @('--port', [string]$Port)
}

& node @cliArgs
exit $LASTEXITCODE
