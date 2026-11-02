#!/usr/bin/env bash
# Установщик пакета «ИИ Рамис» для macOS (и Linux). Идемпотентный: повторный запуск безопасен.
# Запуск:  curl -fsSL https://raw.githubusercontent.com/RamisGit-cyber/ii-ramis/v1.0.5/plugins/ii-ramis/scripts/install.sh | bash
# Сам установщик качается с неизменяемого тега (v1.0.5): фраза ученика не меняется от каждого пуша.
# Плагин следит за веткой stable (туда владелец кладёт только проверенные релизы), автообновление этого маркетплейса включено.
# Повторный запуск переводит ученика со старой версии (маркетплейс на теге) на stable.
# Флаги:   --dry-run  показать, что будет сделано, ничего не меняя
#          --skip-third-party  поставить только плагин ИИ Рамис (для проверки)
# Режим Claude «без вопросов» (bypass) установщик не включает никогда.
# Согласие на пересказы занятий установщик не спрашивает: его один раз спрашивает ИИ Рамис в чате при первом знакомстве.
set -u

RELEASE_TAG="v1.0.5"
CHANNEL_REF="stable"
RAW_BASE="${IIRAMIS_RAW_BASE:-https://raw.githubusercontent.com/RamisGit-cyber/ii-ramis/$RELEASE_TAG/plugins/ii-ramis/scripts}"
MARKETPLACE_SOURCE="${IIRAMIS_MARKETPLACE_SOURCE:-RamisGit-cyber/ii-ramis#$CHANNEL_REF}"
DRY_RUN=0; SKIP_THIRD=0

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --share|--name) echo "Флаг $1 больше не нужен: согласие на пересказы теперь даётся в чате с ИИ Рамисом."; [ $# -ge 2 ] && shift ;;
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
      NODE_TMP="$(mktemp -d)"
      NODE_SUMS="$(curl --proto '=https' --tlsv1.2 -fsSL "$NODE_BASE/SHASUMS256.txt" 2>/dev/null)"
      NODE_FILE="$(printf '%s\n' "$NODE_SUMS" | grep -o "node-v[0-9.]*-$NODE_OS-$NODE_ARCH.tar.gz" | head -1)"
      NODE_WANT="$(printf '%s\n' "$NODE_SUMS" | grep " $NODE_FILE\$" | awk '{print $1}' | head -1)"
      # сначала скачиваем в файл и сверяем SHA256 из SHASUMS256.txt, и только потом распаковываем
      if [ -n "$NODE_FILE" ] && [ -n "$NODE_WANT" ] && curl --proto '=https' --tlsv1.2 -fsSL "$NODE_BASE/$NODE_FILE" -o "$NODE_TMP/$NODE_FILE"; then
        if have sha256sum; then NODE_GOT="$(sha256sum "$NODE_TMP/$NODE_FILE" | awk '{print $1}')"; else NODE_GOT="$(shasum -a 256 "$NODE_TMP/$NODE_FILE" | awk '{print $1}')"; fi
        if [ "$NODE_GOT" = "$NODE_WANT" ]; then
          mkdir -p "$HOME/.ii-ramis" "$HOME/.local/bin"
          rm -rf "$HOME/.ii-ramis/node"
          mkdir "$HOME/.ii-ramis/node"
          tar -xzf "$NODE_TMP/$NODE_FILE" -C "$HOME/.ii-ramis/node" --strip-components=1
          for tool in node npm npx; do ln -sf "$HOME/.ii-ramis/node/bin/$tool" "$HOME/.local/bin/$tool"; done
        else
          say "Контрольная сумма Node.js не совпала, не распаковываю."
        fi
      fi
      rm -rf "$NODE_TMP"
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

# gh без Homebrew и без пароля администратора: официальный архив с github.com/cli/cli. Версия закреплена, контрольные суммы SHA256
# вшиты сюда (взяты из gh_2.103.3_checksums.txt того релиза): подмена архива на стороне сервера не пройдёт проверку.
# Обновлять версию: взять новый gh_<версия>_checksums.txt и заменить GH_VERSION и таблицу ниже.
GH_VERSION="2.103.3"
gh_expected_sha256() {   # gh_expected_sha256 <имя файла>
  case "$1" in
    gh_2.103.3_macOS_arm64.zip)    echo d700207eae9ae98fe2b89535c2c087c07823d4628c56364695a5a07ef311c062 ;;
    gh_2.103.3_macOS_amd64.zip)    echo a2f86418f4350ae6e9ec60d5000bdf7665728436946a97fc27fe50e6ae752682 ;;
    gh_2.103.3_linux_amd64.tar.gz) echo 4c806978ffce1cec70853302a56d70ac6da4f19bae7adca4e1a8ab00633dd91d ;;
    gh_2.103.3_linux_arm64.tar.gz) echo ee32df2323c8847f5fac6cb6b4b69ca75828e9329a8f22f677021f7b3306ce63 ;;
    *) echo "" ;;
  esac
}
install_gh_binary() {
  local arch os_name ext file tmp expected actual
  case "$(uname -m)" in arm64|aarch64) arch=arm64 ;; x86_64|amd64) arch=amd64 ;; *) return 1 ;; esac
  if [ "$OS" = "Darwin" ]; then os_name=macOS; ext=zip; elif [ "$OS" = "Linux" ]; then os_name=linux; ext=tar.gz; else return 1; fi
  if [ "$DRY_RUN" = 1 ]; then say "  [проба] скачать gh $GH_VERSION с github.com/cli/cli/releases"; return 0; fi
  file="gh_${GH_VERSION}_${os_name}_${arch}.${ext}"
  expected="$(gh_expected_sha256 "$file")"
  [ -n "$expected" ] || return 1
  tmp="$(mktemp -d)" || return 1
  if ! curl --proto '=https' --tlsv1.2 -fsSL "https://github.com/cli/cli/releases/download/v${GH_VERSION}/$file" -o "$tmp/$file"; then rm -rf "$tmp"; return 1; fi
  if have sha256sum; then actual="$(sha256sum "$tmp/$file" | awk '{print $1}')"; else actual="$(shasum -a 256 "$tmp/$file" | awk '{print $1}')"; fi
  if [ "$expected" != "$actual" ]; then rm -rf "$tmp"; return 1; fi
  mkdir "$tmp/x"
  if [ "$ext" = zip ]; then unzip -q "$tmp/$file" -d "$tmp/x" || { rm -rf "$tmp"; return 1; }; else tar -xzf "$tmp/$file" -C "$tmp/x" || { rm -rf "$tmp"; return 1; }; fi
  mkdir -p "$HOME/.ii-ramis/gh" "$HOME/.local/bin"
  if ! cp "$tmp"/x/gh_*/bin/gh "$HOME/.ii-ramis/gh/gh"; then rm -rf "$tmp"; return 1; fi
  chmod +x "$HOME/.ii-ramis/gh/gh"; ln -sf "$HOME/.ii-ramis/gh/gh" "$HOME/.local/bin/gh"
  rm -rf "$tmp"
}

if have gh; then
  add_report ok "GitHub CLI (gh)" "$(gh --version | head -1)"
else
  have brew && run brew install gh >/dev/null 2>&1
  have gh || install_gh_binary >/dev/null 2>&1
  if have gh; then add_report done "GitHub CLI (gh)" "поставлен"
  elif [ "$DRY_RUN" = 1 ]; then add_report ok "GitHub CLI (gh)" "[проба] будет поставлен"
  else add_report need "GitHub CLI (gh)" "Не получилось поставить сам. Скажи ИИ Рамис «поставь gh» или поставь вручную: Mac с Homebrew: brew install gh; без Homebrew: скачай установщик на cli.github.com. Потом запусти установщик ещё раз."
  fi
fi
if have gh; then
  gh auth status >/dev/null 2>&1 && add_report ok "Вход в GitHub" "выполнен" || add_report need "Вход в GitHub" "Нужен один раз в браузере: ИИ Рамис проведёт, когда понадобится (команда gh auth login)."
fi

# ---------- 2. Скрипт настроек (рядом лежит или скачиваем) ----------
# при `curl | bash` BASH_SOURCE пуст: тогда локальные файлы НЕ берём (иначе подхватился бы setup-settings.mjs из текущей папки)
SCRIPT_DIR=""
[ -n "${BASH_SOURCE[0]:-}" ] && SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd || true)"
SETUP_JS=""
if [ -n "$SCRIPT_DIR" ] && [ -f "$SCRIPT_DIR/setup-settings.mjs" ]; then
  SETUP_JS="$SCRIPT_DIR/setup-settings.mjs"
  if [ "$DRY_RUN" = 0 ]; then   # копия в ~/.ii-ramis: по ней ученик сам включает режим «без вопросов» из терминала
    mkdir -p "$HOME/.ii-ramis" && cp -f "$SETUP_JS" "$HOME/.ii-ramis/" 2>/dev/null
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

# ---------- 3. Плагины и MCP ----------
CLAUDE_BIN=""
have claude && CLAUDE_BIN="$(command -v claude)"

refresh_own_marketplace() {
  # Источник в настройках уже переведён на stable (setup-settings.mjs), поэтому add принимает его и пере-клонирует.
  # remove не делаем: он удалил бы плагин ученика вместе с его данными.
  run "$CLAUDE_BIN" plugin marketplace add "$MARKETPLACE_SOURCE" >/dev/null 2>&1
  run "$CLAUDE_BIN" plugin marketplace update ii-ramis >/dev/null 2>&1
}

install_plugin() {   # install_plugin <маркетплейс-имя> <источник> <плагин>
  local mk_name="$1" mk_source="$2" plugin="$3" id="$3@$1"
  if [ -n "$CLAUDE_BIN" ]; then
    if "$CLAUDE_BIN" plugin list 2>/dev/null | grep -q "$id"; then
      # уже установлен: свой маркетплейс всё равно перепривязываем к stable и обновляем (ученик с v1.0.2)
      [ "$mk_name" = "ii-ramis" ] && refresh_own_marketplace
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
# Сначала настройки (источник stable + автообновление), потом команды claude: иначе `marketplace add` с новым ref
# отказывает, потому что не совпадает с записью в настройках (проверено на Claude Code 2.1.316).
setup --marketplace ii-ramis --auto-update ii-ramis >/dev/null 2>&1
install_plugin ii-ramis "$MARKETPLACE_SOURCE" ii-ramis

# ---------- 4. Настройки: маркетплейс на stable с автообновлением, согласие ----------
# Автообновление включено только для маркетплейса ii-ramis. Если ученик сам выключил его (autoUpdate: false), не трогаем.
SETUP_ARGS=(--marketplace ii-ramis --auto-update ii-ramis)
if OUT="$(setup "${SETUP_ARGS[@]}" 2>&1)"; then
  add_report done "Настройки Claude" "$(printf '%s' "$OUT" | tr '\n' ';' | cut -c1-160)"
else
  add_report fail "Настройки Claude" "$OUT"
fi

add_report skip "Пересказы занятий Рамису" "по умолчанию выключены. ИИ Рамис один раз спросит согласие в чате при первом «привет»; ответ «нет» ничего не отправляет."

# Режим «без вопросов» (bypass) установщик НЕ включает вообще: только ты сам.
add_report need "Режим «без вопросов»" "не включён и никакой скрипт его не включает. Хочешь сам: Claude Desktop -> Settings -> Code -> «Allow bypass permissions mode» (или правка settings.json, см. README)"

# ---------- 5. Итог ----------
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
say "Режим «без вопросов» установщик не включает: это только твой тумблер в Claude Desktop (Settings -> Code). Плагин обновляется сам (автообновление включено); как это отключить, написано в README."
[ "$FAIL" = 1 ] && exit 1
exit 0
