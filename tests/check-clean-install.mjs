// Чистая установка набора урока 5: берёт блоки install-mac / check-mac / klyuch-21st-mac из ustanovka.md и klyuch-21st.md,
// запускает их в пустом HOME ДВАЖДЫ (идемпотентность) и проверяет по диску, что навыки появились.
// Нужны сеть, git, node 22.20+, uv и claude. Запуск: node tests/check-clean-install.mjs (около 1-3 минут).
// На Linux/Mac. Блоки Windows (PowerShell) здесь не запускаются.
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, chmodSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const nabor = join(root, 'plugins', 'ii-ramis', 'skills', 'nabor', 'references');
const failures = [];
const check = (ok, message) => { if (!ok) failures.push(message); };

function block(file, name) {
  const text = readFileSync(join(nabor, file), 'utf8');
  const match = text.match(new RegExp('```(?:bash|powershell) ' + name + '\\n([\\s\\S]*?)```'));
  if (!match) throw new Error(`нет блока ${name} в ${file}`);
  return match[1];
}

const home = mkdtempSync(join(tmpdir(), 'ii-ramis-clean-'));
const shims = join(home, '_shims');
mkdirSync(shims);
const env = { ...process.env, HOME: home, USERPROFILE: home };
delete env.CLAUDE_CONFIG_DIR;
const run = (script, extraEnv = {}) => spawnSync('bash', ['-c', script], { env: { ...env, ...extraEnv }, encoding: 'utf8', timeout: 600000 });

try {
  const install = block('ustanovka.md', 'install-mac');
  const first = run(install);
  console.log('--- первый запуск ---\n' + first.stdout);
  const second = run(install);
  console.log('--- второй запуск ---\n' + second.stdout);

  check(/ошибок: 0/.test(first.stdout), 'первый запуск: были ошибки установки');
  check(/ошибок: 0/.test(second.stdout), 'второй запуск: были ошибки');
  check(!/поставил:/.test(second.stdout), 'второй запуск ничего не должен ставить заново (идемпотентность)');
  check((second.stdout.match(/уже стоит:/g) ?? []).length >= 7, 'второй запуск: все 7 пунктов должны быть «уже стоит»');
  check(/ждёт ключ: 21st/.test(first.stdout), 'без ключа 21st должен ждать ключ, а не ставиться молча');

  for (const skill of ['find-skills', 'emil-design-eng', 'impeccable', 'agent-reach']) {
    check(existsSync(join(home, '.claude', 'skills', skill, 'SKILL.md')), `на диске нет навыка ${skill}`);
  }
  const plugins = spawnSync('claude', ['plugin', 'list', '--json'], { env, encoding: 'utf8' }).stdout;
  check(plugins.includes('"id": "superpowers@claude-plugins-official"'), 'плагин superpowers не установлен');
  check(existsSync(join(home, '.claude', 'skills', 'humanizer', 'SKILL.md')), 'навык humanizer не установлен');
  check(!plugins.includes('"id": "humanizer@humanizer"'), 'humanizer не должен ставиться плагином из чужого маркетплейса');
  check(!plugins.includes('"id": "impeccable@'), 'плагин impeccable (с хуками) ставиться не должен');
  const config = JSON.parse(readFileSync(join(home, '.claude.json'), 'utf8'));
  check(Boolean(config.mcpServers?.playwright), 'MCP playwright не подключён');
  check(JSON.stringify(config.mcpServers?.playwright ?? {}).includes('@playwright/mcp@0.0.84'), 'playwright должен быть закреплён на 0.0.84');
  const marker = JSON.parse(readFileSync(join(home, '.ii-ramis', 'nabor.json'), 'utf8'));
  check(marker.status === 'ok' && marker.tries === 2 && marker.kit === '2.4.0', `nabor.json: ожидали status ok и tries 2 после двух запусков, получили ${JSON.stringify(marker)}`);
  check(!existsSync(join(home, '.claude', 'settings.json')) || !/bypassPermissions|skipDangerousModePermissionPrompt/.test(readFileSync(join(home, '.claude', 'settings.json'), 'utf8')), 'в settings.json появился обход разрешений');

  const verdict = run(block('ustanovka.md', 'check-mac'));
  console.log('--- проверка ---\n' + verdict.stdout);
  for (const name of ['find-skills', 'emil-design-eng', 'impeccable', 'agent-reach', 'superpowers']) {
    check(new RegExp(`^${name}: есть$`, 'm').test(verdict.stdout), `проверка: ${name} должен быть «есть»`);
  }
  check(/^humanizer: есть$/m.test(verdict.stdout) && /^playwright: есть$/m.test(verdict.stdout), 'проверка: humanizer и playwright должны быть «есть»');
  check(/21st: НЕТ/.test(verdict.stdout), 'проверка: без ключа 21st = НЕТ');
  check(/agent-reach работает: .*"ok": true/.test(verdict.stdout), 'agent-reach version должен отвечать ok');

  // Ключ 21st: подставной pbpaste, настоящего ключа нет. Проверяем, что ключ не попадает в вывод и подключение появляется.
  const fakeKey = 'fake-test-key-0123456789abcdef';
  writeFileSync(join(shims, 'pbpaste'), `#!/bin/sh\nprintf '%s' '${fakeKey}'\n`);
  writeFileSync(join(shims, 'pbcopy'), '#!/bin/sh\ncat >/dev/null\n');
  chmodSync(join(shims, 'pbpaste'), 0o755);
  chmodSync(join(shims, 'pbcopy'), 0o755);
  const keyRun = run(block('klyuch-21st.md', 'klyuch-21st-mac'), { PATH: `${shims}:${env.PATH}` });
  console.log('--- 21st ---\n' + keyRun.stdout);
  check(/21st подключён/.test(keyRun.stdout), '21st не подключился из буфера');
  check(!(keyRun.stdout + keyRun.stderr).includes(fakeKey), 'КЛЮЧ ПОПАЛ В ВЫВОД команды');
  const afterKey = run(block('ustanovka.md', 'check-mac')).stdout;
  check(/21st: подключён \(ключ не показываю\)/.test(afterKey), 'после подключения проверка должна видеть 21st');
  check(!afterKey.includes(fakeKey), 'КЛЮЧ ПОПАЛ В ВЫВОД проверки');
  const again = run(install).stdout;
  check(!/ждёт ключ: 21st/.test(again), 'после подключения 21st установка не должна ждать ключ');

  // Agent Reach должен быть поставлен из zip релиза автора (квитанция uv хранит источник), а не из PyPI
  const receipt = join(home, '.local', 'share', 'uv', 'tools', 'agent-reach', 'uv-receipt.toml');
  check(existsSync(receipt) && !/registry|pypi/i.test(readFileSync(receipt, 'utf8').split('[tool.options]')[0].replace(/(yt-dlp|requests|loguru|pyyaml|websockets)[^\n]*/gi, '')), 'agent-reach поставлен не из релиза автора');

  // Многострочный буфер (ключ плюс чужая строка) должен быть отвергнут и никуда не уйти
  const multi = `${fakeKey}\nsecret-password-line`;
  writeFileSync(join(shims, 'pbpaste'), `#!/bin/sh\nprintf '%s' '${multi}'\n`);
  const keyBad = run(block('klyuch-21st.md', 'klyuch-21st-mac').replace('claude mcp list 2>/dev/null | grep -q \'^21st:\'', 'false'), { PATH: `${shims}:${env.PATH}` });
  check(/не похоже на ключ/.test(keyBad.stdout), 'многострочный буфер должен отвергаться');

  // Без uv блок не ставит ничего системного, ждёт и честно ставит status partial
  const noUvHome = mkdtempSync(join(tmpdir(), 'ii-ramis-nouv-'));
  const noUvShims = join(noUvHome, '_bin');
  mkdirSync(noUvShims);
  const claudeBin = spawnSync('bash', ['-c', 'command -v claude'], { env, encoding: 'utf8' }).stdout.trim();
  symlinkSync(claudeBin, join(noUvShims, 'claude'));
  const noUvPath = [noUvShims, ...env.PATH.split(':').filter((dir) => !existsSync(join(dir, 'uv')) && !existsSync(join(dir, 'brew')))].join(':');
  const noUv = spawnSync('bash', ['-c', install], { env: { ...env, HOME: noUvHome, PATH: noUvPath }, encoding: 'utf8', timeout: 600000 });
  console.log('--- без uv ---\n' + noUv.stdout);
  check(/ЖДЁТ uv: agent-reach/.test(noUv.stdout), 'без uv блок должен сказать «ЖДЁТ uv», а не ставить uv сам');
  const partial = JSON.parse(readFileSync(join(noUvHome, '.ii-ramis', 'nabor.json'), 'utf8'));
  check(partial.status === 'partial' && partial.tries === 1, `без uv nabor.json должен быть partial/1, получили ${JSON.stringify(partial)}`);
  rmSync(noUvHome, { recursive: true, force: true });
} finally {
  rmSync(home, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error(failures.map((line) => `FAIL: ${line}`).join('\n'));
  process.exit(1);
}
console.log('OK: чистая установка набора урока 5 прошла, повторный запуск ничего не дублирует');
