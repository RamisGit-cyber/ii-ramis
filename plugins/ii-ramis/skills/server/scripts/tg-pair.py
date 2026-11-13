"""Выполняется НА сервере под ai (srv.sh tg-pair <код>): подтверждает код, который бот прислал хозяину.
Повторяет команду /telegram:access pair: хозяин в allowFrom, принятый код удалён, «you're in» уходит через папку approved.
После этого чужим бот больше не отвечает (политика allowlist)."""
import json
import os
import sys
import time

code = sys.argv[1].strip()
state_dir = os.path.expanduser("~/.claude/channels/telegram")
path = os.path.join(state_dir, "access.json")
if not os.path.exists(path):
    sys.exit("Код ещё не появился: напиши боту «привет» и пришли код из его ответа")
with open(path, encoding="utf-8") as handle:
    access = json.load(handle)
pending = access.get("pending", {})
key = code if code in pending else next((k for k in pending if k.lower() == code.lower()), None)
if key is None:
    sys.exit("Такого кода нет. Напиши боту ещё раз «привет» и пришли новый код")
entry = pending[key]
if entry.get("expiresAt") and entry["expiresAt"] < time.time() * 1000:
    sys.exit("Код устарел. Напиши боту ещё раз «привет» и пришли новый код")
sender, chat = str(entry.get("senderId", "")), str(entry.get("chatId", entry.get("senderId", "")))
if not sender.isdigit() or not chat.lstrip("-").isdigit():
    sys.exit("Странная запись в коде — не подтверждаю. Напиши боту ещё раз «привет»")
allow = access.setdefault("allowFrom", [])
if sender not in allow:
    allow.append(sender)
del pending[key]
access["pending"] = pending
access["dmPolicy"] = "allowlist"
access.setdefault("groups", {})
tmp = path + ".tmp"
with open(tmp, "w", encoding="utf-8") as handle:
    json.dump(access, handle, ensure_ascii=False, indent=2)
os.chmod(tmp, 0o600)
os.replace(tmp, path)
os.makedirs(os.path.join(state_dir, "approved"), exist_ok=True)
with open(os.path.join(state_dir, "approved", sender), "w", encoding="utf-8") as handle:
    handle.write(chat)
print(f"ГОТОВО: бот теперь отвечает только хозяину (Telegram ID {sender}). Чужим он молчит.")
print("Проверь: это твой ID? Узнать свой ID можно у @userinfobot. Если не твой — напиши, я уберу его.")
