<#
  dev/check-build-fresh.ps1 — fail-closed staleness probe for the two build
  outputs the desktop launchers serve.

  Exit codes:
    0  lib/index.js and client/index.js are both at least as new as their
       newest relevant source file.
    1  either output is missing, older than its sources, or the probe itself
       failed. The launchers treat EVERY nonzero exit as stale (a blocked or
       failed PowerShell probe must never fail open).

  The probe never builds anything; it only compares timestamps.
#>
param(
  [Parameter(Mandatory = $true)][string]$Repo
)

$ErrorActionPreference = 'Stop'

function Get-NewestSource {
  param(
    [string[]]$Roots,
    [string[]]$Include,
    [scriptblock]$Skip
  )
  # -Include only works with a wildcard in -Path, and silently matches
  # everything under -LiteralPath, which made vendored lib\*.js and *.map
  # files count as "sources" and marked every build stale forever. Filter by
  # extension in Where-Object instead.
  $patterns = @($Include | ForEach-Object { '*' + $_.TrimStart('*') })
  $files = Get-ChildItem -LiteralPath $Roots -Recurse -File -ErrorAction Stop |
    Where-Object {
      $name = $_.Name
      ($patterns | Where-Object { $name -like $_ }) -and
      -not $name.EndsWith('.d.ts', [System.StringComparison]::OrdinalIgnoreCase) -and
      -not ($Skip -and (& $Skip $_.FullName))
    }
  $newest = $files | Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if ($null -eq $newest) {
    throw "no source files found under: $($Roots -join ', ')"
  }
  return $newest
}

function Assert-Fresh {
  param(
    [string]$Output,
    [System.IO.FileInfo]$Source,
    [string]$SourceLabel
  )
  if (-not (Test-Path -LiteralPath $Output -PathType Leaf)) {
    throw "missing build output: $Output (run the build)"
  }
  $outputItem = Get-Item -LiteralPath $Output -ErrorAction Stop
  if ($outputItem.LastWriteTime -lt $Source.LastWriteTime) {
    throw "stale build: $Output is older than $($Source.FullName) ($SourceLabel)"
  }
}

try {
  $root = (Resolve-Path -LiteralPath $Repo -ErrorAction Stop).Path
  $src = Join-Path $root 'src'
  $clientSrc = Join-Path $src 'client'
  $vendor = Join-Path $root 'vendor\racoons'
  $separator = [System.IO.Path]::DirectorySeparatorChar

  # lib/index.js is emitted by `tsc -p tsconfig.json` over src/ (minus the
  # browser client) plus the vendored racoons packages.
  $libSource = Get-NewestSource -Roots @($src, $vendor) -Include @('*.ts') -Skip {
    param([string]$full)
    $full.StartsWith($clientSrc + $separator, [System.StringComparison]::OrdinalIgnoreCase) -or
      $full -like '*\node_modules\*'
  }

  # client/index.js is emitted by scripts/build-client.ts. The bundle imports
  # modules outside src/client (core types, policy prompts, the roster channel),
  # and its external list comes from package.json, so the whole source tree plus
  # the builder and manifest are relevant. Conservative on purpose: a false
  # "stale" only asks for one cheap rebuild; a false "fresh" serves wrong bytes.
  $scriptsRoot = Join-Path $root 'scripts'
  $clientSource = Get-NewestSource -Roots @($src, $vendor, $scriptsRoot) -Include @('*.ts', '*.tsx') -Skip {
    param([string]$full)
    $full -like '*\node_modules\*'
  }
  $manifest = Get-Item -LiteralPath (Join-Path $root 'package.json') -ErrorAction Stop
  if ($manifest.LastWriteTime -gt $clientSource.LastWriteTime) {
    $clientSource = $manifest
  }

  Assert-Fresh -Output (Join-Path $root 'lib\index.js') -Source $libSource -SourceLabel 'lib sources'
  Assert-Fresh -Output (Join-Path $root 'client\index.js') -Source $clientSource -SourceLabel 'client sources'
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
}

exit 0
