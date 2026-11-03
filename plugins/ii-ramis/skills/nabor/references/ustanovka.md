# Набор урока 5: проверка и установка (Mac и Windows)

Два готовых блока на каждую систему: **проверка** (только читает, ничего не меняет) и **установка** (ставит только то, чего нет, повторный запуск ничего не ломает и не дублирует). Запускай блок целиком одной командой. Версии закреплены (`skills@1.7.6`, `@playwright/mcp@0.0.84`, Agent Reach `v1.6.1`), потому что проверены 03.11.2026: не заменяй их на `@latest`.

Правила для обоих блоков:
- ответ на «есть ли X» даёт только блок проверки (диск и список плагинов), не память и не файл `~/.ii-ramis/nabor.json`;
- ключ 21st в блоках не участвует: см. `klyuch-21st.md`;
- в `~/.claude/settings.json` блоки ничего не пишут сами (плагины регистрирует `claude plugin`), разрешения и режим «без вопросов» не трогают;
- переменные `DISABLE_TELEMETRY=1` и `DO_NOT_TRACK=1` выставлены, чтобы установщик навыков не слал статистику.

## Mac: проверка

```bash check-mac
has_skill() { for d in "$HOME/.claude/skills/$1" "$HOME/.claude/skills/synced"/*/"$1"; do [ -f "$d/SKILL.md" ] && return 0; done; return 1; }
PLUGINS="$(claude plugin list --json 2>/dev/null)"
has_plugin() { printf '%s' "$PLUGINS" | grep -q "\"id\": \"$1@"; }
MCPS="$(node -e "const fs=require('fs'),os=require('os');let n=[];try{const j=JSON.parse(fs.readFileSync(os.homedir()+'/.claude.json','utf8'));n=Object.keys(j.mcpServers||{});for(const p of Object.values(j.projects||{}))n.push(...Object.keys(p.mcpServers||{}))}catch(e){}console.log(n.join(' '))" 2>/dev/null)"
has_mcp() { case " $MCPS " in *" $1 "*) return 0;; esac; return 1; }
show() { name="$1"; shift; if "$@"; then echo "$name: есть"; else echo "$name: НЕТ"; fi; }
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
command -v claude >/dev/null || echo "claude: НЕ НАЙДЕН в PATH (плагины проверить нельзя)"
show find-skills has_skill find-skills
show emil-design-eng has_skill emil-design-eng
show impeccable has_skill impeccable
show agent-reach has_skill agent-reach
echo "agent-reach работает: $(agent-reach version 2>/dev/null | head -c 160)"
show superpowers has_plugin superpowers
if has_skill humanizer || has_plugin humanizer; then echo "humanizer: есть"; else echo "humanizer: НЕТ"; fi
if has_mcp playwright || has_plugin playwright; then echo "playwright: есть"; else echo "playwright: НЕТ"; fi
if has_mcp 21st || has_mcp 21st-magic || has_mcp magic; then echo "21st: подключён (ключ не показываю)"; else echo "21st: НЕТ (нужен личный ключ)"; fi
```

Humanizer считается установленным, если есть навык или плагин; Playwright — если есть MCP или плагин. Версия Agent Reach 1.5 и старше считается НЕ установленной (нужна 1.6+: она печатает JSON с `"ok": true`).

## Mac: установка

```bash install-mac
export DISABLE_TELEMETRY=1 DO_NOT_TRACK=1
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
SKILLS_CLI="skills@1.7.6"
AR_ZIP="https://github.com/Panniantong/Agent-Reach/releases/download/v1.6.1/agent-reach.zip"
has_skill() { for d in "$HOME/.claude/skills/$1" "$HOME/.claude/skills/synced"/*/"$1"; do [ -f "$d/SKILL.md" ] && return 0; done; return 1; }
has_plugin() { claude plugin list --json 2>/dev/null | grep -q "\"id\": \"$1@"; }
MCPS="$(node -e "const fs=require('fs'),os=require('os');let n=[];try{const j=JSON.parse(fs.readFileSync(os.homedir()+'/.claude.json','utf8'));n=Object.keys(j.mcpServers||{});for(const p of Object.values(j.projects||{}))n.push(...Object.keys(p.mcpServers||{}))}catch(e){}console.log(n.join(' '))" 2>/dev/null)"
has_mcp() { case " $MCPS " in *" $1 "*) return 0;; esac; return 1; }
FAILS=0
ok()    { echo "уже стоит: $1"; }
done_() { echo "поставил: $1"; }
fail()  { echo "НЕ ПОСТАВИЛОСЬ: $1 ($2)"; FAILS=$((FAILS+1)); }

skill_via_npx() { # репозиторий, имя навыка
  if has_skill "$2"; then ok "$2"; return; fi
  npx --yes "$SKILLS_CLI" add "$1" --skill "$2" -g -a claude-code -y --copy >/dev/null 2>&1
  if has_skill "$2"; then done_ "$2"; else fail "$2" "npx skills add $1; нужен Node 22.20 или новее"; fi
}
plugin_via_claude() { # источник маркетплейса, имя маркетплейса, плагин
  if has_plugin "$3"; then ok "$3"; return; fi
  command -v claude >/dev/null || { fail "$3" "команда claude не найдена"; return; }
  claude plugin marketplace add "$1" >/dev/null 2>&1
  claude plugin install "$3@$2" >/dev/null 2>&1
  if has_plugin "$3"; then done_ "$3"; else fail "$3" "claude plugin install $3@$2"; fi
}

skill_via_npx vercel-labs/skills find-skills
skill_via_npx emilkowalski/skills emil-design-eng
skill_via_npx pbakaus/impeccable impeccable
plugin_via_claude anthropics/claude-plugins-official claude-plugins-official superpowers

if has_skill humanizer || has_plugin humanizer; then ok humanizer; else plugin_via_claude blader/humanizer humanizer humanizer; fi

if has_mcp playwright || has_plugin playwright; then ok playwright
else
  claude mcp add --scope user playwright -- npx @playwright/mcp@0.0.84 >/dev/null 2>&1
  if claude mcp list 2>/dev/null | grep -q "^playwright:"; then done_ playwright; else fail playwright "claude mcp add playwright"; fi
fi

ar_ready() { has_skill agent-reach && agent-reach version 2>/dev/null | grep -q '"ok": true'; }
if ar_ready; then ok agent-reach
else
  command -v uv >/dev/null || { command -v brew >/dev/null && brew install uv >/dev/null 2>&1; }
  if command -v uv >/dev/null; then
    uv tool install --force "$AR_ZIP" >/dev/null 2>&1 && agent-reach setup >/dev/null 2>&1
  fi
  if ar_ready; then done_ agent-reach; else fail agent-reach "нужен uv (brew install uv); версия 1.5 и старше не годится"; fi
fi

has_mcp 21st || has_mcp 21st-magic || has_mcp magic || echo "ждёт ключ: 21st (см. klyuch-21st.md)"
if [ "$FAILS" -eq 0 ]; then
  mkdir -p "$HOME/.ii-ramis" && printf '{"kit":"2.4.0","lesson":5}\n' > "$HOME/.ii-ramis/nabor.json"
fi
echo "ошибок: $FAILS"
```

После установки навыкам нужна новая сессия (или `/reload-plugins` для плагинов): текущая сессия новые навыки не подхватит.

## Windows: проверка

Запускай в PowerShell. Ничего не меняет. (Не проверено на реальной Windows: см. README.)

```powershell check-win
function Has-Skill($n) { (Test-Path "$HOME\.claude\skills\$n\SKILL.md") -or (@(Get-ChildItem "$HOME\.claude\skills\synced\*\$n\SKILL.md" -ErrorAction SilentlyContinue).Count -gt 0) }
$plugins = (claude plugin list --json 2>$null) -join "`n"
function Has-Plugin($n) { $plugins -match ('"id": "' + [regex]::Escape($n) + '@') }
$mcps = @()
try { $cfg = Get-Content "$HOME\.claude.json" -Raw | ConvertFrom-Json; if ($cfg.mcpServers) { $mcps += $cfg.mcpServers.PSObject.Properties.Name }; foreach ($p in $cfg.projects.PSObject.Properties) { if ($p.Value.mcpServers) { $mcps += $p.Value.mcpServers.PSObject.Properties.Name } } } catch {}
function Show($n, $yes) { if ($yes) { "${n}: есть" } else { "${n}: НЕТ" } }
if (-not (Get-Command claude -ErrorAction SilentlyContinue)) { "claude: НЕ НАЙДЕН в PATH (плагины проверить нельзя)" }
Show 'find-skills' (Has-Skill 'find-skills')
Show 'emil-design-eng' (Has-Skill 'emil-design-eng')
Show 'impeccable' (Has-Skill 'impeccable')
Show 'agent-reach' (Has-Skill 'agent-reach')
Show 'superpowers' (Has-Plugin 'superpowers')
Show 'humanizer' ((Has-Skill 'humanizer') -or (Has-Plugin 'humanizer'))
Show 'playwright' (($mcps -contains 'playwright') -or (Has-Plugin 'playwright'))
if (($mcps -contains '21st') -or ($mcps -contains '21st-magic') -or ($mcps -contains 'magic')) { "21st: подключён (ключ не показываю)" } else { "21st: НЕТ (нужен личный ключ)" }
```

## Windows: установка

```powershell install-win
$env:DISABLE_TELEMETRY = '1'; $env:DO_NOT_TRACK = '1'
$env:Path = [Environment]::GetEnvironmentVariable('Path','User') + ';' + [Environment]::GetEnvironmentVariable('Path','Machine') + ";$HOME\.local\bin"
$SkillsCli = 'skills@1.7.6'
$ArZip = 'https://github.com/Panniantong/Agent-Reach/releases/download/v1.6.1/agent-reach.zip'
function Has-Skill($n) { (Test-Path "$HOME\.claude\skills\$n\SKILL.md") -or (@(Get-ChildItem "$HOME\.claude\skills\synced\*\$n\SKILL.md" -ErrorAction SilentlyContinue).Count -gt 0) }
function Has-Plugin($n) { ((claude plugin list --json 2>$null) -join "`n") -match ('"id": "' + [regex]::Escape($n) + '@') }
function Get-McpNames { $m = @(); try { $c = Get-Content "$HOME\.claude.json" -Raw | ConvertFrom-Json; if ($c.mcpServers) { $m += $c.mcpServers.PSObject.Properties.Name }; foreach ($p in $c.projects.PSObject.Properties) { if ($p.Value.mcpServers) { $m += $p.Value.mcpServers.PSObject.Properties.Name } } } catch {}; $m }
$script:Fails = 0
function Ok($n) { "уже стоит: $n" }
function Done($n) { "поставил: $n" }
function Fail($n, $why) { "НЕ ПОСТАВИЛОСЬ: $n ($why)"; $script:Fails++ }

function Skill-ViaNpx($repo, $name) {
  if (Has-Skill $name) { Ok $name; return }
  npx.cmd --yes $SkillsCli add $repo --skill $name -g -a claude-code -y --copy *> $null
  if (Has-Skill $name) { Done $name } else { Fail $name "npx skills add $repo; нужен Node 22.20 или новее" }
}
function Plugin-ViaClaude($source, $marketplace, $plugin) {
  if (Has-Plugin $plugin) { Ok $plugin; return }
  if (-not (Get-Command claude -ErrorAction SilentlyContinue)) { Fail $plugin 'команда claude не найдена'; return }
  claude plugin marketplace add $source *> $null
  claude plugin install "$plugin@$marketplace" *> $null
  if (Has-Plugin $plugin) { Done $plugin } else { Fail $plugin "claude plugin install $plugin@$marketplace" }
}

Skill-ViaNpx 'vercel-labs/skills' 'find-skills'
Skill-ViaNpx 'emilkowalski/skills' 'emil-design-eng'
Skill-ViaNpx 'pbakaus/impeccable' 'impeccable'
Plugin-ViaClaude 'anthropics/claude-plugins-official' 'claude-plugins-official' 'superpowers'

if ((Has-Skill 'humanizer') -or (Has-Plugin 'humanizer')) { Ok 'humanizer' } else { Plugin-ViaClaude 'blader/humanizer' 'humanizer' 'humanizer' }

if (((Get-McpNames) -contains 'playwright') -or (Has-Plugin 'playwright')) { Ok 'playwright' }
else {
  claude mcp add --scope user playwright -- npx.cmd '@playwright/mcp@0.0.84' *> $null
  if ((Get-McpNames) -contains 'playwright') { Done 'playwright' } else { Fail 'playwright' 'claude mcp add playwright' }
}

function Ar-Ready { (Has-Skill 'agent-reach') -and ((Get-Command agent-reach -ErrorAction SilentlyContinue) -and ((agent-reach version 2>$null) -join '' ) -match '"ok": true') }
if (Ar-Ready) { Ok 'agent-reach' }
else {
  if (-not (Get-Command uv -ErrorAction SilentlyContinue)) { winget install --id astral-sh.uv -e --silent --accept-package-agreements --accept-source-agreements *> $null; $env:Path += ";$HOME\.local\bin" }
  if (Get-Command uv -ErrorAction SilentlyContinue) { uv tool install --force $ArZip *> $null; agent-reach setup *> $null }
  if (Ar-Ready) { Done 'agent-reach' } else { Fail 'agent-reach' 'нужен uv (winget install astral-sh.uv)' }
}

$names = Get-McpNames
if (-not (($names -contains '21st') -or ($names -contains '21st-magic') -or ($names -contains 'magic'))) { 'ждёт ключ: 21st (см. klyuch-21st.md)' }
if ($script:Fails -eq 0) { New-Item -ItemType Directory -Force "$HOME\.ii-ramis" *> $null; '{"kit":"2.4.0","lesson":5}' | Set-Content "$HOME\.ii-ramis\nabor.json" }
"ошибок: $($script:Fails)"
```

## Если `claude` не найден в PATH

Плагины (superpowers, humanizer) тогда ставятся через интерфейс: Claude Desktop, вкладка Code, кнопка «+» у поля ввода → Manage plugins → найти `superpowers` (маркетплейс `claude-plugins-official`) и Install; для humanizer сначала добавить маркетплейс `blader/humanizer`. Навыки через `npx` на `claude` не завязаны, а `claude mcp add` без него не выполнить: скажи честно.

## Сколько это занимает и весит

Установка 1–3 минуты, один раз. На диске около 180 МБ, почти всё это Agent Reach (140 МБ, из них yt-dlp и bili-cli). Playwright при первом использовании докачивает браузер Chromium (около 200 МБ), это нормально: предупреди ученика словами «докачаю браузер для проверок».
