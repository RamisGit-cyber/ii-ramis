# Установщик пакета «ИИ Рамис» для Windows (PowerShell). Идемпотентный: повторный запуск безопасен.
# Запуск:  irm https://raw.githubusercontent.com/RamisGit-cyber/ii-ramis/main/plugins/ii-ramis/scripts/install.ps1 | iex
# Параметры при запуске файла: -DryRun  -Share yes|no  -Name "Имя"  -SkipThirdParty
# При запуске через `| iex` параметры задаются переменными окружения: IIRAMIS_DRYRUN=1, IIRAMIS_SHARE=yes|no, IIRAMIS_NAME
param(
  [switch]$DryRun,
  [string]$Share = '',
  [string]$Name = '',
  [switch]$SkipThirdParty
)

$ErrorActionPreference = 'Continue'
if ($env:IIRAMIS_DRYRUN -eq '1') { $DryRun = $true }
if (-not $Share -and $env:IIRAMIS_SHARE) { $Share = $env:IIRAMIS_SHARE }
if (-not $Name -and $env:IIRAMIS_NAME) { $Name = $env:IIRAMIS_NAME }

$RawBase = if ($env:IIRAMIS_RAW_BASE) { $env:IIRAMIS_RAW_BASE } else { 'https://raw.githubusercontent.com/RamisGit-cyber/ii-ramis/main/plugins/ii-ramis/scripts' }
$MarketplaceSource = if ($env:IIRAMIS_MARKETPLACE_SOURCE) { $env:IIRAMIS_MARKETPLACE_SOURCE } else { 'RamisGit-cyber/ii-ramis' }
$Report = New-Object System.Collections.ArrayList

function Add-Report([string]$Status, [string]$What, [string]$Detail) {
  if ($DryRun) { $Detail = "(проба) $Detail" }
  [void]$Report.Add([pscustomobject]@{ Status = $Status; What = $What; Detail = $Detail })
}
function Test-Command([string]$CommandName) { return [bool](Get-Command $CommandName -ErrorAction SilentlyContinue) }
function Update-SessionPath {
  $machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')
  $user = [Environment]::GetEnvironmentVariable('Path', 'User')
  $env:Path = "$machine;$user;$env:USERPROFILE\.local\bin"
}
function Install-WithWinget([string]$PackageId) {
  if ($DryRun) { Write-Host "  [проба] winget install $PackageId"; return $true }
  if (-not (Test-Command 'winget')) { return $false }
  winget install --id $PackageId -e --silent --accept-package-agreements --accept-source-agreements | Out-Null
  Update-SessionPath
  return ($LASTEXITCODE -eq 0)
}

Write-Host 'ИИ Рамис: установка пакета. Это займёт несколько минут.'
if ($DryRun) { Write-Host '(режим пробы: ничего не меняю)' }
Update-SessionPath

# ---------- 1. Базовые инструменты ----------
if (Test-Command 'git') {
  Add-Report 'ok' 'Git' ((git --version) -join ' ')
} elseif (Install-WithWinget 'Git.Git') {
  Add-Report 'done' 'Git' 'поставлен через winget'
} else {
  Add-Report 'need' 'Git' 'Скачай с git-scm.com/downloads/win (везде Next, потом Finish), закрой Claude полностью и запусти установщик ещё раз.'
}

if (Test-Command 'node') {
  Add-Report 'ok' 'Node.js' ((node --version) -join ' ')
} elseif (Install-WithWinget 'OpenJS.NodeJS.LTS') {
  Add-Report 'done' 'Node.js' 'поставлен через winget'
} else {
  Add-Report 'need' 'Node.js' 'Скачай LTS на nodejs.org и запусти установщик ещё раз.'
}

if (Test-Command 'python') {
  Add-Report 'ok' 'Python' ((python --version 2>&1) -join ' ')
} elseif (Install-WithWinget 'Python.Python.3.12') {
  Add-Report 'done' 'Python' 'поставлен через winget'
} else {
  Add-Report 'skip' 'Python' 'не обязателен для урока 4, поставим позже'
}

if (Test-Command 'gh') {
  Add-Report 'ok' 'GitHub CLI (gh)' ((gh --version | Select-Object -First 1) -join ' ')
} elseif (Install-WithWinget 'GitHub.cli') {
  Add-Report 'done' 'GitHub CLI (gh)' 'поставлен через winget'
} else {
  Add-Report 'skip' 'GitHub CLI (gh)' 'поставит ИИ Рамис на уроке про GitHub'
}
if (Test-Command 'gh') {
  gh auth status 2>$null | Out-Null
  if ($LASTEXITCODE -eq 0) { Add-Report 'ok' 'Вход в GitHub' 'выполнен' }
  else { Add-Report 'need' 'Вход в GitHub' 'Нужен один раз в браузере: ИИ Рамис проведёт, когда понадобится (команда gh auth login).' }
}

# ---------- 2. Скрипт настроек (рядом лежит или скачиваем) ----------
$NodeAvailable = Test-Command 'node'
$SetupJs = $null
if ($PSScriptRoot -and (Test-Path (Join-Path $PSScriptRoot 'setup-settings.mjs'))) {
  $SetupJs = Join-Path $PSScriptRoot 'setup-settings.mjs'
} elseif ($NodeAvailable -and -not $DryRun) {
  $dataDir = Join-Path $env:USERPROFILE '.ii-ramis'
  New-Item -ItemType Directory -Force -Path $dataDir | Out-Null
  $SetupJs = Join-Path $dataDir 'setup-settings.mjs'
  try { Invoke-WebRequest -UseBasicParsing -Uri "$RawBase/setup-settings.mjs" -OutFile $SetupJs -TimeoutSec 30 }
  catch { $SetupJs = $null; Write-Host "Не скачал setup-settings.mjs: $($_.Exception.Message)" }
}
function Invoke-Setup([string[]]$SetupArgs) {
  if (-not $NodeAvailable -or -not $SetupJs) {
    if ($DryRun) { Write-Host "  [проба] node setup-settings.mjs $($SetupArgs -join ' ')"; return @{ Ok = $true; Output = '' } }
    return @{ Ok = $false; Output = 'нет Node.js или скрипта настроек' }
  }
  $all = @($SetupJs) + $SetupArgs
  if ($DryRun) { $all += '--dry-run' }
  $output = & node @all 2>&1
  return @{ Ok = ($LASTEXITCODE -eq 0); Output = ($output -join '; ') }
}

# ---------- 3. Согласие на отправку итогов ----------
if (-not $Share -and -not $DryRun -and [Environment]::UserInteractive -and -not [Console]::IsInputRedirected) {
  Write-Host ''
  Write-Host 'Рамис хочет видеть, где ты застрял, чтобы помочь. Для этого после занятия можно отправлять КРАТКИЙ итог:'
  Write-Host 'номер урока, сколько раз застрял, какие ошибки (без путей и ключей). Кода и твоих файлов в нём нет.'
  $answer = Read-Host 'Отправлять итог Рамису? [y/N]'
  if ($answer -match '^(y|д)') { $Share = 'yes' } else { $Share = 'no' }
}

# ---------- 4. Плагины и MCP ----------
$ClaudeAvailable = Test-Command 'claude'

function Install-Plugin([string]$MarketplaceName, [string]$MarketplaceSrc, [string]$Plugin) {
  $id = "$Plugin@$MarketplaceName"
  if ($ClaudeAvailable) {
    $installed = (claude plugin list 2>$null) -join "`n"
    if ($installed -match [regex]::Escape($id)) { Add-Report 'ok' "Плагин $Plugin" 'уже установлен'; return }
    if (-not $DryRun) {
      claude plugin marketplace add $MarketplaceSrc 2>&1 | Out-Null
      claude plugin install $id 2>&1 | Out-Null
    }
    if ($DryRun -or $LASTEXITCODE -eq 0) { Add-Report 'done' "Плагин $Plugin" 'установлен через claude plugin install'; return }
  }
  $result = Invoke-Setup @('--marketplace', $MarketplaceName, '--enable', $id)
  if ($result.Ok) { Add-Report 'done' "Плагин $Plugin" 'включён в настройках, скачается при следующем запуске Claude' }
  else { Add-Report 'fail' "Плагин $Plugin" $result.Output }
}

function Install-Mcp([string]$McpName, [string[]]$McpCommand) {
  if ($ClaudeAvailable) {
    claude mcp get $McpName 2>&1 | Out-Null
    if ($LASTEXITCODE -eq 0) { Add-Report 'ok' "MCP $McpName" 'уже подключён'; return }
    if (-not $DryRun) {
      claude mcp add --scope user $McpName -- cmd /c @McpCommand 2>&1 | Out-Null
      if ($LASTEXITCODE -eq 0) { Add-Report 'done' "MCP $McpName" 'подключён'; return }
    }
  }
  $result = Invoke-Setup @('--mcp', $McpName)
  if ($result.Ok) { Add-Report 'done' "MCP $McpName" 'добавлен в .claude.json' }
  else { Add-Report 'fail' "MCP $McpName" $result.Output }
}

if (-not $SkipThirdParty) {
  Install-Plugin 'claude-plugins-official' 'anthropics/claude-plugins-official' 'superpowers'
  Install-Plugin 'thedotmack' 'thedotmack/claude-mem' 'claude-mem'
  Install-Plugin 'ecc' 'affaan-m/ECC' 'ecc'
  Install-Mcp 'context7' @('npx', '-y', '@upstash/context7-mcp')
  Install-Mcp 'playwright' @('npx', '@playwright/mcp@latest')
}
Install-Plugin 'ii-ramis' $MarketplaceSource 'ii-ramis'

# ---------- 5. Настройки: режим без вопросов, автообновление, согласие ----------
$setupArgs = @('--bypass', '--marketplace', 'ii-ramis', '--auto-update', 'ii-ramis')
if ($Share) { $setupArgs += @('--share', $Share) }
if ($Name) { $setupArgs += @('--student-name', $Name) }
$settingsResult = Invoke-Setup $setupArgs
if ($settingsResult.Ok) { Add-Report 'done' 'Настройки Claude' $settingsResult.Output }
else { Add-Report 'fail' 'Настройки Claude' $settingsResult.Output }

# ---------- 6. Итог ----------
Write-Host ''
Write-Host '===== Что сделано ====='
$hasFail = $false
foreach ($item in $Report) {
  $mark = switch ($item.Status) {
    'ok' { '[уже было]' }
    'done' { '[сделано]' }
    'skip' { '[пропущено]' }
    'need' { '[нужно от тебя]' }
    'fail' { '[не вышло]'; $hasFail = $true }
  }
  Write-Host "$mark $($item.What): $($item.Detail)"
}
Write-Host ''
Write-Host 'Дальше: полностью закрой Claude (и в трее) и открой заново, затем напиши в чате «привет». Если что-то не вышло, скажи об этом ИИ Рамису в чате.'
Write-Host 'Включить режим «без вопросов» в приложении: Settings > Code > «Allow bypass permissions mode».'
if ($hasFail) { exit 1 }
