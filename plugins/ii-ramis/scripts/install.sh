#!/usr/bin/env bash
# Установщик пакета «ИИ Рамис» для macOS (и Linux). Идемпотентный: повторный запуск безопасен.
# Запуск:  curl -fsSL https://raw.githubusercontent.com/RamisGit-cyber/ii-ramis/v1.0.0/plugins/ii-ramis/scripts/install.sh | bash
# Ставится версия с тега релиза (v1.0.0), а не с ветки main: так ученику не прилетит непроверенный код.
# Флаги:   --dry-run  показать, что будет сделано, ничего не меняя
#          --share yes|no   отправлять Рамису краткий итог занятий. «yes» работает ТОЛЬКО при запуске из обычного окна
#                           терминала (иначе игнорируется: согласие даёт человек, а не команда из чата)
#          --name "Имя"     как подписывать итог (только если share=yes)
#          --skip-third-party  поставить только плагин ИИ Рамис (для проверки)
# Режим Claude «без вопросов» (bypass) и сводки включаются только ответом «да» живого человека в терминале.
set -u

RELEASE_TAG="v1.0.0"
RAW_BASE="${IIRAMIS_RAW_BASE:-https://raw.githubusercontent.com/RamisGit-cyber/ii-ramis/$RELEASE_TAG/plugins/ii-ramis/scripts}"
MARKETPLACE_SOURCE="${IIRAMIS_MARKETPLACE_SOURCE:-RamisGit-cyber/ii-ramis#$RELEASE_TAG}"
DRY_RUN=0; SHARE=""; STUDENT_NAME=""; SKIP_THIRD=0

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --share) SHARE="${2:-}"; shift ;;
    --name) STUDENT_NAME="${2:-}"; shift ;;
    --skip-third-party) SKIP_THIRD=1 ;;
    *) echo "Не знаю флаг: $1"; exit 2 ;;
  esac
  shift
done

REPORT=()
add_report() {   # статус|что|подробность
  local detail="$3"; [ "$DRY_RUN" = 1 ] && detail="(проба) $detail"
  REPORT+=("$1|$2|$detail")
}
say() { printf '%s\n' "$*"; }
run() {   # run <описание команды...>; в режиме пробы только печатает
  if [ "$DRY_RUN" = 1 ]; then say "  [проба] $*"; return 0; fi
  "$@"
}
have() { command -v "$1" >/dev/null 2>&1; }

# Запуск «из терминала»: вывод идёт на экран человека и есть откуда читать ответ (stdin или /dev/tty).
# При запуске из чата Claude вывод перехватывается, поэтому INTERACTIVE=0 и никакие вопросы не задаются.
INTERACTIVE=0; ANSWER_FROM=/dev/null
if [ -t 1 ]; then
  if [ -t 0 ]; then INTERACTIVE=1; ANSWER_FROM=/dev/stdin
  elif ( : </dev/tty ) 2>/dev/null; then INTERACTIVE=1; ANSWER_FROM=/dev/tty
  fi
fi

export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
OS="$(uname -s)"
say "ИИ Рамис: установка пакета. Это займёт несколько минут."
[ "$DRY_RUN" = 1 ] && say "(режим пробы: ничего не меняю)"

# ---------- 1. Базовые инструменты ----------
if [ "$OS" = "Darwin" ]; then
  if xcode-select -p >/dev/null 2>&1; then
    add_report ok "Git (инструменты разработчика Apple)" "$(git --version 2>/dev/null)"
  else
    run xcode-select --install >/dev/null 2>&1
    add_report need "Git (инструменты разработчика Apple)" "Появится окно macOS: нажми «Установить» и «Принимаю». Потом запусти установщик ещё раз."
  fi
elif have git; then
  add_report ok "Git" "$(git --version)"
else
  add_report need "Git" "Поставь Git через менеджер пакетов системы и запусти установщик ещё раз."
fi

NODE_BIN=""
if have node; then
  NODE_BIN="$(command -v node)"
  add_report ok "Node.js" "$(node --version)"
else
  if have brew; then
    say "Node.js не найден, ставлю через Homebrew..."
    run brew install node >/dev/null 2>&1
  fi
  if ! have node && [ "$OS" = "Darwin" ] || { ! have node && [ "$(uname -m)" = "x86_64" ] && [ "$OS" = "Linux" ]; }; then
    ARCH="$(uname -m)"; [ "$ARCH" = "arm64" ] && NODE_ARCH="arm64" || NODE_ARCH="x64"
    NODE_OS="darwin"; [ "$OS" = "Linux" ] && NODE_OS="linux"
    say "Homebrew нет, скачиваю Node.js в папку ~/.ii-ramis/node (без пароля администратора)..."
    if [ "$DRY_RUN" = 0 ]; then
      NODE_BASE="https://nodejs.org/dist/latest-v22.x"
      NODE_FILE="$(curl -fsSL "$NODE_BASE/SHASUMS256.txt" | grep -o "node-v[0-9.]*-$NODE_OS-$NODE_ARCH.tar.gz" | head -1)"
      if [ -n "$NODE_FILE" ]; then
        mkdir -p "$HOME/.ii-ramis" "$HOME/.local/bin"
        rm -rf "$HOME/.ii-ramis/node"
        mkdir "$HOME/.ii-ramis/node"
        curl -fsSL "$NODE_BASE/$NODE_FILE" | tar -xz -C "$HOME/.ii-ramis/node" --strip-components=1
        for tool in node npm npx; do ln -sf "$HOME/.ii-ramis/node/bin/$tool" "$HOME/.local/bin/$tool"; done
      fi
    fi
  fi
  if have node; then
    NODE_BIN="$(command -v node)"
    add_report done "Node.js" "$(node --version) поставлен"
  elif [ "$DRY_RUN" = 1 ]; then
    add_report ok "Node.js" "[проба] будет поставлен"
  else
    add_report need "Node.js" "Не получилось поставить. Скачай LTS на nodejs.org и запусти установщик ещё раз."
  fi
fi

if have python3 && python3 --version >/dev/null 2>&1; then
  add_report ok "Python" "$(python3 --version)"
else
  have brew && run brew install python >/dev/null 2>&1
  have python3 && add_report done "Python" "$(python3 --version) поставлен" || add_report skip "Python" "не обязателен для урока 4, поставим позже"
fi

if have gh; then
  add_report ok "GitHub CLI (gh)" "$(gh --version | head -1)"
else
  have brew && run brew install gh >/dev/null 2>&1
  have gh && add_report done "GitHub CLI (gh)" "поставлен" || add_report skip "GitHub CLI (gh)" "не получилось, поставит ИИ Рамис на уроке про GitHub"
fi
if have gh; then
  gh auth status >/dev/null 2>&1 && add_report ok "Вход в GitHub" "выполнен" || add_report need "Вход в GitHub" "Нужен один раз в браузере: ИИ Рамис проведёт, когда понадобится (команда gh auth login)."
fi

# ---------- 2. Скрипт настроек (рядом лежит или скачиваем) ----------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd || true)"
SETUP_JS=""
if [ -n "$SCRIPT_DIR" ] && [ -f "$SCRIPT_DIR/setup-settings.mjs" ]; then
  SETUP_JS="$SCRIPT_DIR/setup-settings.mjs"
  if [ "$DRY_RUN" = 0 ]; then   # копия в ~/.ii-ramis: по ней ученик сам включает режим «без вопросов» из терминала
    mkdir -p "$HOME/.ii-ramis" && cp -f "$SETUP_JS" "$HOME/.ii-ramis/setup-settings.mjs" 2>/dev/null
  fi
elif [ -n "$NODE_BIN" ] && [ "$DRY_RUN" = 0 ]; then
  mkdir -p "$HOME/.ii-ramis"
  SETUP_JS="$HOME/.ii-ramis/setup-settings.mjs"
  curl -fsSL "$RAW_BASE/setup-settings.mjs" -o "$SETUP_JS" || SETUP_JS=""
fi
setup() {   # setup <аргументы setup-settings.mjs>
  if [ -z "$NODE_BIN" ] || [ -z "$SETUP_JS" ]; then
    if [ "$DRY_RUN" = 1 ]; then say "  [проба] node setup-settings.mjs $*"; return 0; fi
    return 1
  fi
  local extra=""; [ "$DRY_RUN" = 1 ] && extra="--dry-run"
  "$NODE_BIN" "$SETUP_JS" $extra "$@"
}

# ---------- 3. Согласие на отправку итогов ----------
# Из чата (не терминал) согласие дать нельзя: --share yes игнорируем, остальное (no) безопасно.
if [ "$INTERACTIVE" = 0 ] && [ "$SHARE" = "yes" ]; then
  say "Флаг --share yes проигнорирован: установщик запущен не из обычного окна терминала. Согласие на отправку итогов даёшь только ты сам, ответом в терминале."
  SHARE=""; STUDENT_NAME=""
fi
if [ -z "$SHARE" ] && [ "$INTERACTIVE" = 1 ] && [ "$DRY_RUN" = 0 ]; then
  say ""
  say "Рамис хочет видеть, где ты застрял, чтобы помочь. Для этого после занятия можно отправлять КРАТКИЙ итог:"
  say "номер урока, сколько раз застрял, какие ошибки (без путей и ключей). Кода и твоих файлов в нём нет."
  printf 'Отправлять итог Рамису? [y/N] '
  read -r answer < "$ANSWER_FROM"
  case "$answer" in y|Y|д|Д|да|Да) SHARE="yes" ;; *) SHARE="no" ;; esac
fi

# ---------- 4. Плагины и MCP ----------
CLAUDE_BIN=""
have claude && CLAUDE_BIN="$(command -v claude)"

install_plugin() {   # install_plugin <маркетплейс-имя> <источник> <плагин>
  local mk_name="$1" mk_source="$2" plugin="$3" id="$3@$1"
  if [ -n "$CLAUDE_BIN" ]; then
    if "$CLAUDE_BIN" plugin list 2>/dev/null | grep -q "$id"; then
      add_report ok "Плагин $plugin" "уже установлен"; return
    fi
    run "$CLAUDE_BIN" plugin marketplace add "$mk_source" >/dev/null 2>&1
    if run "$CLAUDE_BIN" plugin install "$id" >/dev/null 2>&1; then
      add_report done "Плагин $plugin" "установлен через claude plugin install"
    else
      add_report fail "Плагин $plugin" "не поставился командой, пробую через настройки"
      setup --marketplace "$mk_name" --enable "$id" >/dev/null 2>&1 && add_report done "Плагин $plugin" "включён в настройках, скачается при запуске"
    fi
  else
    if setup --marketplace "$mk_name" --enable "$id" >/dev/null; then
      add_report done "Плагин $plugin" "включён в настройках, скачается при следующем запуске Claude"
    else
      add_report fail "Плагин $plugin" "нет ни команды claude, ни Node для правки настроек"
    fi
  fi
}

install_mcp() {   # install_mcp <имя> <команда...>
  local name="$1"; shift
  if [ -n "$CLAUDE_BIN" ]; then
    if "$CLAUDE_BIN" mcp get "$name" >/dev/null 2>&1; then add_report ok "MCP $name" "уже подключён"; return; fi
    if run "$CLAUDE_BIN" mcp add --scope user "$name" -- "$@" >/dev/null 2>&1; then
      add_report done "MCP $name" "подключён"; return
    fi
  fi
  if setup --mcp "$name" >/dev/null; then add_report done "MCP $name" "добавлен в ~/.claude.json"; else add_report fail "MCP $name" "не получилось"; fi
}

if [ "$SKIP_THIRD" = 0 ]; then
  install_plugin claude-plugins-official anthropics/claude-plugins-official superpowers
  install_plugin thedotmack thedotmack/claude-mem claude-mem
  install_plugin ecc affaan-m/ECC ecc
  install_mcp context7 npx -y @upstash/context7-mcp
  install_mcp playwright npx @playwright/mcp@latest
fi
install_plugin ii-ramis "$MARKETPLACE_SOURCE" ii-ramis

# ---------- 5. Настройки: маркетплейс с тега, согласие ----------
# Автообновление НЕ включаем: обновляться на новую версию ученик будет сам (см. README).
SETUP_ARGS=(--marketplace ii-ramis)
[ -n "$SHARE" ] && SETUP_ARGS+=(--share "$SHARE")
[ -n "$STUDENT_NAME" ] && SETUP_ARGS+=(--student-name "$STUDENT_NAME")
if OUT="$(setup "${SETUP_ARGS[@]}" 2>&1)"; then
  add_report done "Настройки Claude" "$(printf '%s' "$OUT" | tr '\n' ';' | cut -c1-160)"
else
  add_report fail "Настройки Claude" "$OUT"
fi

# Режим «без вопросов»: явный вопрос с предупреждением, по умолчанию «нет». Вопрос задаёт setup-settings.mjs.
if [ "$DRY_RUN" = 1 ]; then
  say "  [проба] node setup-settings.mjs --ask-bypass (вопрос про режим «без вопросов», по умолчанию нет)"
  add_report skip "Режим «без вопросов»" "(проба) будет задан вопрос, по умолчанию «нет»"
elif [ "$INTERACTIVE" = 1 ] && [ -n "$NODE_BIN" ] && [ -n "$SETUP_JS" ]; then
  "$NODE_BIN" "$SETUP_JS" --ask-bypass < "$ANSWER_FROM"
  add_report done "Режим «без вопросов»" "вопрос задан, твой ответ учтён (подробности выше)"
else
  add_report need "Режим «без вопросов»" "не включён. Хочешь включить: открой Терминал и вставь node ~/.ii-ramis/setup-settings.mjs --ask-bypass (прочитаешь предупреждение и ответишь сам)"
fi

# ---------- 6. Итог ----------
say ""
say "===== Что сделано ====="
NEED=0; FAIL=0
for line in "${REPORT[@]}"; do
  status="${line%%|*}"; rest="${line#*|}"; what="${rest%%|*}"; detail="${rest#*|}"
  case "$status" in
    ok) mark="[уже было]" ;;
    done) mark="[сделано]" ;;
    skip) mark="[пропущено]" ;;
    need) mark="[нужно от тебя]"; NEED=1 ;;
    fail) mark="[не вышло]"; FAIL=1 ;;
  esac
  say "$mark $what: $detail"
done
say ""
say "Дальше: полностью закрой Claude и открой заново, затем напиши в чате «привет». Если что-то в списке не вышло или нужно от тебя, просто скажи об этом ИИ Рамису в чате."
say "Режим «без вопросов» включается только твоим «да» в терминале (см. выше). Обновления плагина сами не приходят: как обновить, написано в README."
[ "$FAIL" = 1 ] && exit 1
exit 0
