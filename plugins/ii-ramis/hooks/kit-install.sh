#!/usr/bin/env bash
# ИИ Рамис 2.6: установка набора курса (урок 5) скриптом хука SessionStart.
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

KIT_VERSION="2.6.0"
STATE_DIR="$HOME/.ii-ramis"
STATE="$STATE_DIR/nabor.json"
LOCK="$STATE_DIR/nabor.lock"
LOG="$STATE_DIR/nabor.log"
SELF="${BASH_SOURCE[0]}"

# --- закреплённые источники (проверены 04.11.2026) ---
SKILLS_CLI="skills@1.7.6"
PLAYWRIGHT_MCP="@playwright/mcp@0.0.84"
MCP_PREFIX="$HOME/.ii-ramis/mcp" # сюда ставится Playwright MCP, чтобы Claude запускал его по абсолютному пути, а не через npx из папки проекта
HYPERFRAMES_SHA="1ff4cefd40c8dad98127fc78e8761c1ac62053dd" # тег v0.9.12 репозитория heygen-com/hyperframes
AR_URL="https://github.com/Panniantong/Agent-Reach/releases/download/v1.6.1/agent-reach.zip"
AR_SHA256="51443d733bcb26064262442083a8f8abf6ba5e3e7df54beebafe98c88be04a60"
REMOTION_SHA="c7cb2fdcacd134fb2ccb9b7a44f9ffa44e467271"
GSAP_SHA="aed9cfd3277740755f6bfc1155c7aa645403b760" # greensock/gsap-skills (MIT), коммит от 06.11.2026

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
  emit "ИИ Рамис ставит инструменты урока 5 в фоне (2–5 минут, вводить ничего не нужно). Не хочешь: напиши «не ставь набор»." "ИИ Рамис: хук ставит набор 2.6.0 в фоне вне песочницы. Скажи ученику одной строкой, что ставится и как отказаться (отказ «не ставь набор» запишет хук сам, файлы не пиши: установка остановится на следующем шаге). Саму установку Bash-командами не запускай: Bash в песочнице не может писать в ~/.claude."
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
    ok)      emit "Набор урока 5 поставлен. Закрой сессию и открой заново (или напиши /reload-plugins), тогда всё подхватится." "ИИ Рамис: установка набора 2.6.0 завершена, status ok. Заметки (notes): ${notes:-нет}. Скажи ученику перезапустить сессию; про notes объясни по разделу 1 навыка nabor." ;;
    partial) emit "Часть набора не поставилась: ${missing:-см. журнал}. Скажи об этом ИИ Рамису." "ИИ Рамис: установка набора 2.6.0 не дошла до конца (status partial). Не поставилось: ${missing:-неизвестно}. Заметки: ${notes:-нет}. Разбери по разделу 1 навыка nabor, журнал ~/.ii-ramis/nabor.log." ;;
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
  node_fresh() { command -v node >/dev/null 2>&1 && node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=20)?0:1)' 2>/dev/null; }
  if [ "$(uname -s)" = "Darwin" ] && command -v brew >/dev/null 2>&1 && ! declined; then
    export HOMEBREW_NO_AUTO_UPDATE=1 HOMEBREW_NO_ANALYTICS=1 HOMEBREW_NO_INSTALL_CLEANUP=1 HOMEBREW_NO_ENV_HINTS=1
    # Только если Node нет совсем: чужой старый Node не обновляем молча (может сломать другие проекты ученика), он попадёт в notes.
    if ! command -v node >/dev/null 2>&1; then
      : >"$log"; brew install node >>"$log" 2>&1
      node_fresh && echo "поставил: node" || echo "node не поставился (см. журнал)"
    fi
    if ! command -v ffmpeg >/dev/null 2>&1; then
      : >"$log"; brew install ffmpeg >>"$log" 2>&1
      command -v ffmpeg >/dev/null 2>&1 && echo "поставил: ffmpeg" || echo "ffmpeg не поставился (см. журнал)"
    fi
  fi
  local node_ok=0 git_ok=0
  if command -v node >/dev/null 2>&1 && node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=20)?0:1)' 2>/dev/null; then node_ok=1; else notes="$notes node"; fi
  command -v git >/dev/null 2>&1 && git_ok=1 || notes="$notes git"
  [ -n "$claude_bin" ] || notes="$notes claude"
  command -v ffmpeg >/dev/null 2>&1 || notes="$notes ffmpeg"

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
    npx --yes "$SKILLS_CLI" add "$dir" --skill "${skill_args[@]}" -g -a claude-code -y --copy >>"$log" 2>&1
    if has_skill "$marker"; then done_ "$marker"; else fail "$marker" "нужны git и Node 22.20 или новее"; fi
  }

  skill_pinned vercel-labs/skills 7a5e920bead4b1039a6d6df5d7e1163b7b09423a find-skills find-skills
  skill_pinned emilkowalski/skills f1090bec277140d02ed202440185ad9d02ac1490 emil-design-eng emil-design-eng
  skill_pinned pbakaus/impeccable 9fadc41729c38fd47d7ae622b501558653f9d2e9 impeccable impeccable
  skill_pinned blader/humanizer 0ef9fe5bc3572734fd3ae6c448fe00a30cd5dcf0 humanizer humanizer
  # Remotion: все навыки репозитория (remotion-best-practices маршрутизирует по остальным)
  skill_pinned remotion-dev/skills "$REMOTION_SHA" '*' remotion-best-practices

  # GSAP: официальные навыки GreenSock (домашка урока 5), только gsap-*, на закреплённом коммите
  skill_pinned greensock/gsap-skills "$GSAP_SHA" "gsap-core gsap-frameworks gsap-performance gsap-plugins gsap-react gsap-scrolltrigger gsap-timeline gsap-utils" gsap-core

  # --- HyperFrames: основной набор навыков HeyGen из клона на закреплённом коммите (тег v0.9.12), без их установщика ---
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

case "${1:-}" in
  --run)    run_mode ;;
  --notice) notice_mode; exit 0 ;;
  --auto)   auto_mode; exit 0 ;;
  *)        echo "использование: kit-install.sh --notice | --auto | --run"; exit 0 ;;
esac
