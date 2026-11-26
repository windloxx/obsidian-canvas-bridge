param(
  [Parameter(Mandatory = $true)]
  [string]$VaultPath
)

$ErrorActionPreference = "Stop"
$globalDir = $PSScriptRoot
$resolvedVault = (Resolve-Path -LiteralPath $VaultPath).Path
$pluginsDir = Join-Path $resolvedVault ".obsidian\plugins"
if (-not (Test-Path -LiteralPath $pluginsDir)) {
  New-Item -ItemType Directory -Path $pluginsDir -Force | Out-Null
}
$linkPath = Join-Path $pluginsDir "obsidian-canvas-bridge"
if (Test-Path -LiteralPath $linkPath) {
  $item = Get-Item -LiteralPath $linkPath -Force
  if ($item.LinkType -eq "Junction") {
    $item.Delete()
  } else {
    $dataFile = Join-Path $linkPath "data.json"
    if (Test-Path -LiteralPath $dataFile) {
      throw "Refusing to replace $linkPath because data.json exists; back it up first."
    }
    Remove-Item -LiteralPath $linkPath -Recurse -Force
  }
}
New-Item -ItemType Junction -Path $linkPath -Target $globalDir | Out-Null
Write-Output "LINKED $linkPath -> $globalDir"
