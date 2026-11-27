param(
  [ValidateSet('stdio', 'http')]
  [string]$Transport = 'http',
  [int]$Port = 0,
  [string]$Config = ''
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

npm.cmd run build
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

$cliArgs = @(
  'dist/index.js',
  'serve',
  '--transport', $Transport
)

if ($Config -ne '') {
  $cliArgs += @('--config', $Config)
}

if ($Transport -eq 'http') {
  if ($Port -gt 0) {
    $cliArgs += @('--port', [string]$Port)
  }
}

& node @cliArgs
exit $LASTEXITCODE
