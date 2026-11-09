# Харнесы урока 7: источники, команды, Windows

Проверено 09.11.2026 по README проектов и по сухому запуску установщика (`--dry-run`).

## Источники

| Что | Источник | Лицензия | Как ставится |
|---|---|---|---|
| ECC (`ecc@ecc`) | github.com/affaan-m/ECC, npm `ecc-universal@2.2.3` | MIT | официальный установщик из README («Install ECC»): `npx ecc-universal@2.2.3 install --guided --harness claude --claude-scope user --claude-hooks standard --yes` (все выборы заданы явно, без вопросов). Запасной путь из того же README: `claude plugin marketplace add https://github.com/affaan-m/ECC` и `claude plugin install ecc@ecc --scope user` |
| Superpowers | github.com/obra/superpowers, маркетплейс `claude-plugins-official` | MIT | `claude plugin marketplace add anthropics/claude-plugins-official` и `claude plugin install superpowers@claude-plugins-official` |
| security-audit | github.com/cloudflare/security-audit-skill, коммит c1c8a8c1 | MIT | клон на коммите + `npx skills@1.7.6 add <папка> --skill security-audit -g -a claude-code -y --copy` |

Требования ECC (README): Node.js 18+, Git, Claude Code 2.1+. Режимы хуков ECC: `off`, `minimal`, `standard`, `strict`; по решению Рамиса — `standard`. Установщик ECC перед записью показывает, что делает Standard: может менять файлы проекта, переписывать команды и запускать/останавливать процессы, **отправлять текст из разговора во внешнюю модель**, проверять MCP, блокировать или менять правки и команды, вести записи о сессии. Версия закреплена, но README ECC честно пишет: закрепление версии не проверка целостности. Обновлять версию только после просмотра изменений.

Ключи и аккаунты для ECC, Superpowers и security-audit не нужны.

## Windows (PowerShell, у команд Claude там нет песочницы)

Не проверено на реальной Windows. Блок ставит только то, что попросил ученик: убери из него лишнее (`ecc`, `superpowers`, `audit`). Ничего не ломает при повторном запуске.

```powershell harnes-win
$env:DISABLE_TELEMETRY = '1'; $env:DO_NOT_TRACK = '1'
$env:NPM_CONFIG_REGISTRY = 'https://registry.npmjs.org/'
$env:Path = [Environment]::GetEnvironmentVariable('Path','User') + ';' + [Environment]::GetEnvironmentVariable('Path','Machine') + ";$HOME\.local\bin"
$want = @('superpowers', 'ecc', 'audit')   # оставь только нужное
function Plugin-State($id) {
  try { $p = ((claude plugin list --json 2>$null) -join "`n" | ConvertFrom-Json | Where-Object { $_.id -like "$id@*" } | Select-Object -First 1)
        if (-not $p) { 'absent' } elseif ($p.enabled -eq $false) { 'disabled' } else { 'enabled' } } catch { 'unknown' }
}
function Ensure-Enabled($id, $mkt) { if ((Plugin-State $id) -eq 'disabled') { claude plugin enable "$id@$mkt" *> $null }; (Plugin-State $id) -eq 'enabled' }
if (-not (Get-Command claude -ErrorAction SilentlyContinue)) { 'claude не найден в PATH: поставь через меню плагинов приложения (Manage plugins)'; return }
if ($want -contains 'superpowers') {
  if ((Plugin-State 'superpowers') -ne 'enabled' -and (Plugin-State 'superpowers') -ne 'disabled') {
    claude plugin marketplace add anthropics/claude-plugins-official *> $null
    claude plugin install superpowers@claude-plugins-official *> $null
  }
  if (Ensure-Enabled 'superpowers' 'claude-plugins-official') { 'superpowers: поставлен и включён' } else { 'superpowers: НЕ ПОСТАВИЛСЯ' }
}
if ($want -contains 'ecc') {
  if (-not ((Get-Command node -ErrorAction SilentlyContinue) -and (Get-Command git -ErrorAction SilentlyContinue))) { 'ecc: нужны Node.js 18+ и git (скажи ученику поставить их с nodejs.org и git-scm.com)' }
  else {
    if ((Plugin-State 'ecc') -eq 'absent' -or (Plugin-State 'ecc') -eq 'unknown') {
      $tmp = Join-Path ([IO.Path]::GetTempPath()) ([IO.Path]::GetRandomFileName()); New-Item -ItemType Directory $tmp | Out-Null
      Push-Location $tmp
      npx.cmd --yes ecc-universal@2.2.3 install --guided --harness claude --claude-scope user --claude-hooks standard --yes *> $null
      Pop-Location; Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
      if ((Plugin-State 'ecc') -eq 'absent') {
        claude plugin marketplace add https://github.com/affaan-m/ECC *> $null
        claude plugin install ecc@ecc --scope user *> $null
      }
    }
    if (Ensure-Enabled 'ecc' 'ecc') { 'ecc: поставлен и включён, режим хуков Standard' } else { 'ecc: НЕ ПОСТАВИЛСЯ' }
  }
}
if ($want -contains 'audit') {
  if (Test-Path "$HOME\.claude\skills\security-audit\SKILL.md") { 'security-audit: уже стоит' }
  elseif (-not ((Get-Command node -ErrorAction SilentlyContinue) -and (Get-Command git -ErrorAction SilentlyContinue))) { 'security-audit: нужны Node.js 22.20+ и git' }
  else {
    $tmp = Join-Path ([IO.Path]::GetTempPath()) ([IO.Path]::GetRandomFileName()); New-Item -ItemType Directory $tmp | Out-Null
    $dir = Join-Path $tmp 'security-audit-skill'
    git -c protocol.file.allow=never clone -q --no-recurse-submodules https://github.com/cloudflare/security-audit-skill.git $dir *> $null
    git -C $dir checkout -q c1c8a8c1471069fb0e188eeaff69b8e8db6564a8 *> $null
    if ((Get-ChildItem -LiteralPath $dir -Recurse -Force -Attributes ReparsePoint -ErrorAction SilentlyContinue | Where-Object { $_.FullName -notlike '*\.git\*' }).Count -gt 0) { 'security-audit: в репозитории ссылки, не ставлю' }
    else { Push-Location $tmp; npx.cmd --yes skills@1.7.6 add $dir --skill security-audit -g -a claude-code -y --copy *> $null; Pop-Location }
    Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
    if (Test-Path "$HOME\.claude\skills\security-audit\SKILL.md") { 'security-audit: поставлен' } else { 'security-audit: НЕ ПОСТАВИЛСЯ' }
  }
}
```

После блока: «Закрой приложение полностью (значок в трее → выйти) и открой заново».

## Выключить и включить

- Выключить ECC: `claude plugin disable ecc@ecc`, включить: `claude plugin enable ecc@ecc`. Так же для `superpowers@claude-plugins-official`. Это пишет в `~/.claude`, поэтому на Mac Bash в песочнице не справится: либо ученик жмёт «+ рядом с полем ввода → Manage plugins → ecc → Disable», либо по просьбе «сделай сам» ты повторяешь команду в окне «Bash command (unsandboxed)» и ученик нажимает «разрешить» (только на эту команду). После этого — полный перезапуск приложения.
- Полное удаление ECC (если что-то задвоилось): раздел «Reset / Uninstall ECC» в README ECC; делать только после «да» ученика.
