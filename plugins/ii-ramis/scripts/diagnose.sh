#!/usr/bin/env bash
# Проверка компьютера ученика (macOS / Linux). Ничего не меняет, только печатает понятный отчёт.
# Использование: bash diagnose.sh [папка-проекта]
# Идея структуры — diagnose.sh из vibe-coding-mentor Азамата Раймбекова (MIT), переписано под курс «ИИнутый».

PROJECT_DIR="${1:-$PWD}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
KURS_MAP="$HERE/../skills/ii-ramis/references/kurs-karta.md"
CLAUDE_HOME="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
CONFIG="${IIRAMIS_HOME:-$HOME/.ii-ramis}/config.json"
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"

have() { command -v "$1" >/dev/null 2>&1; }
ok()   { printf '  [ок]       %s\n' "$*"; }
warn() { printf '  [внимание] %s\n' "$*"; }
bad()  { printf '  [нет]      %s\n' "$*"; }
head_() { printf '\n== %s ==\n' "$*"; }

echo "ИИ Рамис: проверка компьютера ($(uname -s) $(uname -m))"

head_ "Основные инструменты"
if [ "$(uname -s)" = "Darwin" ]; then
  if xcode-select -p >/dev/null 2>&1; then ok "Инструменты разработчика Apple (нужны для Git): $(xcode-select -p)"; else bad "Инструменты разработчика Apple не стоят (из-за этого не работает Git). Поставит ИИ Рамис: xcode-select --install"; fi
fi
if { [ "$(uname -s)" != "Darwin" ] || xcode-select -p >/dev/null 2>&1; } && have git; then ok "Git: $(git --version)"; else bad "Git не найден"; fi
have node && ok "Node.js: $(node --version)" || bad "Node.js не найден (нужен для сайтов и защитных хуков). Поставит ИИ Рамис: brew install node"
if have python3 && python3 --version >/dev/null 2>&1; then ok "Python: $(python3 --version)"; else warn "Python не найден (не обязателен для урока 4)"; fi
have brew && ok "Homebrew: есть" || warn "Homebrew нет (удобно для установок, но можно обойтись)"
if have gh; then
  ok "GitHub CLI: $(gh --version | head -1)"
  if gh auth status >/dev/null 2>&1; then ok "Вход в GitHub: выполнен"; else warn "В GitHub не вошли. Нужно один раз в браузере: gh auth login"; fi
else
  warn "GitHub CLI (gh) не найден"
fi

head_ "Claude"
if have claude; then ok "Claude Code (терминал): $(claude --version 2>/dev/null | head -1)"; else ok "Команды claude в терминале нет: это нормально, если работаешь во вкладке Code приложения Claude Desktop"; fi
[ -d /Applications/Claude.app ] && ok "Приложение Claude Desktop установлено" || warn "Claude Desktop в /Applications не найден"

head_ "Плагины пакета"
check_plugin() { # check_plugin <id>
  local id="$1" found=1
  if have claude && claude plugin list 2>/dev/null | grep -q "$id"; then found=0; fi
  if [ "$found" = 1 ] && [ -f "$CLAUDE_HOME/settings.json" ] && grep -q "\"$id\": *true" "$CLAUDE_HOME/settings.json"; then found=0; fi
  [ "$found" = 0 ] && ok "$id" || bad "$id не установлен"
}
for plugin in ii-ramis@ii-ramis superpowers@claude-plugins-official claude-mem@thedotmack ecc@ecc; do check_plugin "$plugin"; done

head_ "Подключения (MCP)"
check_mcp() { # check_mcp <имя>
  local name="$1" found=1
  if have claude && claude mcp get "$name" >/dev/null 2>&1; then found=0; fi
  if [ "$found" = 1 ] && [ -f "$HOME/.claude.json" ] && grep -q "\"$name\"" "$HOME/.claude.json"; then found=0; fi
  [ "$found" = 0 ] && ok "$name" || bad "$name не подключён"
}
check_mcp context7; check_mcp playwright

head_ "Сохранения (Git) в этой папке"
if (cd "$PROJECT_DIR" 2>/dev/null && git rev-parse --git-dir >/dev/null 2>&1); then
  ok "Папка под Git: $(cd "$PROJECT_DIR" && git log --oneline 2>/dev/null | wc -l | tr -d ' ') сохранений"
  [ -f "$PROJECT_DIR/.gitignore" ] && ok ".gitignore есть" || warn ".gitignore нет"
  if [ -f "$PROJECT_DIR/.env" ]; then
    (cd "$PROJECT_DIR" && git check-ignore -q .env) && ok ".env спрятан от Git" || bad ".env НЕ спрятан от Git: ключи могут утечь в облако"
  fi
else
  warn "Эта папка не под Git (нет сохранений как в игре)"
fi

head_ "Домашка по пройденным урокам"
LESSON=""
[ -f "$CONFIG" ] && LESSON="$(sed -n 's/.*"lesson": *\([0-9][0-9]*\).*/\1/p' "$CONFIG" | head -1)"
if [ -z "$LESSON" ]; then
  warn "Номер пройденного урока неизвестен: спроси ученика и запиши (config.mjs set lesson N)"
elif [ ! -f "$KURS_MAP" ]; then
  warn "Не нашёл kurs-karta.md"
else
  echo "  Пройдено уроков: $LESSON. Проверь каждый пункт (команду запускай сам, остальное спроси одним вопросом):"
  awk -v max="$LESSON" '
    /^## Урок [0-9]+/ { match($0, /[0-9]+/); lesson = substr($0, RSTART, RLENGTH) + 0; in_list = 0; if (lesson <= max) print "  Урок " lesson ":" ; next }
    /^### Чек-лист наставника/ { in_list = 1; next }
    /^#/ { in_list = 0 }
    in_list && /^- \[ \]/ && lesson <= max { sub(/^- \[ \] /, "    - "); print }
  ' "$KURS_MAP"
fi
echo
echo "Готово. Недостающее ИИ Рамис ставит сам и объясняет простыми словами."
exit 0
