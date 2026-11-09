# Набор урока 5: проверка и установка (Mac и Windows)

Два готовых блока на каждую систему: **проверка** (только читает, ничего не меняет) и **установка** (ставит только то, чего нет, повторный запуск ничего не ломает и не дублирует). Версии и коммиты закреплены (`skills@1.7.6`, `@playwright/mcp@0.0.84`, HyperFrames на коммите `b4cc674` (тег v0.9.19), Agent Reach `v1.6.1` с SHA-256, навыки на проверенных коммитах), потому что проверены 04.11.2026: не заменяй их на `@latest` и на ветку `main`.

**Mac: установку делает скрипт хука** `hooks/kit-install.sh` (он же единственный источник версий для Mac). Хук SessionStart приложение выполняет вне песочницы, поэтому он может писать в `~/.claude` и `~/.claude.json`, а команды Bash у Claude в Desktop на это права не имеют (см. раздел «Песочница» ниже). Windows: блоки PowerShell ниже, там песочницы для команд нет.

Правила для обоих блоков:
- ответ на «есть ли X» даёт только блок проверки (диск и список плагинов), не память и не файл `~/.ii-ramis/nabor.json`;
- ключ 21st в блоках не участвует: см. `klyuch-21st.md`;
- в `~/.claude/settings.json` блоки ничего не пишут сами (плагины регистрирует `claude plugin`), разрешения и режим «без вопросов» не трогают;
- переменные `DISABLE_TELEMETRY=1`, `DO_NOT_TRACK=1` и `HYPERFRAMES_NO_TELEMETRY=1` выставлены, чтобы установщики не слали статистику. Скрипт запускает `npx` из временной папки и берёт пакеты только с официального реестра npm (`NPM_CONFIG_REGISTRY`), чтобы чужой `.npmrc` в папке проекта не подменил источник.

## Песочница Claude Desktop: что можно, что нельзя

Проверено по документации Claude Code (code.claude.com/docs/en/sandboxing, /hooks, /plugins/security, 04.11.2026):
- Песочница оборачивает команды Bash. Писать им можно в рабочую папку, временную папку и добавленные папки. `~/.claude` (кроме нескольких мелочей) и `~/.claude.json` относятся к **защищённым путям**: запись туда запрещена, даже если добавить путь в `sandbox.filesystem.allowWrite`.
- Хуки плагинов, локальные MCP-серверы и служебные команды приложения выполняются **вне песочницы**, с обычными правами пользователя.
- Единственный официальный способ дать Bash-команде выйти за рамки — окно разрешения «Bash command (unsandboxed)»: Claude сам повторяет команду без песочницы, и ученик нажимает «разрешить». Выключать песочницу в настройках и менять `allowUnsandboxedCommands` не нужно и без просьбы ученика нельзя.

Поэтому, если установка через Bash пишет «Operation not permitted» или «Read-only file system»: не обходи (никаких `sudo`, правок `settings.json`, записи через другой путь). Скажи ученику: «Закрой приложение полностью и открой заново: набор поставит сам плагин при запуске, это не требует разрешений. Если я покажу окно «Bash command (unsandboxed)», нажми там «разрешить»: это нормально.»

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
show hyperframes has_skill hyperframes
show remotion has_skill remotion-best-practices
show gsap has_skill gsap-core
show security-audit has_skill security-audit
show apple-design has_skill apple-design
show ffmpeg-skill has_skill ffmpeg-skill
show teardown has_skill teardown
show anatomy has_skill anatomy
show gamedev-web has_skill phaser-core
show agent-reach has_skill agent-reach
echo "agent-reach работает: $(agent-reach version 2>/dev/null | head -c 160)"
show superpowers has_plugin superpowers
if has_skill humanizer || has_plugin humanizer; then echo "humanizer: есть"; else echo "humanizer: НЕТ"; fi
if has_mcp playwright || has_plugin playwright; then echo "playwright: есть"; else echo "playwright: НЕТ"; fi
if has_mcp 21st || has_mcp 21st-magic || has_mcp magic; then echo "21st: подключён (ключ не показываю)"; else echo "21st: НЕТ (нужен личный ключ)"; fi
if command -v ffmpeg >/dev/null; then echo "ffmpeg: есть"; else echo "ffmpeg: НЕТ (нужен для рендера видео HyperFrames и Remotion)"; fi
if command -v ffmpeg >/dev/null; then ffmpeg -hide_banner -filters 2>/dev/null | grep -qE ' (ass|subtitles) ' && echo "ffmpeg, субтитры: есть" || echo "ffmpeg, субтитры: НЕТ (без них монтаж не нарисует субтитры; нужен ffmpeg-full)"; fi
if [ -x "$HOME/.ii-ramis/earshot/bin/earshot" ] || command -v earshot >/dev/null; then echo "earshot: есть (по желанию)"; else echo "earshot: нет (по желанию, не обязателен)"; fi
echo "node: $(node -v 2>/dev/null || echo НЕТ)"
cat "$HOME/.ii-ramis/nabor.json" 2>/dev/null
```

Humanizer считается установленным, если есть навык или плагин; Playwright — если есть MCP или плагин. Версия Agent Reach 1.5 и старше считается НЕ установленной (нужна 1.6+: она печатает JSON с `"ok": true`).

## Mac: установка

Это обычно делает хук при старте сессии (`hooks/kit-install.sh --auto`, асинхронно). Вручную, когда ты в обычном терминале без песочницы или ученик разрешил окно «Bash command (unsandboxed)»:

```bash install-mac
bash "$(ls -d "$HOME"/.claude/plugins/cache/ii-ramis/ii-ramis/*/ | sort -V | tail -1)hooks/kit-install.sh" --run
```

Скрипт делает то же, что раньше делал блок: навыки ставятся из клона, переключённого на закреплённый коммит (репозиторий без символических ссылок), Agent Reach скачивается и сверяется по SHA-256, `uv` скрипт не ставит (см. «Если нет uv»). Что нового в 2.5:
- **HyperFrames** (HeyGen): основной набор из четырёх навыков (hyperframes, hyperframes-cli, hyperframes-registry, media-use) ставится из клона репозитория на закреплённом коммите `b4cc674` (тег v0.9.19), как остальные навыки. Собственный установщик HyperFrames (`hyperframes skills update`) НЕ используется: он тянет другую версию `skills` и ссылки на тег. Сам CLI `hyperframes` не ставится; при первом `npx hyperframes` статистика у него включена по умолчанию, поэтому ученику при работе с видео скажи про `HYPERFRAMES_NO_TELEMETRY=1` или `hyperframes telemetry disable`.
- **Remotion**: навыки репозитория `remotion-dev/skills` (13 штук, главный `remotion-best-practices`) на коммите `c7cb2fd`.
- Предварительные условия проверяются, но не ломают остальное: нет Node 22.20+ или git — навыки через `npx` честно пишутся как не поставленные, `superpowers` и `playwright` ставятся отдельно; нет `ffmpeg` — это не ошибка установки, скрипт записывает `ffmpeg` в `notes`. С 2.6: на Mac с Homebrew хук сам ставит Node (`brew install node`, только если Node нет совсем; старый Node молча не обновляется, а попадает в `notes`, и ИИ Рамис предлагает обновить с «да» ученика) и `ffmpeg` (`brew install ffmpeg`) без вопросов, это домашка урока 5; на Windows это делает блок ниже через `winget` (`OpenJS.NodeJS.LTS`, `Gyan.FFmpeg`).
- Состояние пишется в `~/.ii-ramis/nabor.json`: `status` (`installing`, `ok`, `partial`, `declined`), `tries`, `missing` (что не поставилось), `notes` (`ffmpeg`, `ffmpegsubs`, `python`, `uv`, `node`, `git`, `claude`, `21st`). Журнал последней установки: `~/.ii-ramis/nabor.log`.
- «Уже поставлено» — это `status: ok` с `kit` не ниже `2.7.0`: хук молчит и ничего не запускает. Отказ — `status: declined`: хук молчит, скрипт останавливается на следующем шаге. `II_RAMIS_NO_KIT=1` в окружении отключает хук совсем.

- **Новое в 2.7**: ffmpeg-skill (коммит `9bdb444`, v3.2.0, установщик автора из клона), Teardown (`a91262a`), Anatomy (`1482e84`, без `publish.mjs`), веб-движки игр и роутер (`19d93f9`). Mac: хук проверяет, что у `ffmpeg` есть фильтр субтитров (`ass`), и если нет, ставит `brew install ffmpeg-full` и делает его основным (`brew unlink ffmpeg`, `brew link --force ffmpeg-full`; при неудаче ссылка на `ffmpeg` возвращается). Не проверено на реальном Mac в плагине: сверяй вывод `ffmpeg -filters` после установки.

После установки навыкам нужна новая сессия (или `/reload-plugins` для плагинов): текущая сессия новые навыки не подхватит.

`superpowers` ставится из маркетплейса Anthropic `claude-plugins-official`, где коммит плагина закреплён самим маркетплейсом. Humanizer ставится как навык (не как плагин из чужого маркетплейса), чтобы не получить чужие хуки и автообновление. Временная папка с клонами удаляется при выходе. `status: partial` и `tries` от 3 значит: сам больше не повторяй, только по просьбе ученика.

### Что сказать про `notes`

- `ffmpeg`: «Для рендера видео (HyperFrames, Remotion) нужна программа ffmpeg, её у тебя пока нет. Если у тебя есть Homebrew, плагин поставит её сам при следующем запуске; если нет, скачай сборку для Mac с ffmpeg.org/download.html (раздел macOS) или скажи Рамису на уроке. Остальной набор от этого не зависит».
- `ffmpegsubs`: «У тебя стоит ffmpeg без субтитров (так бывает у обычной сборки Homebrew), монтаж не сможет нарисовать подписи. Нужна полная сборка: на Mac плагин ставит `ffmpeg-full` сам, если есть Homebrew (несколько минут); на Windows `winget install --id Gyan.FFmpeg -e` и перезапуск приложения».
- `python`: «Для видеоредактора ffmpeg-skill нужен Python 3.10 или новее: на Mac он ставится вместе с «инструментами разработчика», на Windows `winget install --id Python.Python.3.12 -e` (только после «да» ученика)».
- `node`: «Нужен Node.js 22.20 или новее для части набора. Скачай с nodejs.org (кнопка LTS), установи двойным щелчком и перезапусти приложение: недостающее докачается само».
- `git`: Mac предложит «Установить инструменты разработчика» — нажать «Установить», потом перезапустить.
- `uv`: см. следующий раздел. `claude`: см. «Если `claude` не найден в PATH». `21st`: см. `klyuch-21st.md`.

## Если нет uv

`uv` — маленький установщик Python-программ, нужен только для Agent Reach. Блок его **не ставит сам**. Спроси ученика: «Для Agent Reach нужен маленький установщик uv. Поставить? Система может попросить пароль от компьютера (вводи его сам, не в чат).» После «да» поставь через менеджер пакетов: Mac `brew install uv`, Windows `winget install --id astral-sh.uv -e`. Нет `brew` или `winget` — не ставь скриптами из интернета (`curl | sh`), скажи честно, что Agent Reach пока не встанет, и предложи показать Рамису. Без «да» ученика Agent Reach пропусти: остальной набор от него не зависит. Потом запусти блок установки ещё раз.

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
Show 'hyperframes' (Has-Skill 'hyperframes')
Show 'remotion' (Has-Skill 'remotion-best-practices')
Show 'gsap' (Has-Skill 'gsap-core')
Show 'security-audit' (Has-Skill 'security-audit')
Show 'apple-design' (Has-Skill 'apple-design')
Show 'ffmpeg-skill' (Has-Skill 'ffmpeg-skill')
Show 'teardown' (Has-Skill 'teardown')
Show 'anatomy' (Has-Skill 'anatomy')
Show 'gamedev-web' (Has-Skill 'phaser-core')
Show 'agent-reach' (Has-Skill 'agent-reach')
Show 'superpowers' (Has-Plugin 'superpowers')
Show 'humanizer' ((Has-Skill 'humanizer') -or (Has-Plugin 'humanizer'))
Show 'playwright' (($mcps -contains 'playwright') -or (Has-Plugin 'playwright'))
if (($mcps -contains '21st') -or ($mcps -contains '21st-magic') -or ($mcps -contains 'magic')) { "21st: подключён (ключ не показываю)" } else { "21st: НЕТ (нужен личный ключ)" }
if (Get-Command ffmpeg -ErrorAction SilentlyContinue) { 'ffmpeg: есть' } else { 'ffmpeg: НЕТ (нужен для рендера видео HyperFrames и Remotion)' }
if (Get-Command ffmpeg -ErrorAction SilentlyContinue) { if ((ffmpeg -hide_banner -filters 2>$null | Select-String -Pattern ' (ass|subtitles) ' -Quiet)) { 'ffmpeg, субтитры: есть' } else { 'ffmpeg, субтитры: НЕТ (нужна полная сборка Gyan.FFmpeg через winget)' } }
"node: $(try { node -v } catch { 'НЕТ' })"
```

## Windows: установка

То же, что на Mac: закреплённые коммиты, SHA-256 для Agent Reach, `uv` блок сам не ставит. (Не проверено на реальной Windows.)

```powershell install-win
$env:DISABLE_TELEMETRY = '1'; $env:DO_NOT_TRACK = '1'; $env:HYPERFRAMES_NO_TELEMETRY = '1'; $env:HYPERFRAMES_NO_UPDATE_CHECK = '1'
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
# Node и ffmpeg (домашка урока 5): ставим официальным winget, без вопросов. После установки новое окно приложения подхватит PATH.
function Node-Fresh { try { $v = [version]((node -v) -replace '^v',''); ($v.Major -gt 22) -or ($v.Major -eq 22 -and $v.Minor -ge 20) } catch { $false } }
if ((Get-Command winget -ErrorAction SilentlyContinue)) {
  if (-not (Node-Fresh)) { winget install --id OpenJS.NodeJS.LTS -e --silent --accept-package-agreements --accept-source-agreements *> $null }
  if (-not (Get-Command ffmpeg -ErrorAction SilentlyContinue)) { winget install --id Gyan.FFmpeg -e --silent --accept-package-agreements --accept-source-agreements *> $null }
  $env:Path = [Environment]::GetEnvironmentVariable('Path','User') + ';' + [Environment]::GetEnvironmentVariable('Path','Machine') + ";$HOME\.local\bin"
}
function Ok($n) { "уже стоит: $n" }
function Done($n) { "поставил: $n" }
function Fail($n, $why) { "НЕ ПОСТАВИЛОСЬ: $n ($why)"; $script:Fails++ }

# Клон строго на закреплённом коммите: не вышло скачать или переключиться, или HEAD не равен коммиту, значит не ставим
function Git-Pinned($url, $sha, $dir) {
  git clone -q --no-recurse-submodules -c protocol.file.allow=never $url $dir *> $null
  if ($LASTEXITCODE -ne 0) { return $false }
  git -C $dir checkout -q $sha *> $null
  if ($LASTEXITCODE -ne 0) { return $false }
  return ((git -C $dir rev-parse HEAD) -eq $sha)
}

function Skill-Pinned($repo, $sha, $name) {
  if (Has-Skill $name) { Ok $name; return }
  $dir = Join-Path $Work $name
  if (-not (Git-Pinned "https://github.com/$repo.git" $sha $dir)) { Fail $name 'не скачалось на закреплённом коммите'; return }
  npx.cmd --yes $SkillsCli add $dir --skill $name -g -a claude-code -y --copy *> $null
  if (Has-Skill $name) { Done $name } else { Fail $name 'нужны git и Node 22.20 или новее' }
}

Skill-Pinned 'vercel-labs/skills' '7a5e920bead4b1039a6d6df5d7e1163b7b09423a' 'find-skills'
Skill-Pinned 'emilkowalski/skills' 'f1090bec277140d02ed202440185ad9d02ac1490' 'emil-design-eng'
Skill-Pinned 'pbakaus/impeccable' '9fadc41729c38fd47d7ae622b501558653f9d2e9' 'impeccable'
Skill-Pinned 'emilkowalski/skills' 'f1090bec277140d02ed202440185ad9d02ac1490' 'apple-design'
Skill-Pinned 'emilkowalski/skills' 'f1090bec277140d02ed202440185ad9d02ac1490' 'animate'
Skill-Pinned 'emilkowalski/skills' 'f1090bec277140d02ed202440185ad9d02ac1490' 'animation-vocabulary'
Skill-Pinned 'emilkowalski/skills' 'f1090bec277140d02ed202440185ad9d02ac1490' 'find-animation-opportunities'
Skill-Pinned 'emilkowalski/skills' 'f1090bec277140d02ed202440185ad9d02ac1490' 'improve-animations'
Skill-Pinned 'blader/humanizer' '0ef9fe5bc3572734fd3ae6c448fe00a30cd5dcf0' 'humanizer'

# Remotion: все навыки репозитория на закреплённом коммите (имя навыка '*', проверка по remotion-best-practices)
if (Has-Skill 'remotion-best-practices') { Ok 'remotion' }
else {
  $rdir = Join-Path $Work 'remotion'
  if (Git-Pinned 'https://github.com/remotion-dev/skills.git' 'c7cb2fdcacd134fb2ccb9b7a44f9ffa44e467271' $rdir) { npx.cmd --yes $SkillsCli add $rdir --skill '*' -g -a claude-code -y --copy *> $null }
  if (Has-Skill 'remotion-best-practices') { Done 'remotion' } else { Fail 'remotion' 'нужны git и Node 22.20 или новее' }
}

# GSAP: официальные навыки GreenSock (MIT) на закреплённом коммите, только gsap-*
if (Has-Skill 'gsap-core') { Ok 'gsap' }
else {
  $gdir = Join-Path $Work 'gsap'
  if (-not (Git-Pinned 'https://github.com/greensock/gsap-skills.git' 'aed9cfd3277740755f6bfc1155c7aa645403b760' $gdir)) { Fail 'gsap' 'не скачалось на закреплённом коммите'; $gdir = $null }
  $links = @(); if ($gdir) { $links = @(Get-ChildItem -LiteralPath $gdir -Recurse -Force -ErrorAction SilentlyContinue | Where-Object { ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -and $_.FullName -notmatch '[\\/]\.git[\\/]' -and $_.Name -notin @('CLAUDE.md','GEMINI.md') }) }
  if ($links.Count -gt 0) { Fail 'gsap' 'в репозитории есть символические ссылки'; $gdir = $null }
  if ($gdir) { npx.cmd --yes $SkillsCli add $gdir --skill gsap-core gsap-frameworks gsap-performance gsap-plugins gsap-react gsap-scrolltrigger gsap-timeline gsap-utils -g -a claude-code -y --copy *> $null
    if (Has-Skill 'gsap-core') { Done 'gsap' } else { Fail 'gsap' 'нужны git и Node 22.20 или новее' } }
}

# Cloudflare security-audit (MIT, урок 7): навык глубокой проверки безопасности на закреплённом коммите
if (Has-Skill 'security-audit') { Ok 'security-audit' }
else {
  $sdir = Join-Path $Work 'security-audit'
  if (-not (Git-Pinned 'https://github.com/cloudflare/security-audit-skill.git' 'c1c8a8c1471069fb0e188eeaff69b8e8db6564a8' $sdir)) { Fail 'security-audit' 'не скачалось на закреплённом коммите'; $sdir = $null }
  $slinks = @(); if ($sdir) { $slinks = @(Get-ChildItem -LiteralPath $sdir -Recurse -Force -ErrorAction SilentlyContinue | Where-Object { ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -and $_.FullName -notmatch '[\\/]\.git[\\/]' }) }
  if ($slinks.Count -gt 0) { Fail 'security-audit' 'в репозитории есть символические ссылки'; $sdir = $null }
  if ($sdir) { npx.cmd --yes $SkillsCli add $sdir --skill security-audit -g -a claude-code -y --copy *> $null
    if (Has-Skill 'security-audit') { Done 'security-audit' } else { Fail 'security-audit' 'нужны git и Node 22.20 или новее' } }
}

# HyperFrames: основной набор навыков от HeyGen из клона на закреплённом коммите
if ((Has-Skill 'hyperframes') -and (Has-Skill 'hyperframes-cli')) { Ok 'hyperframes' }
else {
  $hdir = Join-Path $Work 'hyperframes'
  if (Git-Pinned 'https://github.com/heygen-com/hyperframes.git' 'b4cc674f7f312e77ded32e0b53006cc0bad6723b' $hdir) { npx.cmd --yes $SkillsCli add $hdir --skill hyperframes hyperframes-cli hyperframes-registry media-use -g -a claude-code -y --copy *> $null }
  if ((Has-Skill 'hyperframes') -and (Has-Skill 'hyperframes-cli')) { Done 'hyperframes' } else { Fail 'hyperframes' 'нужен Node 22 или новее' }
}
# Новое в 2.7: Teardown, Anatomy, веб-движки игр (на закреплённых коммитах), ffmpeg-skill (установщик автора из клона)
function Clone-Pinned($repo, $sha, $dirName) {
  $d = Join-Path $Work $dirName
  git clone -q --no-recurse-submodules -c protocol.file.allow=never "https://github.com/$repo.git" $d *> $null
  if ($LASTEXITCODE -ne 0) { return $null }
  git -C $d checkout -q $sha *> $null
  if ($LASTEXITCODE -ne 0) { return $null }
  if ((git -C $d rev-parse HEAD) -ne $sha) { return $null }
  $l = @(Get-ChildItem -LiteralPath $d -Recurse -Force -ErrorAction SilentlyContinue | Where-Object { ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -and $_.FullName -notmatch '[\\/]\.git[\\/]' })
  if ($l.Count -gt 0) { return $null }
  return $d
}
if (Has-Skill 'teardown') { Ok 'teardown' } else {
  $d = Clone-Pinned 'elvarofficial/teardown' 'a91262ac1109051e014662d42ecb0b7bc1f113b1' 'teardown'
  if ($d) { npx.cmd --yes $SkillsCli add $d --skill teardown -g -a claude-code -y --copy *> $null }
  if (Has-Skill 'teardown') { Done 'teardown' } else { Fail 'teardown' 'нужны git и Node 22.20 или новее, или символические ссылки в репозитории' }
}
if (Has-Skill 'anatomy') { Ok 'anatomy' } else {
  $d = Clone-Pinned 'wheresryan22/anatomy' '1482e8469b0a9e0d8cc18ea2740a01423d29ae80' 'anatomy'
  if ($d) { Remove-Item -LiteralPath "$d\scripts\publish.mjs", "$d\scripts\publish.test.mjs" -Force -ErrorAction SilentlyContinue; npx.cmd --yes $SkillsCli add $d --skill anatomy -g -a claude-code -y --copy *> $null }
  if (Has-Skill 'anatomy') { Done 'anatomy' } else { Fail 'anatomy' 'нужны git и Node 22.20 или новее, или символические ссылки в репозитории' }
}
if (Has-Skill 'phaser-core') { Ok 'gamedev-web' } else {
  $d = Clone-Pinned 'gamedev-skills/awesome-gamedev-agent-skills' '19d93f97c9c1ea0f8b306e77aa81e0d3e352d3e9' 'gamedev'
  if ($d) { npx.cmd --yes $SkillsCli add $d --skill router phaser-core phaser-arcade-physics pixijs-rendering threejs-scene-setup threejs-gltf-loading threejs-materials-lighting -g -a claude-code -y --copy *> $null }
  if (Has-Skill 'phaser-core') { Done 'gamedev-web' } else { Fail 'gamedev-web' 'нужны git и Node 22.20 или новее' }
}
if (Has-Skill 'ffmpeg-skill') { Ok 'ffmpeg-skill' } else {
  $d = Clone-Pinned 'kajisho5/ffmpeg-skill' '9bdb444fdd569bcf50276337b36164fadf54b363' 'ffmpeg-skill'
  if ($d) { node "$d\bin\install.js" --claude *> $null }
  if (Has-Skill 'ffmpeg-skill') { Done 'ffmpeg-skill' } else { Fail 'ffmpeg-skill' 'нужны git и Node 22.20 или новее' }
}
if ((Get-Command ffmpeg -ErrorAction SilentlyContinue) -and -not (ffmpeg -hide_banner -filters 2>$null | Select-String -Pattern ' (ass|subtitles) ' -Quiet)) { 'ffmpeg без фильтра субтитров: скажи ученику, что нужна полная сборка Gyan.FFmpeg через winget и перезапуск приложения, иначе субтитры монтажа не нарисуются' }
if (-not (Get-Command ffmpeg -ErrorAction SilentlyContinue)) { 'нет ffmpeg: winget не поставил, скажи ученику: закрыть и открыть приложение, потом повторить; иначе скачать сборку с gyan.dev/ffmpeg/builds' }

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
  $mcpPrefix = "$HOME\.ii-ramis\mcp"
  New-Item -ItemType Directory -Force $mcpPrefix | Out-Null
  npm.cmd install --prefix $mcpPrefix --registry https://registry.npmjs.org/ --userconfig NUL --ignore-scripts --no-audit --no-fund '@playwright/mcp@0.0.84' *> $null
  if (Test-Path "$mcpPrefix\node_modules\.bin\playwright-mcp.cmd") { claude mcp add --scope user playwright -- "$mcpPrefix\node_modules\.bin\playwright-mcp.cmd" *> $null }
  if ((Get-McpNames) -contains 'playwright') { Done 'playwright' } else { Fail 'playwright' 'claude mcp add playwright' }
}

function Ar-Ready { (Has-Skill 'agent-reach') -and ((Get-Command agent-reach -ErrorAction SilentlyContinue) -and (((agent-reach version 2>$null) -join '') -match '"ok": true')) }
if (Ar-Ready) { Ok 'agent-reach' }
elseif (-not (Get-Command uv -ErrorAction SilentlyContinue)) { 'ЖДЁТ uv: agent-reach (спроси ученика, см. «Если нет uv»)'; $script:Fails++ }
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
('{"kit":"2.7.0","lesson":5,"status":"' + $status + '","tries":' + ($prev + 1) + ',"missing":"","notes":""}') | Set-Content -LiteralPath "$HOME\.ii-ramis\nabor.json"
Remove-Item -LiteralPath $Work -Recurse -Force -ErrorAction SilentlyContinue
"ошибок: $($script:Fails)"
```

## Earshot (предлагается один раз, ставится только по «да»)

Earshot (github.com/Leonxlnx/earshot, MIT, v0.4.0 = коммит `591fa3e`) даёт Claude «уши»: описать звук словами, найти нужный момент в записи, подобрать эффекты. Нужны Python 3.10+, около 1,5 ГБ пакетов (torch и др.) и ещё ~1,1 ГБ моделей (CLAP и AST, скачиваются один раз с Hugging Face на закреплённых версиях): всего ~3 ГБ и минут 10 загрузки. Ключей и аккаунтов не нужно, всё считается на компьютере; через MCP быстро, из консоли каждый вызов грузит модели 20–40 секунд. Порядок предложения: `nabor/SKILL.md`, раздел 7.

Mac и Linux (нужны `uv` и `git`; песочница не даёт писать в `~/.ii-ramis` и `~/.claude.json`, поэтому запускай через окно «Bash command (unsandboxed)», разрешать только эту команду):

```bash
bash "$(ls -d "$HOME"/.claude/plugins/cache/ii-ramis/ii-ramis/*/ | sort -V | tail -1)hooks/kit-install.sh" --earshot
```

Скрипт не работает, если есть отметка отказа `~/.ii-ramis/earshot-declined`. Он делает: окружение `~/.ii-ramis/earshot` (Python 3.12), всё из свежей пустой временной папки с `UV_NO_CONFIG=1` и сброшенными переменными индексов, `torch==2.14.1` с CPU-индекса PyTorch, пакет Earshot с GitHub на коммите `591fa3e` и `mcp==2.3.0` с индекса pypi.org и файлом точных версий `earshot-constraints.txt` (хеши не закреплены: остаточный риск, ставится только по «да»), `earshot doctor --fetch` (модели), `claude mcp add --scope user earshot`. Сообщение «Earshot поставлен и подключён» скрипт печатает только после того, как MCP `earshot` реально появился в `~/.claude.json`; иначе честно говорит, что подключение не удалось. Проверка: `~/.ii-ramis/earshot/bin/earshot doctor` без строки `problems`.

Windows (PowerShell, нужен `uv`; песочницы нет):

```powershell
if (Test-Path "$HOME\.ii-ramis\earshot-declined") { 'Ученик отказался от Earshot, не ставлю'; return }
$c = (Get-ChildItem "$HOME\.claude\plugins\cache\ii-ramis\ii-ramis\*\skills\nabor\references\earshot-constraints.txt" | Sort-Object FullName | Select-Object -Last 1).FullName
if (-not $c) { 'нет файла ограничений версий, не ставлю'; return }
# Свежая пустая папка и без чужих настроек uv и pip: uv.toml, pyproject и переменные с индексами не подмешаются
$tmp = Join-Path ([IO.Path]::GetTempPath()) ('earshot-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory $tmp | Out-Null
Push-Location $tmp
$env:UV_NO_CONFIG = '1'
foreach ($n in 'UV_INDEX_URL','UV_EXTRA_INDEX_URL','UV_INDEX','UV_DEFAULT_INDEX','PIP_INDEX_URL','PIP_EXTRA_INDEX_URL') { Remove-Item "Env:$n" -ErrorAction SilentlyContinue }
$e = "$HOME\.ii-ramis\earshot"
uv venv $e --python 3.12
uv pip install --python "$e\Scripts\python.exe" "torch==2.14.1" --index-url https://download.pytorch.org/whl/cpu
uv pip install --python "$e\Scripts\python.exe" --index-url https://pypi.org/simple --constraint $c "git+https://github.com/Leonxlnx/earshot@591fa3e028032e6dce56620a20e932e35667e8d8" "mcp==2.3.0"
& "$e\Scripts\earshot.exe" doctor --fetch
claude mcp add --scope user earshot -- "$e\Scripts\python.exe" -m earshot mcp
Pop-Location
Remove-Item $tmp -Force -ErrorAction SilentlyContinue
if (((Get-Content "$HOME\.claude.json" -Raw | ConvertFrom-Json).mcpServers.PSObject.Properties.Name) -contains 'earshot') { Remove-Item "$HOME\.ii-ramis\earshot-declined" -ErrorAction SilentlyContinue; 'Earshot поставлен и подключён' } else { 'Earshot скачан, но MCP не подключился: скажи ученику честно' }
```

Проверено на Linux, на чужом Mac и Windows не проверено. После установки нужна новая сессия.

## Маска человека для стиля «Афиша» (предлагается один раз, ставится только по «да»)

Нужна стилю «Афиша» в `montazh`, чтобы слово-тема стояло ЗА человеком. С 2.8.0 это Robust Video Matting (RVM, MobileNetV3, ONNX), как у Монтажки: вырезает человека по волосам, без мерцания, на обычном процессоре Mac и Windows (15 секунд видео считаются 1–4 минуты). Ставятся два куска: (1) окружение с `onnxruntime` (около 60 МБ, версии закреплены в `nabor/references/mask-requirements.txt`, `--no-deps`; хеши пакетов не закреплены, остаточный риск); (2) модель `rvm_mobilenetv3_fp32.onnx` (15 МБ), которую скачивает `montazh/scripts/install_rvm.py` с официального GitHub-релиза авторов (PeterL1n/RobustVideoMatting, v1.0.0) только по https, с проверкой размера и SHA256 из плагина. **Лицензия RVM: GPL-3.0 (код и веса авторов).** Модель НЕ лежит в плагине и не раздаётся нами: ученик сам скачивает её с сайта авторов для себя и считает у себя на компьютере, ролики остаются его. Ключей и аккаунтов нет, после установки интернет не нужен. Если рядом лежит старое окружение с MediaPipe (плагин до 2.8), Афиша считает им грубее; для новой маски удали `~/.ii-ramis/mask` и поставь заново.

Mac и Linux (нужен `uv`; через окно «Bash command (unsandboxed)», разрешать только эту команду):

```bash
bash "$(ls -d "$HOME"/.claude/plugins/cache/ii-ramis/ii-ramis/*/ | sort -V | tail -1)hooks/kit-install.sh" --mask
```

Скрипт ставит окружение в `~/.ii-ramis/mask` (Python 3.12) из пустой временной папки, без чужих настроек uv и pip, с индекса pypi.org, проверяет импорт и скачивает модель в `~/.ii-ramis/mask/models`. Не работает, если есть отметка отказа `~/.ii-ramis/mask-declined`.

Windows (PowerShell, нужен `uv`):

```powershell
if (Test-Path "$HOME\.ii-ramis\mask-declined") { 'Ученик отказался от маски, не ставлю'; return }
$r = (Get-ChildItem "$HOME\.claude\plugins\cache\ii-ramis\ii-ramis\*\skills\nabor\references\mask-requirements.txt" | Sort-Object FullName | Select-Object -Last 1).FullName
if (-not $r) { 'нет файла версий, не ставлю'; return }
$tmp = Join-Path ([IO.Path]::GetTempPath()) ('mask-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory $tmp | Out-Null
Push-Location $tmp
$env:UV_NO_CONFIG = '1'
foreach ($n in 'UV_INDEX_URL','UV_EXTRA_INDEX_URL','UV_INDEX','UV_DEFAULT_INDEX','PIP_INDEX_URL','PIP_EXTRA_INDEX_URL') { Remove-Item "Env:$n" -ErrorAction SilentlyContinue }
$m = "$HOME\.ii-ramis\mask"
uv venv $m --python 3.12
uv pip install --python "$m\Scripts\python.exe" --index-url https://pypi.org/simple --no-deps -r $r
& "$m\Scripts\python.exe" -c "import onnxruntime, numpy; onnxruntime.InferenceSession; print('Окружение маски поставлено')"
$s = (Get-ChildItem "$HOME\.claude\plugins\cache\ii-ramis\ii-ramis\*\skills\montazh\scripts\install_rvm.py" | Sort-Object FullName | Select-Object -Last 1).FullName
& "$m\Scripts\python.exe" $s
Pop-Location
Remove-Item $tmp -Force -ErrorAction SilentlyContinue
```

Проверено на Linux; на чужом Mac и Windows не проверено. Без маски стиль «Афиша» работает в запасном виде (слово-тема над головой).

## Шрифты Афиши (платные Druk Cyr, Benzin, Denistina: в плагине их нет)

Ученик пишет «поставь шрифты Афиши» и вставляет ссылку на архив из группы курса (закрытая ссылка Рамиса, напрямую на файл `afisha-fonts.zip`). Запусти (Mac, Linux и Windows одной строкой, питон любой 3.9+):

```
python3 <папка плагина>/skills/montazh/scripts/install_fonts.py "<ссылка>"
```

На Windows `py` вместо `python3`. Скрипт принимает только https-ссылку, качает до 3 МБ, сверяет SHA256 архива с хешем из `skills/montazh/references/afisha-fonts.sha256` (сама ссылка в плагине не хранится), берёт из архива только 4 файла с известными именами (`DrukCyr-Medium.ttf`, `DrukCyr-Bold.ttf`, `Benzin-Bold.ttf`, `Denistina-Regular.ttf`), без папок и ссылок, и кладёт их в `~/.ii-ramis/fonts` (Windows: `%USERPROFILE%\.ii-ramis\fonts`). Ничего из архива не запускается. Архив уже лежит на компьютере: `... install_fonts.py --file <путь к zip>`. Проверка: `... install_fonts.py --check`. Хеш не совпал, значит это другой файл: ничего не установлено, попроси у Рамиса или в группе свежую ссылку. Ссылку из чата в память и в файлы не записывай. Без шрифтов Афиша работает на бесплатных аналогах (Fira Sans Extra Condensed, Rubik Mono One, Bad Script).


## Если `claude` не найден в PATH

Плагины (superpowers, humanizer) тогда ставятся через интерфейс: Claude Desktop, вкладка Code, кнопка «+» у поля ввода → Manage plugins → найти `superpowers` (маркетплейс `claude-plugins-official`) и Install; для humanizer сначала добавить маркетплейс `blader/humanizer`. Навыки через `npx` на `claude` не завязаны, а `claude mcp add` без него не выполнить: скажи честно.

## Сколько это занимает и весит

Установка 2–5 минут, один раз. На диске около 200 МБ, почти всё это Agent Reach (140 МБ, из них yt-dlp и bili-cli); HyperFrames и Remotion добавляют по несколько мегабайт навыков. Рендер видео потом докачивает браузер (около 200 МБ) и требует ffmpeg. Playwright при первом использовании докачивает браузер Chromium (около 200 МБ), это нормально: предупреди ученика словами «докачаю браузер для проверок».
