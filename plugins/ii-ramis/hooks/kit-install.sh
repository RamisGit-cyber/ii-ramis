#!/usr/bin/env bash
# ИИ Рамис 2.7: установка набора курса (урок 5) скриптом хука SessionStart.
#
# Зачем скрипт, а не команды Claude: в Claude Desktop команды Claude идут в песочнице,
# и она запрещает писать в ~/.claude (там навыки и плагины) и в ~/.claude.json (MCP).
# Хуки приложение выполняет вне песочницы (code.claude.com/docs/en/sandboxing, «What runs outside the sandbox»).
#
# Режимы (hooks.json запускает первые два как два хука SessionStart):
#   --notice  быстрый синхронный хук: если набор нужен, печатает сообщение ученику и подсказку для Claude. Ничего не ставит.
#   --auto    асинхронный хук (async: true): сам ставит набор и по завершении сообщает Claude на следующем ходу.
#   --run     установка в этом процессе, без хуков (ручной запуск в обычном терминале).
#
# Принципы: качаем у авторов, версии и коммиты закреплены, в репозиторий ничего чужого не копируем,
# вопросов не задаём, «уже стоит» не трогаем, отказ (status=declined) уважаем, 21st без ключа ученика не ставим.

# Только Mac и Linux. На Windows набор ставит блок PowerShell (там у команд Claude нет песочницы).
case "$(uname -s 2>/dev/null)" in Darwin|Linux) ;; *) exit 0 ;; esac
umask 077

KIT_VERSION="2.7.0"
STATE_DIR="$HOME/.ii-ramis"
STATE="$STATE_DIR/nabor.json"
LOCK="$STATE_DIR/nabor.lock"
LOG="$STATE_DIR/nabor.log"
SELF="${BASH_SOURCE[0]}"

# --- закреплённые источники (проверены 04.11.2026) ---
SKILLS_CLI="skills@1.7.6"
PLAYWRIGHT_MCP="@playwright/mcp@0.0.84"
MCP_PREFIX="$HOME/.ii-ramis/mcp" # сюда ставится Playwright MCP, чтобы Claude запускал его по абсолютному пути, а не через npx из папки проекта
HYPERFRAMES_SHA="b4cc674f7f312e77ded32e0b53006cc0bad6723b" # тег v0.9.19 репозитория heygen-com/hyperframes
AR_URL="https://github.com/Panniantong/Agent-Reach/releases/download/v1.6.1/agent-reach.zip"
AR_SHA256="51443d733bcb26064262442083a8f8abf6ba5e3e7df54beebafe98c88be04a60"
REMOTION_SHA="c7cb2fdcacd134fb2ccb9b7a44f9ffa44e467271"
GSAP_SHA="aed9cfd3277740755f6bfc1155c7aa645403b760" # greensock/gsap-skills (MIT), коммит от 06.11.2026
FFMPEG_SKILL_SHA="9bdb444fdd569bcf50276337b36164fadf54b363" # kajisho5/ffmpeg-skill (MIT), тег v3.2.0
TEARDOWN_SHA="a91262ac1109051e014662d42ecb0b7bc1f113b1" # elvarofficial/teardown (MIT), коммит от 31.10.2026
ANATOMY_SHA="1482e8469b0a9e0d8cc18ea2740a01423d29ae80" # wheresryan22/anatomy (MIT), коммит от 18.10.2026
EARSHOT_SHA="591fa3e028032e6dce56620a20e932e35667e8d8" # Leonxlnx/earshot (MIT), тег v0.4.0; ставится только по «да» ученика (режим --earshot), не хуком
PYTORCH_CPU_INDEX="https://download.pytorch.org/whl/cpu"
GAMEDEV_SHA="19d93f97c9c1ea0f8b306e77aa81e0d3e352d3e9" # gamedev-skills/awesome-gamedev-agent-skills (Apache-2.0), коммит от 28.10.2026

export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
export DISABLE_TELEMETRY=1 DO_NOT_TRACK=1 HYPERFRAMES_NO_TELEMETRY=1 HYPERFRAMES_NO_UPDATE_CHECK=1
# npx берёт пакеты только с официального реестра, а не из .npmrc случайной папки проекта
export NPM_CONFIG_REGISTRY="https://registry.npmjs.org/" NPM_CONFIG_UPDATE_NOTIFIER=false GIT_TERMINAL_PROMPT=0

state_str() { sed -n "s/.*\"$1\": *\"\([^\"]*\)\".*/\1/p" "$STATE" 2>/dev/null | head -1; }
state_num() { sed -n "s/.*\"$1\": *\([0-9][0-9]*\).*/\1/p" "$STATE" 2>/dev/null | head -1; }

ver_ge() { # $1 >= $2 (формат x.y.z)
  local a b i x y
  IFS=. read -r -a a <<<"$1"; IFS=. read -r -a b <<<"$2"
  for i in 0 1 2; do
    x="${a[$i]:-0}"; y="${b[$i]:-0}"
    case "$x$y" in *[!0-9]*) return 1;; esac
    [ "$x" -gt "$y" ] && return 0
    [ "$x" -lt "$y" ] && return 1
  done
  return 0
}

# Записать состояние. Отказ ученика (declined) никогда не затираем.
write_state() { # status tries missing notes
  [ "$(state_str status)" = "declined" ] && return 0
  mkdir -p "$STATE_DIR"
  local tmp="$STATE.$$.tmp"
  printf '{"kit":"%s","lesson":5,"status":"%s","tries":%s,"missing":"%s","notes":"%s"}\n' \
    "$KIT_VERSION" "$1" "${2:-0}" "$3" "$4" >"$tmp" && mv "$tmp" "$STATE"
}

# ============================ РЕШЕНИЕ: НУЖНА ЛИ УСТАНОВКА ============================
need_install() {
  [ -n "${II_RAMIS_NO_KIT:-}" ] && return 1
  mkdir -p "$STATE_DIR" 2>/dev/null || return 1
  local status kit tries
  status="$(state_str status)"; kit="$(state_str kit)"; tries="$(state_num tries)"
  [ "$status" = "declined" ] && return 1
  if ver_ge "${kit:-0.0.0}" "$KIT_VERSION"; then
    [ "$status" = "ok" ] && return 1
    { [ "$status" = "partial" ] || [ "$status" = "installing" ]; } && [ "${tries:-0}" -ge 3 ] && return 1
  fi
  return 0
}

# Поля из файла состояния попадают в контекст Claude: оставляем только буквы, цифры, пробел, дефис и подчёркивание.
clean() { printf '%s' "$1" | LC_ALL=C tr -cd 'a-zA-Z0-9 _-' | head -c 120; }

emit() { # сообщение ученику, контекст для Claude (одна строка JSON; в текстах нет кавычек и обратных косых)
  printf '{"systemMessage":"%s","hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"%s"}}\n' "$1" "$2"
}

# Быстрый синхронный хук: только сообщает, что набор ставится. Ничего не устанавливает.
notice_mode() {
  need_install || return 0
  emit "ИИ Рамис ставит инструменты урока 5 и новые навыки в фоне (2–5 минут, вводить ничего не нужно). Не хочешь: напиши «не ставь набор»." "ИИ Рамис: хук ставит набор 2.7.0 в фоне вне песочницы. Скажи ученику одной строкой, что ставится и как отказаться (отказ «не ставь набор» запишет хук сам, файлы не пиши: установка остановится на следующем шаге). Саму установку Bash-командами не запускай: Bash в песочнице не может писать в ~/.claude."
}

# Асинхронный хук (async: true): сам ставит набор, по завершении сообщает Claude на следующем ходу.
auto_mode() {
  need_install || return 0
  # другая установка идёт? замок свежее 30 минут
  if [ -d "$LOCK" ] && [ -z "$(find "$LOCK" -maxdepth 0 -mmin +30 2>/dev/null)" ]; then return 0; fi
  rm -rf "$LOCK" 2>/dev/null
  mkdir "$LOCK" 2>/dev/null || return 0
  mkdir -p "$STATE_DIR"; : >"$LOG" 2>/dev/null
  LOCK_HELD=1 run_mode >>"$LOG" 2>&1
  local status missing notes
  status="$(state_str status)"; missing="$(clean "$(state_str missing)")"; notes="$(clean "$(state_str notes)")"
  case "$status" in
    ok)      emit "Набор урока 5 поставлен. Закрой сессию и открой заново (или напиши /reload-plugins), тогда всё подхватится." "ИИ Рамис: установка набора 2.7.0 завершена, status ok. Заметки (notes): ${notes:-нет}. Скажи ученику перезапустить сессию; про notes объясни по разделу 1 навыка nabor." ;;
    partial) emit "Часть набора не поставилась: ${missing:-см. журнал}. Скажи об этом ИИ Рамису." "ИИ Рамис: установка набора 2.7.0 не дошла до конца (status partial). Не поставилось: ${missing:-неизвестно}. Заметки: ${notes:-нет}. Разбери по разделу 1 навыка nabor, журнал ~/.ii-ramis/nabor.log." ;;
  esac
}

# ============================ РЕЖИМ УСТАНОВКИ ============================
find_claude() {
  local c
  for c in "${CLAUDE_CODE_EXECPATH:-}" "$(command -v claude 2>/dev/null)" "$HOME/.local/bin/claude" "$HOME/.claude/local/claude" /opt/homebrew/bin/claude /usr/local/bin/claude; do
    [ -n "$c" ] && [ -x "$c" ] && { echo "$c"; return; }
  done
  # встроенная копия в приложении Claude Desktop (Mac)
  ls -d "$HOME/Library/Application Support/Claude/claude-code"/*/claude.app/Contents/MacOS/claude 2>/dev/null | sort | tail -1
}

declined() { [ "$(state_str status)" = "declined" ]; }

run_mode() {
  mkdir -p "$STATE_DIR"
  local prev tries claude_bin
  prev="$(state_num tries)"; ver_ge "$(state_str kit)" "$KIT_VERSION" || prev=0
  tries=$(( ${prev:-0} + 1 ))
  # Замок: хук уже взял его сам (LOCK_HELD), при ручном запуске берём здесь.
  if [ -z "${LOCK_HELD:-}" ] && ! mkdir "$LOCK" 2>/dev/null; then echo "установка уже идёт (замок $LOCK)"; return 0; fi
  trap 'rm -rf "$WORK" "$LOCK"' EXIT
  WORK="$(mktemp -d)" || exit 1
  work="$WORK"
  cd "$WORK" || exit 1 # npx не должен запускаться из чужой папки проекта
  write_state installing "$tries" "" ""

  local log="$work/step.log" fails=0 missing="" notes=""
  claude_bin="$(find_claude)"
  [ -n "$claude_bin" ] && claude() { "$claude_bin" "$@"; }

  ok()    { echo "уже стоит: $1"; }
  done_() { echo "поставил: $1"; }
  fail()  { echo "НЕ ПОСТАВИЛОСЬ: $1 ($2)"; tail -n 3 "$log" 2>/dev/null | sed 's/^/    /'; fails=$((fails+1)); missing="$missing $1"; }

  has_skill() { local d; for d in "$HOME/.claude/skills/$1" "$HOME/.claude/skills/synced"/*/"$1"; do [ -f "$d/SKILL.md" ] && return 0; done; return 1; }
  has_plugin() { [ -n "$claude_bin" ] && claude plugin list --json 2>/dev/null | grep -q "\"id\": \"$1@"; }
  mcp_names() { node -e "const fs=require('fs'),os=require('os');let n=[];try{const j=JSON.parse(fs.readFileSync(os.homedir()+'/.claude.json','utf8'));n=Object.keys(j.mcpServers||{});for(const p of Object.values(j.projects||{}))n.push(...Object.keys(p.mcpServers||{}))}catch(e){}console.log(n.join(' '))" 2>/dev/null; }
  has_mcp() { case " $(mcp_names) " in *" $1 "*) return 0;; esac; return 1; }

  # --- предварительные условия: говорим честно, остальное не ломаем ---
  # Mac с Homebrew: Node и ffmpeg ставятся официальным brew (без вопросов, это домашка урока 5). Нет brew: честно пишем в notes.
  ffmpeg_has_subs() { command -v ffmpeg >/dev/null 2>&1 && ffmpeg -hide_banner -filters 2>/dev/null | grep -qE ' (ass|subtitles) '; }
  node_fresh() { command -v node >/dev/null 2>&1 && node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=20)?0:1)' 2>/dev/null; }
  if [ "$(uname -s)" = "Darwin" ] && command -v brew >/dev/null 2>&1 && ! declined; then
    export HOMEBREW_NO_AUTO_UPDATE=1 HOMEBREW_NO_ANALYTICS=1 HOMEBREW_NO_INSTALL_CLEANUP=1 HOMEBREW_NO_ENV_HINTS=1
    # Только если Node нет совсем: чужой старый Node не обновляем молча (может сломать другие проекты ученика), он попадёт в notes.
    if ! command -v node >/dev/null 2>&1; then
      : >"$log"; brew install node >>"$log" 2>&1
      node_fresh && echo "поставил: node" || echo "node не поставился (см. журнал)"
    fi
    # ffmpeg нужен С фильтром субтитров (libass): у Homebrew-формулы ffmpeg его бывает нет, и субтитры монтажа не рисуются.
    # Тогда ставим полную сборку ffmpeg-full и делаем её основной (старую только отлинковываем, не удаляем).
    if ! ffmpeg_has_subs; then
      : >"$log"; brew install ffmpeg-full >>"$log" 2>&1
      if ! ffmpeg_has_subs; then
        brew unlink ffmpeg >>"$log" 2>&1
        brew link --force ffmpeg-full >>"$log" 2>&1 || { brew unlink ffmpeg-full >>"$log" 2>&1; brew link ffmpeg >>"$log" 2>&1; }
      fi
      ffmpeg_has_subs && echo "поставил: ffmpeg со субтитрами (ffmpeg-full)" || echo "ffmpeg со субтитрами не поставился (см. журнал)"
    fi
  fi
  local node_ok=0 git_ok=0
  if command -v node >/dev/null 2>&1 && node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=20)?0:1)' 2>/dev/null; then node_ok=1; else notes="$notes node"; fi
  command -v git >/dev/null 2>&1 && git_ok=1 || notes="$notes git"
  [ -n "$claude_bin" ] || notes="$notes claude"
  command -v ffmpeg >/dev/null 2>&1 || notes="$notes ffmpeg"
  if command -v ffmpeg >/dev/null 2>&1 && ! ffmpeg_has_subs; then notes="$notes ffmpegsubs"; fi
  command -v python3 >/dev/null 2>&1 || notes="$notes python"

  # --- навык из закреплённого коммита ---
  # Без символических ссылок в чужом репозитории: клон проверяется до установки (папка packages/ с исходным кодом инструментов не устанавливается и не проверяется).
  skill_pinned() { # репозиторий коммит навык-или-* маркер(имя навыка для проверки)
    local repo="$1" sha="$2" skill="$3" marker="$4" dir="$work/$4" skill_args
    read -r -a skill_args <<<"$skill" # несколько навыков через пробел
    if has_skill "$marker"; then ok "$marker"; return; fi
    declined && { echo "отказ ученика: пропускаю $marker"; return; }
    : >"$log"
    if [ "$node_ok" -ne 1 ] || [ "$git_ok" -ne 1 ]; then fail "$marker" "нужны git и Node 22.20 или новее"; return; fi
    git -c protocol.file.allow=never clone -q --no-recurse-submodules "https://github.com/$repo.git" "$dir" >>"$log" 2>&1 && git -C "$dir" checkout -q "$sha" >>"$log" 2>&1 || { fail "$marker" "не скачалось"; return; }
    # В корне репозиториев авторов бывают CLAUDE.md и GEMINI.md как ссылки на AGENTS.md (так у greensock/gsap-skills): они безвредны, установщик их не копирует.
    if [ -n "$(find "$dir" -type l -not -path '*/.git/*' -not -path "$dir/packages/*" -not \( -path "$dir/CLAUDE.md" -o -path "$dir/GEMINI.md" \) 2>/dev/null | head -1)" ] || { [ -L "$dir/CLAUDE.md" ] && [ "$(readlink "$dir/CLAUDE.md")" != "AGENTS.md" ]; } || { [ -L "$dir/GEMINI.md" ] && [ "$(readlink "$dir/GEMINI.md")" != "AGENTS.md" ]; }; then echo "в репозитории $repo есть символические ссылки, не ставлю" >>"$log"; fail "$marker" "символические ссылки"; return; fi
    # Anatomy: скрипт публикации в чужую галерею (git push) ученикам не нужен, не ставим его
    [ "$marker" = "anatomy" ] && rm -f "$dir/scripts/publish.mjs" "$dir/scripts/publish.test.mjs"
    npx --yes "$SKILLS_CLI" add "$dir" --skill "${skill_args[@]}" -g -a claude-code -y --copy >>"$log" 2>&1
    if has_skill "$marker"; then done_ "$marker"; else fail "$marker" "нужны git и Node 22.20 или новее"; fi
  }

  skill_pinned vercel-labs/skills 7a5e920bead4b1039a6d6df5d7e1163b7b09423a find-skills find-skills
  skill_pinned emilkowalski/skills f1090bec277140d02ed202440185ad9d02ac1490 emil-design-eng emil-design-eng
  # Плавность и тайминги анимации (монтаж «Про», веб): из того же репозитория Эмила на том же коммите
  skill_pinned emilkowalski/skills f1090bec277140d02ed202440185ad9d02ac1490 "apple-design animate animation-vocabulary find-animation-opportunities improve-animations" apple-design
  skill_pinned pbakaus/impeccable 9fadc41729c38fd47d7ae622b501558653f9d2e9 impeccable impeccable
  skill_pinned blader/humanizer 0ef9fe5bc3572734fd3ae6c448fe00a30cd5dcf0 humanizer humanizer
  # Remotion: все навыки репозитория (remotion-best-practices маршрутизирует по остальным)
  skill_pinned remotion-dev/skills "$REMOTION_SHA" '*' remotion-best-practices

  # GSAP: официальные навыки GreenSock (домашка урока 5), только gsap-*, на закреплённом коммите
  skill_pinned greensock/gsap-skills "$GSAP_SHA" "gsap-core gsap-frameworks gsap-performance gsap-plugins gsap-react gsap-scrolltrigger gsap-timeline gsap-utils" gsap-core

  # --- Новое в 2.7: Teardown (3D-симуляторы), Anatomy (интерактивные схемы), веб-движки для игр, ffmpeg-skill (видеоредактор) ---
  # Teardown и Anatomy при первом использовании сами просят `npm ci` в своей папке (с «да» ученика), здесь ничего не запускается.
  skill_pinned elvarofficial/teardown "$TEARDOWN_SHA" teardown teardown
  skill_pinned wheresryan22/anatomy "$ANATOMY_SHA" anatomy anatomy
  skill_pinned gamedev-skills/awesome-gamedev-agent-skills "$GAMEDEV_SHA" "router phaser-core phaser-arcade-physics pixijs-rendering threejs-scene-setup threejs-gltf-loading threejs-materials-lighting" phaser-core

  # ffmpeg-skill: свой установщик автора только копирует файлы в ~/.claude/skills/ffmpeg-skill (без сети и без postinstall), запускаем его из клона на закреплённом коммите
  if has_skill ffmpeg-skill; then ok ffmpeg-skill
  elif declined; then echo "отказ ученика: пропускаю ffmpeg-skill"
  else
    : >"$log"; fdir="$work/ffmpeg-skill"
    if [ "$node_ok" -ne 1 ] || [ "$git_ok" -ne 1 ]; then fail ffmpeg-skill "нужны git и Node 22.20 или новее"
    elif git -c protocol.file.allow=never clone -q --no-recurse-submodules "https://github.com/kajisho5/ffmpeg-skill.git" "$fdir" >>"$log" 2>&1 && git -C "$fdir" checkout -q "$FFMPEG_SKILL_SHA" >>"$log" 2>&1; then
      if [ -n "$(find "$fdir" -type l -not -path '*/.git/*' 2>/dev/null | head -1)" ]; then fail ffmpeg-skill "символические ссылки"
      else
        node "$fdir/bin/install.js" --claude >>"$log" 2>&1
        if has_skill ffmpeg-skill; then done_ ffmpeg-skill; else fail ffmpeg-skill "node bin/install.js"; fi
      fi
    else fail ffmpeg-skill "не скачалось"; fi
  fi

  # --- HyperFrames: основной набор навыков HeyGen из клона на закреплённом коммите (тег v0.9.19), без их установщика ---
  skill_pinned heygen-com/hyperframes "$HYPERFRAMES_SHA" "hyperframes hyperframes-cli hyperframes-registry media-use" hyperframes

  # --- superpowers (плагин из маркетплейса Anthropic) ---
  if has_plugin superpowers; then ok superpowers
  elif declined; then echo "отказ ученика: пропускаю superpowers"
  elif [ -z "$claude_bin" ]; then fail superpowers "команда claude не найдена"
  else
    : >"$log"
    claude plugin marketplace add anthropics/claude-plugins-official >>"$log" 2>&1
    claude plugin install superpowers@claude-plugins-official >>"$log" 2>&1
    if has_plugin superpowers; then done_ superpowers; else fail superpowers "claude plugin install superpowers@claude-plugins-official"; fi
  fi

  # --- Playwright MCP ---
  if has_mcp playwright || has_plugin playwright; then ok playwright
  elif declined; then echo "отказ ученика: пропускаю playwright"
  elif [ -z "$claude_bin" ]; then fail playwright "команда claude не найдена"
  else
    : >"$log"
    # Пакет ставится один раз в свою папку: официальный реестр, без .npmrc пользователя и проекта, без скриптов установки.
    mkdir -p "$MCP_PREFIX" && npm install --prefix "$MCP_PREFIX" --registry https://registry.npmjs.org/ --userconfig /dev/null --ignore-scripts --no-audit --no-fund "$PLAYWRIGHT_MCP" >>"$log" 2>&1
    if [ -x "$MCP_PREFIX/node_modules/.bin/playwright-mcp" ]; then
      claude mcp add --scope user playwright -- "$MCP_PREFIX/node_modules/.bin/playwright-mcp" >>"$log" 2>&1
    fi
    if has_mcp playwright; then done_ playwright; else fail playwright "claude mcp add playwright"; fi
  fi

  # --- Agent Reach: zip релиза автора + SHA-256; uv сам не ставим ---
  ar_ready() { has_skill agent-reach && agent-reach version 2>/dev/null | grep -q '"ok": true'; }
  if ar_ready; then ok agent-reach
  elif declined; then echo "отказ ученика: пропускаю agent-reach"
  elif ! command -v uv >/dev/null 2>&1; then echo "ЖДЁТ uv: agent-reach (спроси ученика, см. «Если нет uv»)"; fails=$((fails+1)); missing="$missing agent-reach"; notes="$notes uv"
  else
    : >"$log"
    curl --proto =https --tlsv1.2 -fsSL --max-time 120 -o "$work/ar.zip" "$AR_URL" >>"$log" 2>&1
    if [ "$(shasum -a 256 "$work/ar.zip" 2>/dev/null | cut -d' ' -f1)" = "$AR_SHA256" ]; then
      uv tool install --force "$work/ar.zip" >>"$log" 2>&1 && agent-reach setup >>"$log" 2>&1
    else
      echo "контрольная сумма Agent Reach не совпала, не ставлю" >>"$log"
    fi
    if ar_ready; then done_ agent-reach; else fail agent-reach "uv tool install из релиза v1.6.1"; fi
  fi

  has_mcp 21st || has_mcp 21st-magic || has_mcp magic || { echo "ждёт ключ: 21st (см. klyuch-21st.md)"; notes="$notes 21st"; }
  [ -z "$missing" ] && missing=""
  local final=ok
  [ "$fails" -ne 0 ] && final=partial
  write_state "$final" "$tries" "$(echo $missing)" "$(echo $notes)"
  echo "ошибок: $fails"
}

# Earshot («уши» для Claude): ТОЛЬКО по «да» ученика, вручную через окно «Bash command (unsandboxed)». Не входит ни в --auto, ни в --run.
earshot_mode() {
  local home_dir="$STATE_DIR/earshot" claude_bin
  mkdir -p "$STATE_DIR"
  command -v uv >/dev/null 2>&1 || { echo "ЖДЁТ uv: Earshot (см. «Если нет uv» в ustanovka.md)"; return 0; }
  command -v git >/dev/null 2>&1 || { echo "нужен git"; return 0; }
  claude_bin="$(find_claude)"
  [ -x "$home_dir/bin/earshot" ] || {
    uv venv "$home_dir" --python 3.12 || { echo "НЕ ПОСТАВИЛОСЬ: Earshot (uv venv)"; return 0; }
    uv pip install --python "$home_dir/bin/python" "torch==2.14.1" --index-url "$PYTORCH_CPU_INDEX" || { echo "НЕ ПОСТАВИЛОСЬ: Earshot (torch)"; return 0; }
    uv pip install --python "$home_dir/bin/python" "git+https://github.com/Leonxlnx/earshot@$EARSHOT_SHA" "mcp==2.3.0" || { echo "НЕ ПОСТАВИЛОСЬ: Earshot (пакет)"; return 0; }
  }
  "$home_dir/bin/earshot" doctor --fetch || { echo "НЕ ПОСТАВИЛОСЬ: Earshot (модели)"; return 0; }
  if [ -n "$claude_bin" ]; then "$claude_bin" mcp add --scope user earshot -- "$home_dir/bin/python" -m earshot mcp || echo "MCP не подключился"; else echo "claude не найден: MCP подключить вручную"; fi
  rm -f "$STATE_DIR/earshot-declined"
  echo "Earshot поставлен: $home_dir"
}

case "${1:-}" in
  --earshot) earshot_mode ;;
  --run)    run_mode ;;
  --notice) notice_mode; exit 0 ;;
  --auto)   auto_mode; exit 0 ;;
  *)        echo "использование: kit-install.sh --notice | --auto | --run | --earshot"; exit 0 ;;
esac
