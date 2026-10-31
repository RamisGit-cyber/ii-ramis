# Проверка компьютера ученика (Windows, PowerShell). Ничего не меняет, только печатает понятный отчёт.
# Использование: powershell -ExecutionPolicy Bypass -File diagnose.ps1 [-ProjectDir папка]
param([string]$ProjectDir = (Get-Location).Path)

$ErrorActionPreference = 'Continue'
$Here = $PSScriptRoot
$KursMap = Join-Path $Here '..\skills\ii-ramis\references\kurs-karta.md'
$ClaudeHome = if ($env:CLAUDE_CONFIG_DIR) { $env:CLAUDE_CONFIG_DIR } else { Join-Path $env:USERPROFILE '.claude' }
$DataDir = if ($env:IIRAMIS_HOME) { $env:IIRAMIS_HOME } else { Join-Path $env:USERPROFILE '.ii-ramis' }
$Config = Join-Path $DataDir 'config.json'

function Test-Command([string]$CommandName) { return [bool](Get-Command $CommandName -ErrorAction SilentlyContinue) }
function Write-Ok([string]$Text) { Write-Host "  [ок]       $Text" }
function Write-Warn([string]$Text) { Write-Host "  [внимание] $Text" }
function Write-Bad([string]$Text) { Write-Host "  [нет]      $Text" }
function Write-Head([string]$Text) { Write-Host ''; Write-Host "== $Text ==" }

Write-Host "ИИ Рамис: проверка компьютера (Windows $([Environment]::OSVersion.Version))"

Write-Head 'Основные инструменты'
if (Test-Command 'git') { Write-Ok ("Git: " + ((git --version) -join ' ')) } else { Write-Bad 'Git не найден. Поставит ИИ Рамис: winget install Git.Git' }
if (Test-Command 'node') { Write-Ok ("Node.js: " + ((node --version) -join ' ')) } else { Write-Bad 'Node.js не найден (нужен для сайтов и защитных хуков). Поставит ИИ Рамис: winget install OpenJS.NodeJS.LTS' }
if (Test-Command 'python') { Write-Ok ("Python: " + ((python --version 2>&1) -join ' ')) } else { Write-Warn 'Python не найден (не обязателен для урока 4)' }
if (Test-Command 'winget') { Write-Ok 'winget (установщик программ): есть' } else { Write-Warn 'winget нет: программы придётся ставить с сайтов' }
if (Test-Command 'gh') {
  Write-Ok ("GitHub CLI: " + ((gh --version | Select-Object -First 1) -join ' '))
  gh auth status 2>$null | Out-Null
  if ($LASTEXITCODE -eq 0) { Write-Ok 'Вход в GitHub: выполнен' } else { Write-Warn 'В GitHub не вошли. Нужно один раз в браузере: gh auth login' }
} else { Write-Warn 'GitHub CLI (gh) не найден' }

Write-Head 'Claude'
if (Test-Command 'claude') { Write-Ok ("Claude Code (терминал): " + ((claude --version 2>$null) -join ' ')) }
else { Write-Ok 'Команды claude в терминале нет: это нормально, если работаешь во вкладке Code приложения Claude Desktop' }

Write-Head 'Плагины пакета'
$settingsPath = Join-Path $ClaudeHome 'settings.json'
foreach ($id in @('ii-ramis@ii-ramis', 'superpowers@claude-plugins-official', 'claude-mem@thedotmack', 'ecc@ecc')) {
  $found = $false
  if (Test-Command 'claude') { if (((claude plugin list 2>$null) -join "`n") -match [regex]::Escape($id)) { $found = $true } }
  if (-not $found -and (Test-Path $settingsPath)) { if ((Get-Content $settingsPath -Raw) -match ('"' + [regex]::Escape($id) + '":\s*true')) { $found = $true } }
  if ($found) { Write-Ok $id } else { Write-Bad "$id не установлен" }
}

Write-Head 'Подключения (MCP)'
$mcpPath = Join-Path $env:USERPROFILE '.claude.json'
foreach ($name in @('context7', 'playwright')) {
  $found = $false
  if (Test-Command 'claude') { claude mcp get $name 2>&1 | Out-Null; if ($LASTEXITCODE -eq 0) { $found = $true } }
  if (-not $found -and (Test-Path $mcpPath)) { if ((Get-Content $mcpPath -Raw) -match ('"' + [regex]::Escape($name) + '"')) { $found = $true } }
  if ($found) { Write-Ok $name } else { Write-Bad "$name не подключён" }
}

Write-Head 'Сохранения (Git) в этой папке'
Push-Location $ProjectDir
git rev-parse --git-dir 2>$null | Out-Null
if ($LASTEXITCODE -eq 0) {
  Write-Ok ("Папка под Git: " + ((git log --oneline 2>$null | Measure-Object).Count) + ' сохранений')
  if (Test-Path '.gitignore') { Write-Ok '.gitignore есть' } else { Write-Warn '.gitignore нет' }
  if (Test-Path '.env') {
    git check-ignore -q .env
    if ($LASTEXITCODE -eq 0) { Write-Ok '.env спрятан от Git' } else { Write-Bad '.env НЕ спрятан от Git: ключи могут утечь в облако' }
  }
} else { Write-Warn 'Эта папка не под Git (нет сохранений как в игре)' }
Pop-Location

Write-Head 'Домашка по пройденным урокам'
$lesson = $null
if (Test-Path $Config) {
  $match = [regex]::Match((Get-Content $Config -Raw), '"lesson":\s*(\d+)')
  if ($match.Success) { $lesson = [int]$match.Groups[1].Value }
}
if ($null -eq $lesson) {
  Write-Warn 'Номер пройденного урока неизвестен: спроси ученика и запиши (config.mjs set lesson N)'
} elseif (-not (Test-Path $KursMap)) {
  Write-Warn 'Не нашёл kurs-karta.md'
} else {
  Write-Host "  Пройдено уроков: $lesson. Проверь каждый пункт (команду запускай сам, остальное спроси одним вопросом):"
  $current = 0; $inList = $false
  foreach ($line in (Get-Content $KursMap -Encoding UTF8)) {
    if ($line -match '^## Урок (\d+)') { $current = [int]$Matches[1]; $inList = $false; if ($current -le $lesson) { Write-Host "  Урок ${current}:" }; continue }
    if ($line -match '^### Чек-лист наставника') { $inList = $true; continue }
    if ($line -match '^#') { $inList = $false }
    if ($inList -and $current -le $lesson -and $line -match '^- \[ \] (.*)') { Write-Host "    - $($Matches[1])" }
  }
}
Write-Host ''
Write-Host 'Готово. Недостающее ИИ Рамис ставит сам и объясняет простыми словами.'
