#!/usr/bin/env bash
# Выполняется НА сервере под ai (srv.sh login-start): запускает вход в Claude в tmux-сессии «login» и печатает ссылку.
# Дальше: ученик открывает ссылку, входит, присылает код → srv.sh login-code <код>.
set -euo pipefail
export PATH="$HOME/.local/bin:$HOME/.bun/bin:$PATH"
cd "$HOME/Мозг"
tmux kill-session -t login 2>/dev/null || true
tmux new-session -d -s login -x 250 -y 50 -c "$HOME/Мозг" "$HOME/.local/bin/claude"

# Вопросы первого запуска: доверие к папке — Enter только когда выделено «Yes».
moves=(Down Up Down Up); step=0
for _ in $(seq 1 12); do
  sleep 3
  screen="$(tmux capture-pane -pt login -S -40 || true)"
  if grep -qiE "trust this folder|do you trust|trust the files" <<<"$screen"; then
    if grep -qE "❯[[:space:]]*[0-9]\.[[:space:]]*Yes" <<<"$screen"; then tmux send-keys -t login Enter
    else tmux send-keys -t login "${moves[$((step % 4))]}"; step=$((step + 1)); fi
  elif grep -qiE "select login method|claude account with subscription" <<<"$screen"; then
    break
  elif grep -qE "^[[:space:]]*❯" <<<"$screen" || grep -qiE "welcome|/help" <<<"$screen"; then
    tmux send-keys -t login "/login" Enter; sleep 3; break
  fi
done

# Способ входа: подписка Claude (первый пункт)
for _ in $(seq 1 8); do
  sleep 2
  screen="$(tmux capture-pane -pt login -S -40 || true)"
  if grep -qiE "select login method" <<<"$screen"; then tmux send-keys -t login Enter; sleep 4; break; fi
  grep -qE "https://claude\.(ai|com)/" <<<"$screen" && break
done

tmux resize-window -t login -x 1000 -y 50 2>/dev/null || true
sleep 2
url=""
for _ in $(seq 1 10); do
  url="$(tmux capture-pane -pt login -J -S -80 | grep -oE 'https://claude\.(ai|com)/[^[:space:]]+' | tail -1 || true)"
  [ -n "$url" ] && break
  sleep 2
done
if [ -n "$url" ]; then
  echo "ССЫЛКА ДЛЯ ВХОДА: $url"
else
  echo "Ссылка не появилась. Экран входа:"; tmux capture-pane -pt login -S -20 | tail -15
fi
