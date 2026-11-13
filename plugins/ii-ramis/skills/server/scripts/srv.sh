#!/usr/bin/env bash
# Навык «свой сервер»: всё, что Claude делает с компьютера ученика (Mac или Windows с Git Bash).
# Состояние: ~/.ii-server/ (адрес сервера, ключ доступа, временный пароль root — права 600).
# Секреты (пароль, токен бота, код входа) передаются ТОЛЬКО через stdin, не аргументами, и не печатаются.
# Команды: newpass | savepass < пароль | init <IP> | setup | push <папка> | login-start | login-code < код |
#          tg-token < токен | tg-start | tg-pair <код> | rules | status | ssh "<команда>" | root "<команда>"
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STATE="$HOME/.ii-server"
KEY="$STATE/id_ed25519"
PASSFILE="$STATE/root-password"
mkdir -p "$STATE" && chmod 700 "$STATE"

die() { echo "ОШИБКА: $*" >&2; exit 1; }
if grep -q $'\r' "$HERE"/*.sh 2>/dev/null; then die "скрипты навыка испорчены переводом строк Windows — напиши «обнови плагин ИИ Рамис»"; fi
ip_of() { [ -s "$STATE/ip" ] || die "нет адреса сервера: сначала srv.sh init <IP>"; cat "$STATE/ip"; }
ssh_opts=(-o StrictHostKeyChecking=accept-new -o ConnectTimeout=20 -o ServerAliveInterval=20 -o UserKnownHostsFile="$STATE/known_hosts")
as_root() { ssh "${ssh_opts[@]}" -o BatchMode=yes -i "$KEY" "root@$(ip_of)" "$@"; }
as_ai()   { ssh "${ssh_opts[@]}" -o BatchMode=yes -i "$KEY" "ai@$(ip_of)" "$@"; }
# Блок правил между метками заменяется целиком (новая версия плагина обновляет правила), остальное в CLAUDE.md ученика не трогаем.
add_rules() { as_ai 'mkdir -p ~/.claude && touch ~/.claude/CLAUDE.md && python3 -c "
import re, sys, pathlib
path = pathlib.Path.home() / \".claude/CLAUDE.md\"
block = sys.stdin.read().strip()
text = path.read_text(encoding=\"utf-8\")
pattern = re.compile(r\"<!-- ii-ramis:server-rules -->.*?<!-- /ii-ramis:server-rules -->\", re.S)
start, end = \"<!-- ii-ramis:server-rules -->\", \"<!-- /ii-ramis:server-rules -->\"
if text.count(start) == 1 and text.count(end) == 1 and pattern.search(text):
    text = pattern.sub(lambda m: block, text)
elif start not in text:
    text = text.rstrip() + \"\\n\\n\" + block + \"\\n\"
else:
    sys.exit(\"метки правил в CLAUDE.md повреждены, правила не тронуты\")
tmp = path.with_suffix(\".md.tmp\")
tmp.write_text(text, encoding=\"utf-8\")
tmp.replace(path)
"' < "$HERE/server-rules.md"; }
read_secret() { IFS= read -r value || true; value="${value//$'\r'/}"; printf '%s' "$value"; }

case "${1:-}" in
  newpass)
    # 20 символов: заглавные, строчные и цифры — подходит под правила Contabo и OVH.
    while :; do
      pw="$(LC_ALL=C tr -dc 'A-Za-z0-9' </dev/urandom 2>/dev/null | head -c 20 || true)"
      [[ ${#pw} -eq 20 && "$pw" =~ [A-Z] && "$pw" =~ [a-z] && "$pw" =~ [0-9] ]] && break
    done
    printf '%s' "$pw" > "$PASSFILE"; chmod 600 "$PASSFILE"
    echo "$pw" ;;
  savepass)
    pw="$(read_secret)"; [ -n "$pw" ] || die "пароль пустой"
    printf '%s' "$pw" > "$PASSFILE"; chmod 600 "$PASSFILE"; echo "пароль сохранён" ;;
  init)
    ip="${2:?Укажи IP сервера}"
    [[ "$ip" =~ ^([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})$ ]] || die "это не похоже на IP: $ip"
    for octet in "${BASH_REMATCH[@]:1}"; do [ "$octet" -le 255 ] || die "это не похоже на IP: $ip"; done
    echo "$ip" > "$STATE/ip"
    ssh-keygen -R "$ip" -f "$STATE/known_hosts" >/dev/null 2>&1 || true   # сервер переустановлен на том же IP — старый отпечаток мешает
    [ -f "$KEY" ] || ssh-keygen -q -t ed25519 -N "" -C "ii-ramis-server" -f "$KEY"
    if as_root true 2>/dev/null; then echo "Ключ уже работает"; exit 0; fi
    [ -s "$PASSFILE" ] || die "нет пароля root. Пароль пришёл письмом — передай его в savepass через stdin"
    echo "Первый вход по паролю (один раз), кладу ключ доступа…"
    askpass="$STATE/askpass.sh"
    printf '#!/bin/sh\ncat "%s"\n' "$PASSFILE" > "$askpass"; chmod 700 "$askpass"
    SSH_ASKPASS="$askpass" SSH_ASKPASS_REQUIRE=force DISPLAY="${DISPLAY:-:0}" \
      ssh "${ssh_opts[@]}" -o PreferredAuthentications=password,keyboard-interactive -o PubkeyAuthentication=no \
      "root@$ip" "mkdir -p ~/.ssh && chmod 700 ~/.ssh && cat >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys" < "$KEY.pub" || true
    rm -f "$askpass"
    as_root true || die "не получилось войти: проверь IP и пароль; если сервер только что создан — подожди 5 минут и повтори"
    echo "Ключ доступа установлен, дальше вход только по ключу" ;;
  setup)
    as_root 'bash -s' < "$HERE/remote-root.sh"
    as_ai 'bash -s' < "$HERE/remote-ai.sh"
    add_rules
    rm -f "$PASSFILE"   # пароль root больше не нужен: вход по паролю на сервере выключен, сам пароль заблокирован
    echo "Пароль root удалён с компьютера (на сервер теперь входим только по ключу)" ;;
  push)
    src="${2:?Укажи папку второго мозга}"
    [ -d "$src" ] || die "нет такой папки: $src"
    tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
    secrets=(--exclude='.env' --exclude='.env.*' --exclude='*.pem' --exclude='*.key' --exclude='id_rsa*' --exclude='id_ed25519*'
             --exclude='credentials*' --exclude='*.secret' --exclude='.ii-server' --exclude='.git' --exclude='.ssh')
    junk=(--exclude='node_modules' --exclude='.next' --exclude='dist' --exclude='.DS_Store' --exclude='._*')
    echo "Собираю архив (без ключей и .env, node_modules и файлов больше 200 МБ)…"
    found="$(cd "$src" && find . \( -name '.env' -o -name '.env.*' -o -name '*.pem' -o -name '*.key' -o -name 'credentials*' -o -name '*.secret' \) -not -path '*/node_modules/*' 2>/dev/null | head -20 || true)"
    ( cd "$src" && { find . -type f -size +200M > "$tmp/skip.txt" 2>/dev/null || true; }
      COPYFILE_DISABLE=1 tar -czf "$tmp/brain.tgz" "${secrets[@]}" "${junk[@]}" -X "$tmp/skip.txt" . )
    parts=()
    for item in CLAUDE.md skills agents rules; do if [ -e "$HOME/.claude/$item" ]; then parts+=("$item"); fi; done
    if [ ${#parts[@]} -gt 0 ]; then ( cd "$HOME/.claude" && COPYFILE_DISABLE=1 tar -czf "$tmp/claude.tgz" "${secrets[@]}" "${junk[@]}" "${parts[@]}" ); fi
    echo "Отправляю второй мозг: $(du -h "$tmp/brain.tgz" | cut -f1)…"
    as_ai 'mkdir -p ~/Мозг && tar -xzf - -C ~/Мозг' < "$tmp/brain.tgz"
    if [ -s "$tmp/claude.tgz" ]; then as_ai 'mkdir -p ~/.claude && tar -xzf - -C ~/.claude' < "$tmp/claude.tgz"; fi
    add_rules
    as_ai 'echo "На сервере: $(find ~/Мозг -type f | wc -l) файлов в ~/Мозг, скиллов: $(ls ~/.claude/skills 2>/dev/null | wc -l)"'
    if [ -s "$tmp/skip.txt" ]; then echo "Не перенесены большие файлы (>200 МБ): $(wc -l < "$tmp/skip.txt") шт."; fi
    if [ -n "$found" ]; then echo "Не перенесены файлы с ключами (.env и подобные), их ИИ на сервере не увидит:"; echo "$found"; fi ;;
  login-start)
    as_ai 'bash -s' < "$HERE/login-start.sh" ;;
  login-code)
    code="$(read_secret)"
    [[ "$code" =~ ^[A-Za-z0-9_#-]{10,300}$ ]] || die "код выглядит неправильно — скопируй его целиком со страницы Claude"
    printf '%s\n' "$code" | as_ai 'IFS= read -r code
tmux send-keys -t login -l -- "$code"; sleep 1; tmux send-keys -t login Enter; sleep 10
tmux send-keys -t login Enter 2>/dev/null; sleep 2; tmux kill-session -t login 2>/dev/null || true
export PATH="$HOME/.local/bin:$PATH"
if timeout 90 claude -p "ответь одним словом: ок" 2>/dev/null | grep -qiwE "ок|ok"; then echo "ВХОД ОК: Claude на сервере работает от подписки"; else echo "ВХОД НЕ ПРОШЁЛ: запусти login-start заново и возьми новую ссылку"; fi' ;;
  tg-token)
    token="$(read_secret)"
    [[ "$token" =~ ^[0-9]{6,12}:[A-Za-z0-9_-]{30,}$ ]] || die "это не похоже на токен BotFather (цифры:буквы)"
    printf 'TELEGRAM_BOT_TOKEN=%s\n' "$token" | as_ai 'install -d -m 700 ~/.claude/channels/telegram && cat > ~/.claude/channels/telegram/.env && chmod 600 ~/.claude/channels/telegram/.env && echo "Токен бота сохранён на сервере"' ;;
  tg-start)
    as_ai 'bash -s' < "$HERE/bot-install.sh" ;;
  tg-pair)
    code="${2:?Нужен код из ответа бота}"
    [[ "$code" =~ ^[A-Za-z0-9]{4,8}$ ]] || die "код должен быть из букв и цифр, как прислал бот"
    as_ai "python3 - '$code'" < "$HERE/tg-pair.py" ;;
  rules)
    # «обнови правила бота»: свежие правила общения в CLAUDE.md сервера и чистый перезапуск бота, чтобы он их перечитал.
    add_rules
    as_ai '[ -f ~/assistant/start-bot.sh ] || { echo "Правила обновлены. Бот ещё не установлен: сначала tg-start"; exit 0; }
      tmux kill-session -t "=bot" 2>/dev/null || true; sleep 2
      bash ~/assistant/start-bot.sh && echo "Правила бота обновлены, бот перезапущен"' ;;
  status)
    as_ai 'export PATH="$HOME/.local/bin:$PATH"; echo "Сервер: $(hostname), $(uptime -p)"; free -h | sed -n 2p; df -h / | tail -1; tmux ls 2>/dev/null || echo "бот не запущен"; systemctl --user is-active assistant.timer 2>/dev/null || true' ;;
  ssh)
    shift; as_ai "$@" ;;
  root)
    shift; as_root "$@" ;;
  *)
    echo "Использование: srv.sh newpass | savepass < пароль | init <IP> | setup | push <папка> | login-start | login-code < код | tg-token < токен | tg-start | tg-pair <код> | rules | status | ssh '<команда>'"; exit 1 ;;
esac
