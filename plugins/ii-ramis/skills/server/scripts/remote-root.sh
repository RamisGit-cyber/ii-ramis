#!/usr/bin/env bash
# Выполняется НА сервере под root (srv.sh setup). Можно запускать повторно.
# Делает: обновления, swap, защита (ufw, fail2ban, вход только по ключу, пароль root заблокирован), пользователь ai, Node.js.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
echo "==> Обновляю систему и ставлю пакеты (3–5 минут)…"
apt-get update -qq </dev/null
apt-get install -y -qq tmux git curl wget unzip jq python3 ufw fail2ban unattended-upgrades ca-certificates ffmpeg </dev/null >/dev/null

echo "==> Память: файл подкачки"
if ! swapon --show | grep -q '/swapfile'; then
  fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

echo "==> Пользователь ai (от него работает Claude), с правами администратора"
if ! id ai >/dev/null 2>&1; then useradd -m -s /bin/bash ai; fi
echo 'ai ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/90-ai && chmod 440 /etc/sudoers.d/90-ai
visudo -cf /etc/sudoers.d/90-ai >/dev/null
install -d -m 700 -o ai -g ai /home/ai/.ssh
cat /root/.ssh/authorized_keys > /home/ai/.ssh/authorized_keys
chown ai:ai /home/ai/.ssh/authorized_keys && chmod 600 /home/ai/.ssh/authorized_keys
loginctl enable-linger ai   # службы ai работают без входа в систему и после перезагрузки

echo "==> Защита: вход только по ключу, фаервол, бан за подбор пароля"
mkdir -p /etc/ssh/sshd_config.d
printf 'PasswordAuthentication no\nKbdInteractiveAuthentication no\nPermitRootLogin prohibit-password\n' > /etc/ssh/sshd_config.d/00-ii-ramis.conf
systemctl reload ssh 2>/dev/null || systemctl reload sshd 2>/dev/null || true
ufw --force default deny incoming >/dev/null
ufw --force default allow outgoing >/dev/null
ufw allow 22/tcp >/dev/null
ufw --force enable >/dev/null
systemctl enable --now fail2ban >/dev/null 2>&1 || true
dpkg-reconfigure -f noninteractive unattended-upgrades </dev/null >/dev/null 2>&1 || true
passwd -l root >/dev/null   # пароль root больше не работает: вход только по ключу
timedatectl set-timezone "${II_TZ:-Asia/Bishkek}" 2>/dev/null || true   # курс в Бишкеке; другой город — передай II_TZ

echo "==> Node.js 22"
if ! command -v node >/dev/null || [ "$(node -v | cut -d. -f1 | tr -d v)" -lt 20 ]; then
  setup_file="$(mktemp)"
  curl -fsSL -o "$setup_file" https://deb.nodesource.com/setup_22.x
  bash "$setup_file" </dev/null >/dev/null 2>&1
  rm -f "$setup_file"
  apt-get install -y -qq nodejs </dev/null >/dev/null
fi
echo "ГОТОВО (root): $(node -v), ufw $(ufw status | head -1 | cut -d: -f2), swap $(free -h | awk '/Swap/{print $2}')"
