$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $PSScriptRoot
$Vsix = Join-Path $Root "dist\autodl-control.vsix"

function Resolve-CodeCommand {
  $code = Get-Command code -ErrorAction SilentlyContinue
  if ($code) {
    return $code.Source
  }

  $candidate = Join-Path $env:LOCALAPPDATA "Programs\Microsoft VS Code\bin\code.cmd"
  if (Test-Path $candidate) {
    return $candidate
  }

  $insiders = Join-Path $env:LOCALAPPDATA "Programs\Microsoft VS Code Insiders\bin\code-insiders.cmd"
  if (Test-Path $insiders) {
    return $insiders
  }

  throw "Cannot find VS Code CLI. Install VS Code or add the 'code' command to PATH."
}

Push-Location $Root
try {
  $env:npm_config_cache = Join-Path $Root ".npm-cache"
  npm install
  npm run package

  $codeCommand = Resolve-CodeCommand
  & $codeCommand --install-extension $Vsix --force
  Write-Host "Installed AutoDL Control from $Vsix"
}
finally {
  Pop-Location
}
