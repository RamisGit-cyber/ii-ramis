#!/usr/bin/env bash
# Выполняется НА сервере под ai (srv.sh tg-start). Ставит запуск бота и сторож:
#  ~/assistant/start-bot.sh — поднимает Claude с Telegram в tmux-сессии «bot», если её нет;
#  assistant.timer — каждые 5 минут и через минуту после загрузки проверяет и поднимает бота;
#  daily-restart.timer — каждую ночь в 05:00 чистый перезапуск (свежая память разговора, без зависаний).
set -euo pipefail
export PATH="$HOME/.local/bin:$HOME/.bun/bin:$PATH"
[ -s "$HOME/.claude/channels/telegram/.env" ] || { echo "ОШИБКА: нет токена бота — сначала srv.sh tg-token"; exit 1; }
mkdir -p "$HOME/assistant" "$HOME/.config/systemd/user"

# Без этого Claude при запуске с --dangerously-skip-permissions ждёт подтверждения на экране, и бот молчит.
python3 - <<'PY'
import json, os
path = os.path.expanduser("~/.claude/settings.json")
settings = json.load(open(path)) if os.path.exists(path) else {}
if settings.get("skipDangerousModePermissionPrompt") is not True:
    settings["skipDangerousModePermissionPrompt"] = True
    json.dump(settings, open(path + ".tmp", "w"), indent=2)
    os.replace(path + ".tmp", path)
PY

cat > "$HOME/assistant/start-bot.sh" <<'SH'
#!/usr/bin/env bash
# Поднимает Claude в Telegram, если он не запущен. Безопасно вызывать сколько угодно раз.
set -euo pipefail
export PATH="$HOME/.local/bin:$HOME/.bun/bin:/usr/local/bin:/usr/bin:/bin"
SESSION=bot
WORKDIR="$HOME/Мозг"
tmux has-session -t "$SESSION" 2>/dev/null && exit 0
python3 - "$WORKDIR" <<'PY'
import json, os, sys
path = os.path.expanduser("~/.claude.json")
state = json.load(open(path)) if os.path.exists(path) else {}
dirs = (sys.argv[1], os.path.expanduser("~"))
if state.get("hasCompletedOnboarding") and state.get("bypassPermissionsModeAccepted") and \
        state.get("fullscreenUpsellSeenCount", 0) >= 99 and all(
        state.get("projects", {}).get(d, {}).get("hasTrustDialogAccepted") for d in dirs):
    sys.exit(0)   # всё уже настроено — файл не трогаем, чтобы не спорить с самим Claude
state["hasCompletedOnboarding"] = True
# Окно «Try the new fullscreen renderer?» висит поверх чата и блокирует ответы бота — считаем, что его уже видели.
state["fullscreenUpsellSeenCount"] = max(state.get("fullscreenUpsellSeenCount", 0), 99)
state["bypassPermissionsModeAccepted"] = True
for d in (sys.argv[1], os.path.expanduser("~")):
    state.setdefault("projects", {}).setdefault(d, {})["hasTrustDialogAccepted"] = True
json.dump(state, open(path + ".tmp", "w")); os.replace(path + ".tmp", path)
PY
tmux new-session -d -s "$SESSION" -x 200 -y 50 -c "$WORKDIR" \
  -e "TELEGRAM_STATE_DIR=$HOME/.claude/channels/telegram" \
  claude --channels plugin:telegram@claude-plugins-official --dangerously-skip-permissions \
  --settings '{"enabledPlugins":{"telegram@claude-plugins-official":true}}'
echo "Бот запущен (tmux: $SESSION)"
SH
chmod +x "$HOME/assistant/start-bot.sh"

cat > "$HOME/.config/systemd/user/assistant.service" <<'UNIT'
[Unit]
Description=Claude в Telegram: поднять, если не запущен
[Service]
Type=oneshot
KillMode=process
Environment=PATH=%h/.local/bin:%h/.bun/bin:/usr/local/bin:/usr/bin:/bin
Environment=LANG=C.UTF-8
ExecStart=/bin/bash %h/assistant/start-bot.sh
UNIT
cat > "$HOME/.config/systemd/user/assistant.timer" <<'UNIT'
[Unit]
Description=Проверка бота каждые 5 минут
[Timer]
OnBootSec=60s
OnUnitActiveSec=5min
[Install]
WantedBy=timers.target
UNIT
cat > "$HOME/.config/systemd/user/daily-restart.service" <<'UNIT'
[Unit]
Description=Ночной чистый перезапуск бота
[Service]
Type=oneshot
KillMode=process
Environment=PATH=%h/.local/bin:%h/.bun/bin:/usr/local/bin:/usr/bin:/bin
ExecStart=/bin/bash -c 'tmux kill-session -t bot 2>/dev/null; sleep 3; /bin/bash %h/assistant/start-bot.sh'
UNIT
cat > "$HOME/.config/systemd/user/daily-restart.timer" <<'UNIT'
[Unit]
Description=Каждую ночь в 05:00
[Timer]
OnCalendar=*-*-* 05:00
Persistent=true
[Install]
WantedBy=timers.target
UNIT

export XDG_RUNTIME_DIR="/run/user/$(id -u)"
systemctl --user daemon-reload
systemctl --user enable --now assistant.timer daily-restart.timer >/dev/null
bash "$HOME/assistant/start-bot.sh"
sleep 15
screen="$(tmux capture-pane -pt bot -S -30 2>/dev/null || true)"
if grep -qiE "not logged in|please run /login|invalid api key" <<<"$screen"; then
  echo "ОШИБКА: Claude на сервере не вошёл в аккаунт — сначала srv.sh login-start и login-code, потом tg-start ещё раз"
  tmux kill-session -t bot 2>/dev/null || true
elif tmux has-session -t bot 2>/dev/null; then
  echo "БОТ РАБОТАЕТ. Сторож и ночной перезапуск включены."
  tmux capture-pane -pt bot -S -15 | grep -iE "telegram|listening|error|ошибк" | tail -3 || true
else
  echo "ОШИБКА: бот не поднялся. Экран:"; tmux capture-pane -pt bot -S -20 2>/dev/null | tail -15 || true
fi
