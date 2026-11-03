# Набор урока 5: проверка и установка (Mac и Windows)

Два готовых блока на каждую систему: **проверка** (только читает, ничего не меняет) и **установка** (ставит только то, чего нет, повторный запуск ничего не ломает и не дублирует). Запускай блок целиком одной командой. Версии и коммиты закреплены (`skills@1.7.6`, `@playwright/mcp@0.0.84`, Agent Reach `v1.6.1` с SHA-256, навыки на проверенных коммитах), потому что проверены 03.11.2026: не заменяй их на `@latest` и на ветку `main`.

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

Источники закреплены на проверенных коммитах: репозиторий клонируется, переключается на этот коммит и ставится из этой папки, поэтому ставится ровно то, что проверено. Agent Reach скачивается и сверяется по контрольной сумме SHA-256. Если нужного `uv` нет, блок его не ставит сам: см. раздел «Если нет uv».

```bash install-mac
export DISABLE_TELEMETRY=1 DO_NOT_TRACK=1
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
SKILLS_CLI="skills@1.7.6"
AR_URL="https://github.com/Panniantong/Agent-Reach/releases/download/v1.6.1/agent-reach.zip"
AR_SHA256="51443d733bcb26064262442083a8f8abf6ba5e3e7df54beebafe98c88be04a60"
WORK="$(mktemp -d)" || exit 1
LOG="$WORK/log.txt"
trap '[ -n "$WORK" ] && rm -rf "$WORK"' EXIT
has_skill() { for d in "$HOME/.claude/skills/$1" "$HOME/.claude/skills/synced"/*/"$1"; do [ -f "$d/SKILL.md" ] && return 0; done; return 1; }
has_plugin() { claude plugin list --json 2>/dev/null | grep -q "\"id\": \"$1@"; }
MCPS="$(node -e "const fs=require('fs'),os=require('os');let n=[];try{const j=JSON.parse(fs.readFileSync(os.homedir()+'/.claude.json','utf8'));n=Object.keys(j.mcpServers||{});for(const p of Object.values(j.projects||{}))n.push(...Object.keys(p.mcpServers||{}))}catch(e){}console.log(n.join(' '))" 2>/dev/null)"
has_mcp() { case " $MCPS " in *" $1 "*) return 0;; esac; return 1; }
FAILS=0
ok()    { echo "уже стоит: $1"; }
done_() { echo "поставил: $1"; }
fail()  { echo "НЕ ПОСТАВИЛОСЬ: $1 ($2)"; tail -n 3 "$LOG" 2>/dev/null | sed 's/^/    /'; FAILS=$((FAILS+1)); }

skill_pinned() { # репозиторий, коммит, имя навыка
  if has_skill "$3"; then ok "$3"; return; fi
  : >"$LOG"
  git clone -q "https://github.com/$1.git" "$WORK/$3" >>"$LOG" 2>&1 && git -C "$WORK/$3" checkout -q "$2" >>"$LOG" 2>&1 \
    && npx --yes "$SKILLS_CLI" add "$WORK/$3" --skill "$3" -g -a claude-code -y --copy >>"$LOG" 2>&1
  if has_skill "$3"; then done_ "$3"; else fail "$3" "нужны git и Node 22.20 или новее"; fi
}

skill_pinned vercel-labs/skills 7a5e920bead4b1039a6d6df5d7e1163b7b09423a find-skills
skill_pinned emilkowalski/skills f1090bec277140d02ed202440185ad9d02ac1490 emil-design-eng
skill_pinned pbakaus/impeccable 9fadc41729c38fd47d7ae622b501558653f9d2e9 impeccable
skill_pinned blader/humanizer 0ef9fe5bc3572734fd3ae6c448fe00a30cd5dcf0 humanizer

if has_plugin superpowers; then ok superpowers
elif ! command -v claude >/dev/null; then fail superpowers "команда claude не найдена"
else
  : >"$LOG"
  claude plugin marketplace add anthropics/claude-plugins-official >>"$LOG" 2>&1
  claude plugin install superpowers@claude-plugins-official >>"$LOG" 2>&1
  if has_plugin superpowers; then done_ superpowers; else fail superpowers "claude plugin install superpowers@claude-plugins-official"; fi
fi

if has_mcp playwright || has_plugin playwright; then ok playwright
elif ! command -v claude >/dev/null; then fail playwright "команда claude не найдена"
else
  : >"$LOG"
  claude mcp add --scope user playwright -- npx @playwright/mcp@0.0.84 >>"$LOG" 2>&1
  if claude mcp list 2>/dev/null | grep -q "^playwright:"; then done_ playwright; else fail playwright "claude mcp add playwright"; fi
fi

ar_ready() { has_skill agent-reach && agent-reach version 2>/dev/null | grep -q '"ok": true'; }
if ar_ready; then ok agent-reach
elif ! command -v uv >/dev/null; then echo "ЖДЁТ uv: agent-reach (скажи ученику и поставь uv отдельно, см. «Если нет uv»)"; FAILS=$((FAILS+1))
else
  : >"$LOG"
  curl -fsSL -o "$WORK/ar.zip" "$AR_URL" >>"$LOG" 2>&1
  if [ "$(shasum -a 256 "$WORK/ar.zip" 2>/dev/null | cut -d' ' -f1)" = "$AR_SHA256" ]; then
    uv tool install --force "$WORK/ar.zip" >>"$LOG" 2>&1 && agent-reach setup >>"$LOG" 2>&1
  else
    echo "контрольная сумма Agent Reach не совпала, не ставлю" >>"$LOG"
  fi
  if ar_ready; then done_ agent-reach; else fail agent-reach "uv tool install из релиза v1.6.1"; fi
fi

has_mcp 21st || has_mcp 21st-magic || has_mcp magic || echo "ждёт ключ: 21st (см. klyuch-21st.md)"
mkdir -p "$HOME/.ii-ramis"
PREV="$(grep -o '"tries": *[0-9]*' "$HOME/.ii-ramis/nabor.json" 2>/dev/null | grep -o '[0-9]*$')"
if [ "$FAILS" -eq 0 ]; then STATUS=ok; else STATUS=partial; fi
printf '{"kit":"2.4.0","lesson":5,"status":"%s","tries":%s}\n' "$STATUS" "$(( ${PREV:-0} + 1 ))" > "$HOME/.ii-ramis/nabor.json"
echo "ошибок: $FAILS"
```

После установки навыкам нужна новая сессия (или `/reload-plugins` для плагинов): текущая сессия новые навыки не подхватит.

`superpowers` ставится из маркетплейса Anthropic `claude-plugins-official`, где коммит плагина закреплён самим маркетплейсом. Humanizer ставится как навык (не как плагин из чужого маркетплейса), чтобы не получить чужие хуки и автообновление. Временная папка с клонами удаляется при выходе, файл `nabor.json` хранит статус и число попыток (`status: partial` и `tries` от 3 значит: сам больше не повторяй, только по просьбе ученика).

## Если нет uv

`uv` — маленький установщик Python-программ, нужен для Agent Reach. Блок его **не ставит сам**: скажи ученику «ставлю uv, это маленький установщик, пароль не нужен» и поставь официальным способом: Mac `brew install uv`, Windows `winget install --id astral-sh.uv -e`. Нет `brew`: объясни и предложи официальный установщик с сайта astral.sh. Потом запусти блок установки ещё раз.

## Windows: проверка

Запускай в PowerShell. Ничего не меняет. (Не проверено на реальной Windows: см. README.)

```powershell check-win
function Has-Skill($n) { (Test-Path -LiteralPath "$HOME\.claude\skills\$n\SKILL.md") -or (@(Get-ChildItem "$HOME\.claude\skills\synced\*\$n\SKILL.md" -ErrorAction SilentlyContinue).Count -gt 0) }
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

То же, что на Mac: закреплённые коммиты, SHA-256 для Agent Reach, `uv` блок сам не ставит. (Не проверено на реальной Windows.)

```powershell install-win
$env:DISABLE_TELEMETRY = '1'; $env:DO_NOT_TRACK = '1'
$env:Path = [Environment]::GetEnvironmentVariable('Path','User') + ';' + [Environment]::GetEnvironmentVariable('Path','Machine') + ";$HOME\.local\bin"
$SkillsCli = 'skills@1.7.6'
$ArUrl = 'https://github.com/Panniantong/Agent-Reach/releases/download/v1.6.1/agent-reach.zip'
$ArSha256 = '51443d733bcb26064262442083a8f8abf6ba5e3e7df54beebafe98c88be04a60'
$Work = Join-Path ([IO.Path]::GetTempPath()) ('ii-ramis-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force $Work | Out-Null
function Has-Skill($n) { (Test-Path -LiteralPath "$HOME\.claude\skills\$n\SKILL.md") -or (@(Get-ChildItem -Path "$HOME\.claude\skills\synced\*\$n\SKILL.md" -ErrorAction SilentlyContinue).Count -gt 0) }
function Has-Plugin($n) { ((claude plugin list --json 2>$null) -join "`n") -match ('"id": "' + [regex]::Escape($n) + '@') }
function Get-McpNames { $m = @(); try { $c = Get-Content -LiteralPath "$HOME\.claude.json" -Raw | ConvertFrom-Json; if ($c.mcpServers) { $m += $c.mcpServers.PSObject.Properties.Name }; foreach ($p in $c.projects.PSObject.Properties) { if ($p.Value.mcpServers) { $m += $p.Value.mcpServers.PSObject.Properties.Name } } } catch {}; $m }
$script:Fails = 0
function Ok($n) { "уже стоит: $n" }
function Done($n) { "поставил: $n" }
function Fail($n, $why) { "НЕ ПОСТАВИЛОСЬ: $n ($why)"; $script:Fails++ }

function Skill-Pinned($repo, $sha, $name) {
  if (Has-Skill $name) { Ok $name; return }
  $dir = Join-Path $Work $name
  git clone -q "https://github.com/$repo.git" $dir *> $null
  git -C $dir checkout -q $sha *> $null
  npx.cmd --yes $SkillsCli add $dir --skill $name -g -a claude-code -y --copy *> $null
  if (Has-Skill $name) { Done $name } else { Fail $name 'нужны git и Node 22.20 или новее' }
}

Skill-Pinned 'vercel-labs/skills' '7a5e920bead4b1039a6d6df5d7e1163b7b09423a' 'find-skills'
Skill-Pinned 'emilkowalski/skills' 'f1090bec277140d02ed202440185ad9d02ac1490' 'emil-design-eng'
Skill-Pinned 'pbakaus/impeccable' '9fadc41729c38fd47d7ae622b501558653f9d2e9' 'impeccable'
Skill-Pinned 'blader/humanizer' '0ef9fe5bc3572734fd3ae6c448fe00a30cd5dcf0' 'humanizer'

if (Has-Plugin 'superpowers') { Ok 'superpowers' }
elseif (-not (Get-Command claude -ErrorAction SilentlyContinue)) { Fail 'superpowers' 'команда claude не найдена' }
else {
  claude plugin marketplace add anthropics/claude-plugins-official *> $null
  claude plugin install superpowers@claude-plugins-official *> $null
  if (Has-Plugin 'superpowers') { Done 'superpowers' } else { Fail 'superpowers' 'claude plugin install superpowers@claude-plugins-official' }
}

if (((Get-McpNames) -contains 'playwright') -or (Has-Plugin 'playwright')) { Ok 'playwright' }
elseif (-not (Get-Command claude -ErrorAction SilentlyContinue)) { Fail 'playwright' 'команда claude не найдена' }
else {
  claude mcp add --scope user playwright -- npx.cmd '@playwright/mcp@0.0.84' *> $null
  if ((Get-McpNames) -contains 'playwright') { Done 'playwright' } else { Fail 'playwright' 'claude mcp add playwright' }
}

function Ar-Ready { (Has-Skill 'agent-reach') -and ((Get-Command agent-reach -ErrorAction SilentlyContinue) -and (((agent-reach version 2>$null) -join '') -match '"ok": true')) }
if (Ar-Ready) { Ok 'agent-reach' }
elseif (-not (Get-Command uv -ErrorAction SilentlyContinue)) { 'ЖДЁТ uv: agent-reach (скажи ученику и поставь uv отдельно, см. «Если нет uv»)'; $script:Fails++ }
else {
  $zip = Join-Path $Work 'ar.zip'
  Invoke-WebRequest -Uri $ArUrl -OutFile $zip
  if ((Get-FileHash -Algorithm SHA256 -LiteralPath $zip).Hash.ToLower() -eq $ArSha256) { uv tool install --force $zip *> $null; agent-reach setup *> $null }
  if (Ar-Ready) { Done 'agent-reach' } else { Fail 'agent-reach' 'uv tool install из релиза v1.6.1 или не совпала контрольная сумма' }
}

$names = Get-McpNames
if (-not (($names -contains '21st') -or ($names -contains '21st-magic') -or ($names -contains 'magic'))) { 'ждёт ключ: 21st (см. klyuch-21st.md)' }
New-Item -ItemType Directory -Force "$HOME\.ii-ramis" | Out-Null
$prev = 0; try { $prev = [int](Get-Content -LiteralPath "$HOME\.ii-ramis\nabor.json" -Raw | ConvertFrom-Json).tries } catch {}
$status = if ($script:Fails -eq 0) { 'ok' } else { 'partial' }
('{"kit":"2.4.0","lesson":5,"status":"' + $status + '","tries":' + ($prev + 1) + '}') | Set-Content -LiteralPath "$HOME\.ii-ramis\nabor.json"
Remove-Item -LiteralPath $Work -Recurse -Force -ErrorAction SilentlyContinue
"ошибок: $($script:Fails)"
```

## Если `claude` не найден в PATH

Плагины (superpowers, humanizer) тогда ставятся через интерфейс: Claude Desktop, вкладка Code, кнопка «+» у поля ввода → Manage plugins → найти `superpowers` (маркетплейс `claude-plugins-official`) и Install; для humanizer сначала добавить маркетплейс `blader/humanizer`. Навыки через `npx` на `claude` не завязаны, а `claude mcp add` без него не выполнить: скажи честно.

## Сколько это занимает и весит

Установка 1–3 минуты, один раз. На диске около 180 МБ, почти всё это Agent Reach (140 МБ, из них yt-dlp и bili-cli). Playwright при первом использовании докачивает браузер Chromium (около 200 МБ), это нормально: предупреди ученика словами «докачаю браузер для проверок».
