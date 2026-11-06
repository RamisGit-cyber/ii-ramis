# Инструменты для монтажа: проверка и установка

Что нужно и зачем:

| Что | Зачем | Mac | Windows |
|---|---|---|---|
| ffmpeg (с субтитрами, фильтр `ass`) | режет, склеивает, рисует субтитры, считает громкость | `brew install ffmpeg-full`, затем `brew unlink ffmpeg` и `brew link --force ffmpeg-full` (обычная формула `ffmpeg` бывает без libass) | `winget install --id Gyan.FFmpeg -e` (полная сборка с субтитрами) |
| Node 22.20+ | ставит навыки (HyperFrames, Remotion, GSAP) | `brew install node` | `winget install --id OpenJS.NodeJS.LTS -e` |
| uv | запускает скрипты плагина и расшифровку (сам скачивает Python) | `brew install uv` | `winget install --id astral-sh.uv -e` |
| Навыки HyperFrames, Remotion, GSAP | домашка урока 5 | ставит плагин (хук при старте или блок `install-*` из навыка `nabor`) | то же |

## Проверка (только читает)

Mac:

```bash
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
has_skill() { for d in "$HOME/.claude/skills/$1" "$HOME/.claude/skills/synced"/*/"$1"; do [ -f "$d/SKILL.md" ] && return 0; done; return 1; }
show() { name="$1"; shift; if "$@" >/dev/null 2>&1; then echo "$name: стоит"; else echo "$name: НЕ СТОИТ"; fi; }
show ffmpeg command -v ffmpeg
if command -v ffmpeg >/dev/null; then ffmpeg -hide_banner -filters 2>/dev/null | grep -qE ' (ass|subtitles) ' && echo "ffmpeg, субтитры: стоит" || echo "ffmpeg, субтитры: НЕТ (нужна сборка с libass: ffmpeg-full)"; fi
show ffmpeg-skill has_skill ffmpeg-skill
if command -v node >/dev/null && node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=20)?0:1)'; then echo "node: стоит ($(node -v))"; else echo "node: НЕ СТОИТ или старше 22.20"; fi
show uv command -v uv
show hyperframes has_skill hyperframes
show remotion has_skill remotion-best-practices
show gsap has_skill gsap-core
```

Windows (PowerShell):

```powershell
function Show($n, $ok) { if ($ok) { "${n}: стоит" } else { "${n}: НЕ СТОИТ" } }
function Has-Skill($n) { (Test-Path -LiteralPath "$HOME\.claude\skills\$n\SKILL.md") -or (@(Get-ChildItem -Path "$HOME\.claude\skills\synced\*\$n\SKILL.md" -ErrorAction SilentlyContinue).Count -gt 0) }
Show 'ffmpeg' [bool](Get-Command ffmpeg -ErrorAction SilentlyContinue)
Show 'node' [bool](Get-Command node -ErrorAction SilentlyContinue)
Show 'uv' [bool](Get-Command uv -ErrorAction SilentlyContinue)
Show 'hyperframes' (Has-Skill 'hyperframes')
Show 'remotion' (Has-Skill 'remotion-best-practices')
Show 'gsap' (Has-Skill 'gsap-core')
```

Проверка «есть ли у ffmpeg субтитры» на Windows: `ffmpeg -hide_banner -filters | Select-String ' (ass|subtitles) '` (сборка Gyan.FFmpeg полная, libass в ней есть; если строки нет, значит в PATH стоит другой ffmpeg: `where.exe ffmpeg`).

## Что делать, если чего-то нет

Правило: Рамис разрешил ставить это без вопросов (домашка урока 5), поэтому ставишь сам, потом проверяешь `--version` и отчитываешься одной строкой каждому пункту.

- **ffmpeg, Node, uv.** Командами из таблицы. Mac без Homebrew: не запускай скрипты установки из интернета, скажи ученику: «Homebrew у тебя нет, поставь его с brew.sh одной командой с сайта (там есть кнопка «копировать»), потом я допоставлю остальное», или предложи показать Рамису на уроке. Windows: после `winget` закрыть и открыть приложение, чтобы подхватился PATH. Если `ffmpeg` стоит, но без фильтров `ass`/`subtitles` (бывает у обычной формулы Homebrew: `brew reinstall ffmpeg` не помогает): на Mac `brew install ffmpeg-full`, затем `brew unlink ffmpeg` и `brew link --force ffmpeg-full` (старая формула не удаляется, только отлинковывается; если что-то из-за этого сломалось, вернуть: `brew unlink ffmpeg-full && brew link ffmpeg`, а после обновления зависимостей brew может понадобиться `brew upgrade ffmpeg`). Скрипты монтажа и сами находят полную сборку в `/opt/homebrew/opt/ffmpeg-full/bin`, даже если ссылка не сделана. На Windows `winget install --id Gyan.FFmpeg -e` и перезапуск приложения. Это занимает несколько минут: предупреди ученика.
- **Навыки HyperFrames, Remotion, GSAP.** Их ставит плагин: хук при старте сессии (Mac) или блок `install-win` из `nabor/references/ustanovka.md` (Windows, ты запускаешь сам). Это закреплённые версии, не `latest`. Скажи ученику: «Закрой приложение и открой заново, набор доставится сам», а на Windows запусти блок. Не заменяй на `npx hyperframes skills update` или `npx skills add ...@latest`: незакреплённые источники плагин не ставит.
- Всё остальное вне этого списка ставится только после «да» ученика.

Для самого монтажа HyperFrames, Remotion и GSAP не нужны (его делают ffmpeg и скрипты плагина); навыки проверяются потому, что это домашка урока 5.
