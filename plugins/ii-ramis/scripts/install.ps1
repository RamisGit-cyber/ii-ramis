# Installer of the 'II Ramis' package for Windows (PowerShell). Idempotent: safe to run again.
# Run:  irm https://raw.githubusercontent.com/RamisGit-cyber/ii-ramis/v1.0.3/plugins/ii-ramis/scripts/install.ps1 | iex
# The installer itself is fetched from an immutable tag (v1.0.3); the plugin follows the stable branch with auto-update on.
# This file is ASCII ONLY (Russian strings are built from ~uXXXX codes by function T), so it reads the same via irm | iex
# and via powershell -File in Windows PowerShell 5.1 without a BOM. The installer never enables bypass mode,
# and the installer does not ask the session-recap sharing consent: ii-ramis asks it once in the chat on the first greeting.
# File parameters: -DryRun  -SkipThirdParty
# With `| iex` the parameter is an env var: IIRAMIS_DRYRUN=1
param(
  [switch]$DryRun,
  [switch]$SkipThirdParty
)

$ErrorActionPreference = 'Continue'
# T: turns ~uXXXX tokens (UTF-16 code unit) into real characters. The whole file stays ASCII.
function T([string]$Text) {
  return [regex]::Replace($Text, '~u([0-9A-Fa-f]{4})', [System.Text.RegularExpressions.MatchEvaluator]{ param($m) [string][char][Convert]::ToInt32($m.Groups[1].Value, 16) })
}
if ($env:IIRAMIS_DRYRUN -eq '1') { $DryRun = $true }

$ReleaseTag = 'v1.0.3'
$ChannelRef = 'stable'
$RawBase = if ($env:IIRAMIS_RAW_BASE) { $env:IIRAMIS_RAW_BASE } else { "https://raw.githubusercontent.com/RamisGit-cyber/ii-ramis/$ReleaseTag/plugins/ii-ramis/scripts" }
$MarketplaceSource = if ($env:IIRAMIS_MARKETPLACE_SOURCE) { $env:IIRAMIS_MARKETPLACE_SOURCE } else { "RamisGit-cyber/ii-ramis#$ChannelRef" }
$Report = New-Object System.Collections.ArrayList

function Add-Report([string]$Status, [string]$What, [string]$Detail) {
  if ($DryRun) { $Detail = (T "(~u043F~u0440~u043E~u0431~u0430) $Detail") }
  [void]$Report.Add([pscustomobject]@{ Status = $Status; What = $What; Detail = $Detail })
}
function Test-Command([string]$CommandName) { return [bool](Get-Command $CommandName -ErrorAction SilentlyContinue) }
function Update-SessionPath {
  $machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')
  $user = [Environment]::GetEnvironmentVariable('Path', 'User')
  $env:Path = "$machine;$user;$env:USERPROFILE\.local\bin"
}
function Install-WithWinget([string]$PackageId) {
  if ($DryRun) { Write-Host (T "  [~u043F~u0440~u043E~u0431~u0430] winget install $PackageId"); return $true }
  if (-not (Test-Command 'winget')) { return $false }
  winget install --id $PackageId -e --silent --accept-package-agreements --accept-source-agreements | Out-Null
  Update-SessionPath
  return ($LASTEXITCODE -eq 0)
}

Write-Host (T '~u0418~u0418 ~u0420~u0430~u043C~u0438~u0441: ~u0443~u0441~u0442~u0430~u043D~u043E~u0432~u043A~u0430 ~u043F~u0430~u043A~u0435~u0442~u0430. ~u042D~u0442~u043E ~u0437~u0430~u0439~u043C~u0451~u0442 ~u043D~u0435~u0441~u043A~u043E~u043B~u044C~u043A~u043E ~u043C~u0438~u043D~u0443~u0442.')
if ($DryRun) { Write-Host (T '(~u0440~u0435~u0436~u0438~u043C ~u043F~u0440~u043E~u0431~u044B: ~u043D~u0438~u0447~u0435~u0433~u043E ~u043D~u0435 ~u043C~u0435~u043D~u044F~u044E)') }
Update-SessionPath

# ---------- 1. Base tools ----------
if (Test-Command 'git') {
  Add-Report 'ok' 'Git' ((git --version) -join ' ')
} elseif (Install-WithWinget 'Git.Git') {
  Add-Report 'done' 'Git' (T '~u043F~u043E~u0441~u0442~u0430~u0432~u043B~u0435~u043D ~u0447~u0435~u0440~u0435~u0437 winget')
} else {
  Add-Report 'need' 'Git' (T '~u0421~u043A~u0430~u0447~u0430~u0439 ~u0441 git-scm.com/downloads/win (~u0432~u0435~u0437~u0434~u0435 Next, ~u043F~u043E~u0442~u043E~u043C Finish), ~u0437~u0430~u043A~u0440~u043E~u0439 Claude ~u043F~u043E~u043B~u043D~u043E~u0441~u0442~u044C~u044E ~u0438 ~u0437~u0430~u043F~u0443~u0441~u0442~u0438 ~u0443~u0441~u0442~u0430~u043D~u043E~u0432~u0449~u0438~u043A ~u0435~u0449~u0451 ~u0440~u0430~u0437.')
}

if (Test-Command 'node') {
  Add-Report 'ok' 'Node.js' ((node --version) -join ' ')
} elseif (Install-WithWinget 'OpenJS.NodeJS.LTS') {
  Add-Report 'done' 'Node.js' (T '~u043F~u043E~u0441~u0442~u0430~u0432~u043B~u0435~u043D ~u0447~u0435~u0440~u0435~u0437 winget')
} else {
  Add-Report 'need' 'Node.js' (T '~u0421~u043A~u0430~u0447~u0430~u0439 LTS ~u043D~u0430 nodejs.org ~u0438 ~u0437~u0430~u043F~u0443~u0441~u0442~u0438 ~u0443~u0441~u0442~u0430~u043D~u043E~u0432~u0449~u0438~u043A ~u0435~u0449~u0451 ~u0440~u0430~u0437.')
}

if (Test-Command 'python') {
  Add-Report 'ok' 'Python' ((python --version 2>&1) -join ' ')
} elseif (Install-WithWinget 'Python.Python.3.12') {
  Add-Report 'done' 'Python' (T '~u043F~u043E~u0441~u0442~u0430~u0432~u043B~u0435~u043D ~u0447~u0435~u0440~u0435~u0437 winget')
} else {
  Add-Report 'skip' 'Python' (T '~u043D~u0435 ~u043E~u0431~u044F~u0437~u0430~u0442~u0435~u043B~u0435~u043D ~u0434~u043B~u044F ~u0443~u0440~u043E~u043A~u0430 4, ~u043F~u043E~u0441~u0442~u0430~u0432~u0438~u043C ~u043F~u043E~u0437~u0436~u0435')
}

if (Test-Command 'gh') {
  Add-Report 'ok' 'GitHub CLI (gh)' ((gh --version | Select-Object -First 1) -join ' ')
} elseif (Install-WithWinget 'GitHub.cli') {
  Add-Report 'done' 'GitHub CLI (gh)' (T '~u043F~u043E~u0441~u0442~u0430~u0432~u043B~u0435~u043D ~u0447~u0435~u0440~u0435~u0437 winget')
} else {
  Add-Report 'skip' 'GitHub CLI (gh)' (T '~u043F~u043E~u0441~u0442~u0430~u0432~u0438~u0442 ~u0418~u0418 ~u0420~u0430~u043C~u0438~u0441 ~u043D~u0430 ~u0443~u0440~u043E~u043A~u0435 ~u043F~u0440~u043E GitHub')
}
if (Test-Command 'gh') {
  gh auth status 2>$null | Out-Null
  if ($LASTEXITCODE -eq 0) { Add-Report 'ok' (T '~u0412~u0445~u043E~u0434 ~u0432 GitHub') (T '~u0432~u044B~u043F~u043E~u043B~u043D~u0435~u043D') }
  else { Add-Report 'need' (T '~u0412~u0445~u043E~u0434 ~u0432 GitHub') (T '~u041D~u0443~u0436~u0435~u043D ~u043E~u0434~u0438~u043D ~u0440~u0430~u0437 ~u0432 ~u0431~u0440~u0430~u0443~u0437~u0435~u0440~u0435: ~u0418~u0418 ~u0420~u0430~u043C~u0438~u0441 ~u043F~u0440~u043E~u0432~u0435~u0434~u0451~u0442, ~u043A~u043E~u0433~u0434~u0430 ~u043F~u043E~u043D~u0430~u0434~u043E~u0431~u0438~u0442~u0441~u044F (~u043A~u043E~u043C~u0430~u043D~u0434~u0430 gh auth login).') }
}

# ---------- 2. Settings script (lies next to us or is downloaded) ----------
$NodeAvailable = Test-Command 'node'
$SetupJs = $null
if ($PSScriptRoot -and (Test-Path (Join-Path $PSScriptRoot 'setup-settings.mjs'))) {
  $SetupJs = Join-Path $PSScriptRoot 'setup-settings.mjs'
  if (-not $DryRun) {   # copy into .ii-ramis: the student enables bypass mode from PowerShell with it
    $dataDirCopy = Join-Path $env:USERPROFILE '.ii-ramis'
    New-Item -ItemType Directory -Force -Path $dataDirCopy | Out-Null
    Copy-Item -Force $SetupJs (Join-Path $dataDirCopy 'setup-settings.mjs')
  }
} elseif ($NodeAvailable -and -not $DryRun) {
  $dataDir = Join-Path $env:USERPROFILE '.ii-ramis'
  New-Item -ItemType Directory -Force -Path $dataDir | Out-Null
  $SetupJs = Join-Path $dataDir 'setup-settings.mjs'
  try {
    Invoke-WebRequest -UseBasicParsing -Uri "$RawBase/setup-settings.mjs" -OutFile $SetupJs -TimeoutSec 30
  }
  catch { $SetupJs = $null; Write-Host (T "~u041D~u0435 ~u0441~u043A~u0430~u0447~u0430~u043B setup-settings.mjs: $($_.Exception.Message)") }
}
function Invoke-Setup([string[]]$SetupArgs) {
  if (-not $NodeAvailable -or -not $SetupJs) {
    if ($DryRun) { Write-Host (T "  [~u043F~u0440~u043E~u0431~u0430] node setup-settings.mjs $($SetupArgs -join ' ')"); return @{ Ok = $true; Output = '' } }
    return @{ Ok = $false; Output = (T '~u043D~u0435~u0442 Node.js ~u0438~u043B~u0438 ~u0441~u043A~u0440~u0438~u043F~u0442~u0430 ~u043D~u0430~u0441~u0442~u0440~u043E~u0435~u043A') }
  }
  $all = @($SetupJs) + $SetupArgs
  if ($DryRun) { $all += '--dry-run' }
  $output = & node @all 2>&1
  return @{ Ok = ($LASTEXITCODE -eq 0); Output = ($output -join '; ') }
}

# ---------- 3. Plugins and MCP ----------
$ClaudeAvailable = Test-Command 'claude'

function Update-OwnMarketplace {
  # The source in settings is already switched to stable (setup-settings.mjs), so add accepts it and re-clones.
  # No remove: it would delete the student's plugin together with its data.
  if ($DryRun) { return }
  claude plugin marketplace add $MarketplaceSource 2>&1 | Out-Null
  claude plugin marketplace update ii-ramis 2>&1 | Out-Null
}

function Install-Plugin([string]$MarketplaceName, [string]$MarketplaceSrc, [string]$Plugin) {
  $id = "$Plugin@$MarketplaceName"
  if ($ClaudeAvailable) {
    $installed = (claude plugin list 2>$null) -join "`n"
    if ($installed -match [regex]::Escape($id)) {
      # already installed: still rebind our marketplace to stable and refresh it (student coming from v1.0.2)
      if ($MarketplaceName -eq 'ii-ramis') { Update-OwnMarketplace }
      Add-Report 'ok' (T "~u041F~u043B~u0430~u0433~u0438~u043D $Plugin") (T '~u0443~u0436~u0435 ~u0443~u0441~u0442~u0430~u043D~u043E~u0432~u043B~u0435~u043D'); return
    }
    if (-not $DryRun) {
      claude plugin marketplace add $MarketplaceSrc 2>&1 | Out-Null
      claude plugin install $id 2>&1 | Out-Null
    }
    if ($DryRun -or $LASTEXITCODE -eq 0) { Add-Report 'done' (T "~u041F~u043B~u0430~u0433~u0438~u043D $Plugin") (T '~u0443~u0441~u0442~u0430~u043D~u043E~u0432~u043B~u0435~u043D ~u0447~u0435~u0440~u0435~u0437 claude plugin install'); return }
  }
  $result = Invoke-Setup @('--marketplace', $MarketplaceName, '--enable', $id)
  if ($result.Ok) { Add-Report 'done' (T "~u041F~u043B~u0430~u0433~u0438~u043D $Plugin") (T '~u0432~u043A~u043B~u044E~u0447~u0451~u043D ~u0432 ~u043D~u0430~u0441~u0442~u0440~u043E~u0439~u043A~u0430~u0445, ~u0441~u043A~u0430~u0447~u0430~u0435~u0442~u0441~u044F ~u043F~u0440~u0438 ~u0441~u043B~u0435~u0434~u0443~u044E~u0449~u0435~u043C ~u0437~u0430~u043F~u0443~u0441~u043A~u0435 Claude') }
  else { Add-Report 'fail' (T "~u041F~u043B~u0430~u0433~u0438~u043D $Plugin") $result.Output }
}

function Install-Mcp([string]$McpName, [string[]]$McpCommand) {
  if ($ClaudeAvailable) {
    claude mcp get $McpName 2>&1 | Out-Null
    if ($LASTEXITCODE -eq 0) { Add-Report 'ok' "MCP $McpName" (T '~u0443~u0436~u0435 ~u043F~u043E~u0434~u043A~u043B~u044E~u0447~u0451~u043D'); return }
    if (-not $DryRun) {
      claude mcp add --scope user $McpName -- cmd /c @McpCommand 2>&1 | Out-Null
      if ($LASTEXITCODE -eq 0) { Add-Report 'done' "MCP $McpName" (T '~u043F~u043E~u0434~u043A~u043B~u044E~u0447~u0451~u043D'); return }
    }
  }
  $result = Invoke-Setup @('--mcp', $McpName)
  if ($result.Ok) { Add-Report 'done' "MCP $McpName" (T '~u0434~u043E~u0431~u0430~u0432~u043B~u0435~u043D ~u0432 .claude.json') }
  else { Add-Report 'fail' "MCP $McpName" $result.Output }
}

if (-not $SkipThirdParty) {
  Install-Plugin 'claude-plugins-official' 'anthropics/claude-plugins-official' 'superpowers'
  Install-Plugin 'thedotmack' 'thedotmack/claude-mem' 'claude-mem'
  Install-Plugin 'ecc' 'affaan-m/ECC' 'ecc'
  Install-Mcp 'context7' @('npx', '-y', '@upstash/context7-mcp')
  Install-Mcp 'playwright' @('npx', '@playwright/mcp@latest')
}
# Settings first (stable source + auto-update), claude commands after: otherwise `marketplace add` with a new ref
# is refused because it does not match the settings entry (checked on Claude Code 2.1.316).
[void](Invoke-Setup @('--marketplace', 'ii-ramis', '--auto-update', 'ii-ramis'))
Install-Plugin 'ii-ramis' $MarketplaceSource 'ii-ramis'

# ---------- 4. Settings: marketplace on stable with auto-update ----------
# Auto-update is on only for the ii-ramis marketplace. If the student turned it off (autoUpdate: false), we leave it.
$setupArgs = @('--marketplace', 'ii-ramis', '--auto-update', 'ii-ramis')
$settingsResult = Invoke-Setup $setupArgs
if ($settingsResult.Ok) { Add-Report 'done' (T '~u041D~u0430~u0441~u0442~u0440~u043E~u0439~u043A~u0438 Claude') $settingsResult.Output }
else { Add-Report 'fail' (T '~u041D~u0430~u0441~u0442~u0440~u043E~u0439~u043A~u0438 Claude') $settingsResult.Output }

Add-Report 'skip' (T '~u041F~u0435~u0440~u0435~u0441~u043A~u0430~u0437~u044B ~u0437~u0430~u043D~u044F~u0442~u0438~u0439 ~u0420~u0430~u043C~u0438~u0441~u0443') (T '~u043F~u043E ~u0443~u043C~u043E~u043B~u0447~u0430~u043D~u0438~u044E ~u0432~u044B~u043A~u043B~u044E~u0447~u0435~u043D~u044B. ~u0418~u0418 ~u0420~u0430~u043C~u0438~u0441 ~u043E~u0434~u0438~u043D ~u0440~u0430~u0437 ~u0441~u043F~u0440~u043E~u0441~u0438~u0442 ~u0441~u043E~u0433~u043B~u0430~u0441~u0438~u0435 ~u0432 ~u0447~u0430~u0442~u0435 ~u043F~u0440~u0438 ~u043F~u0435~u0440~u0432~u043E~u043C ~u00AB~u043F~u0440~u0438~u0432~u0435~u0442~u00BB; ~u043E~u0442~u0432~u0435~u0442 ~u00AB~u043D~u0435~u0442~u00BB ~u043D~u0438~u0447~u0435~u0433~u043E ~u043D~u0435 ~u043E~u0442~u043F~u0440~u0430~u0432~u043B~u044F~u0435~u0442.')

# Bypass mode is NOT enabled by the installer at all: only the student can.
Add-Report 'need' (T '~u0420~u0435~u0436~u0438~u043C ~u00AB~u0431~u0435~u0437 ~u0432~u043E~u043F~u0440~u043E~u0441~u043E~u0432~u00BB') (T '~u043D~u0435 ~u0432~u043A~u043B~u044E~u0447~u0451~u043D ~u0438 ~u043D~u0438~u043A~u0430~u043A~u043E~u0439 ~u0441~u043A~u0440~u0438~u043F~u0442 ~u0435~u0433~u043E ~u043D~u0435 ~u0432~u043A~u043B~u044E~u0447~u0430~u0435~u0442. ~u0425~u043E~u0447~u0435~u0448~u044C ~u0441~u0430~u043C: Claude Desktop -> Settings -> Code -> ~u00ABAllow bypass permissions mode~u00BB (~u0438~u043B~u0438 ~u043F~u0440~u0430~u0432~u043A~u0430 settings.json, ~u0441~u043C. README)')

# ---------- 5. Summary ----------
Write-Host ''
Write-Host (T '===== ~u0427~u0442~u043E ~u0441~u0434~u0435~u043B~u0430~u043D~u043E =====')
$hasFail = $false
foreach ($item in $Report) {
  $mark = switch ($item.Status) {
    'ok' { (T '[~u0443~u0436~u0435 ~u0431~u044B~u043B~u043E]') }
    'done' { (T '[~u0441~u0434~u0435~u043B~u0430~u043D~u043E]') }
    'skip' { (T '[~u043F~u0440~u043E~u043F~u0443~u0449~u0435~u043D~u043E]') }
    'need' { (T '[~u043D~u0443~u0436~u043D~u043E ~u043E~u0442 ~u0442~u0435~u0431~u044F]') }
    'fail' { (T '[~u043D~u0435 ~u0432~u044B~u0448~u043B~u043E]'); $hasFail = $true }
  }
  Write-Host "$mark $($item.What): $($item.Detail)"
}
Write-Host ''
Write-Host (T '~u0414~u0430~u043B~u044C~u0448~u0435: ~u043F~u043E~u043B~u043D~u043E~u0441~u0442~u044C~u044E ~u0437~u0430~u043A~u0440~u043E~u0439 Claude (~u0438 ~u0432 ~u0442~u0440~u0435~u0435) ~u0438 ~u043E~u0442~u043A~u0440~u043E~u0439 ~u0437~u0430~u043D~u043E~u0432~u043E, ~u0437~u0430~u0442~u0435~u043C ~u043D~u0430~u043F~u0438~u0448~u0438 ~u0432 ~u0447~u0430~u0442~u0435 ~u00AB~u043F~u0440~u0438~u0432~u0435~u0442~u00BB. ~u0415~u0441~u043B~u0438 ~u0447~u0442~u043E-~u0442~u043E ~u043D~u0435 ~u0432~u044B~u0448~u043B~u043E, ~u0441~u043A~u0430~u0436~u0438 ~u043E~u0431 ~u044D~u0442~u043E~u043C ~u0418~u0418 ~u0420~u0430~u043C~u0438~u0441~u0443 ~u0432 ~u0447~u0430~u0442~u0435.')
Write-Host (T '~u0420~u0435~u0436~u0438~u043C ~u00AB~u0431~u0435~u0437 ~u0432~u043E~u043F~u0440~u043E~u0441~u043E~u0432~u00BB ~u0443~u0441~u0442~u0430~u043D~u043E~u0432~u0449~u0438~u043A ~u043D~u0435 ~u0432~u043A~u043B~u044E~u0447~u0430~u0435~u0442: ~u044D~u0442~u043E ~u0442~u043E~u043B~u044C~u043A~u043E ~u0442~u0432~u043E~u0439 ~u0442~u0443~u043C~u0431~u043B~u0435~u0440 ~u0432 Claude Desktop (Settings -> Code). ~u041F~u043B~u0430~u0433~u0438~u043D ~u043E~u0431~u043D~u043E~u0432~u043B~u044F~u0435~u0442~u0441~u044F ~u0441~u0430~u043C (~u0430~u0432~u0442~u043E~u043E~u0431~u043D~u043E~u0432~u043B~u0435~u043D~u0438~u0435 ~u0432~u043A~u043B~u044E~u0447~u0435~u043D~u043E); ~u043A~u0430~u043A ~u044D~u0442~u043E ~u043E~u0442~u043A~u043B~u044E~u0447~u0438~u0442~u044C, ~u043D~u0430~u043F~u0438~u0441~u0430~u043D~u043E ~u0432 README.')
if ($hasFail) { exit 1 }
