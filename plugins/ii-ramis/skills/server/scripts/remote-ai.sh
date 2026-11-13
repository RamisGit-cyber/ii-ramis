#!/usr/bin/env bash
# Выполняется НА сервере под пользователем ai (srv.sh setup). Можно запускать повторно.
# Ставит: Claude Code, Bun (нужен Telegram-плагину), плагины Telegram и «ИИ Рамис», папку ~/Мозг.
# Правила помощника для сервера дописывает srv.sh (server-rules.md), не затирая правила ученика.
set -euo pipefail
export PATH="$HOME/.local/bin:$HOME/.bun/bin:$PATH"
grep -q '.local/bin' ~/.bashrc || echo 'export PATH="$HOME/.local/bin:$HOME/.bun/bin:$PATH"' >> ~/.bashrc

run_installer() {   # скачать установщик в файл, проверить, что скачался, и запустить
  local url="$1" file
  file="$(mktemp)"
  curl -fsSL -o "$file" "$url"
  bash "$file" </dev/null >/dev/null 2>&1
  rm -f "$file"
}

echo "==> Claude Code"
command -v claude >/dev/null || run_installer https://claude.ai/install.sh
command -v claude >/dev/null || { echo "ОШИБКА: Claude Code не поставился — запусти setup ещё раз"; exit 1; }

echo "==> Bun"
[ -x "$HOME/.bun/bin/bun" ] || run_installer https://bun.sh/install
mkdir -p "$HOME/.local/bin" && ln -sf "$HOME/.bun/bin/bun" "$HOME/.local/bin/bun"

echo "==> Плагины: Telegram (официальный) и ИИ Рамис"
claude plugin marketplace add anthropics/claude-plugins-official </dev/null >/dev/null 2>&1 || true
claude plugin install telegram@claude-plugins-official </dev/null >/dev/null 2>&1 || true
claude plugin marketplace add RamisGit-cyber/ii-ramis </dev/null >/dev/null 2>&1 || true
claude plugin install ii-ramis@ii-ramis </dev/null >/dev/null 2>&1 || true
if ! claude plugin list </dev/null 2>/dev/null | grep -q "telegram@claude-plugins-official"; then
  echo "ОШИБКА: Telegram-плагин не поставился — запусти setup ещё раз"; exit 1
fi

echo "==> Папка второго мозга"
mkdir -p "$HOME/Мозг"/{Входящие,Заметки,Отчёты} "$HOME/.claude"
touch "$HOME/.claude/CLAUDE.md"
python3 - <<'PY'
import json, os
path = os.path.expanduser("~/.claude.json")
state = json.load(open(path)) if os.path.exists(path) else {}
state["hasCompletedOnboarding"] = True
state["bypassPermissionsModeAccepted"] = True
for d in (os.path.expanduser("~/Мозг"), os.path.expanduser("~")):
    state.setdefault("projects", {}).setdefault(d, {})["hasTrustDialogAccepted"] = True
json.dump(state, open(path + ".tmp", "w"))
os.replace(path + ".tmp", path)
PY
echo "ГОТОВО (ai): claude $(claude --version 2>/dev/null | head -1), bun $(bun --version 2>/dev/null)"
