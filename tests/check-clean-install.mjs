// Поведение установки набора (2.6): скрипт хука hooks/kit-install.sh в пустом HOME.
// Проверяет: чистую установку и повтор (ничего не дублируется), флаг «уже поставлено», отказ «не ставь набор»,
// 21st без ключа не ставится, переход с 2.4.0, лимит попыток, эмуляцию запрета записи в ~/.claude
// (так песочница Claude Desktop ведёт себя для команд Bash) и что путь через хук отрабатывает.
// Нужны сеть, git, node 22.20+, uv и claude. Запуск: node tests/check-clean-install.mjs (около 8-12 минут).
// Блоки Windows (PowerShell) здесь не запускаются.
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, chmodSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const plugin = join(root, 'plugins', 'ii-ramis');
const script = join(plugin, 'hooks', 'kit-install.sh');
const klyuch = join(plugin, 'skills', 'nabor', 'references', 'klyuch-21st.md');
const failures = [];
const check = (ok, message) => { if (!ok) failures.push(message); };

const homes = [];
const newHome = (label) => {
  const dir = mkdtempSync(join(tmpdir(), `ii-ramis-${label}-`));
  homes.push(dir);
  return dir;
};
const envFor = (home, extra = {}) => {
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  delete env.CLAUDE_CONFIG_DIR;
  delete env.II_RAMIS_NO_KIT;
  return { ...env, ...extra };
};
const kit = (home, mode, extra = {}) => spawnSync('bash', [script, mode], { env: envFor(home, extra), encoding: 'utf8', timeout: 900000 });
const state = (home) => JSON.parse(readFileSync(join(home, '.ii-ramis', 'nabor.json'), 'utf8'));
const hasSkill = (home, name) => existsSync(join(home, '.claude', 'skills', name, 'SKILL.md'));
const lastJson = (text) => JSON.parse(text.trim().split('\n').filter(Boolean).at(-1));

try {
  // ---------- 1. Чистая установка через хук (--notice + --auto) ----------
  const home = newHome('clean');
  const notice = kit(home, '--notice');
  const noticeJson = lastJson(notice.stdout);
  check(/ставит инструменты урока 5/.test(noticeJson.systemMessage) && /не ставь набор/.test(noticeJson.systemMessage), '--notice: нет понятного сообщения и способа отказаться');
  check(noticeJson.hookSpecificOutput?.hookEventName === 'SessionStart' && /песочниц/.test(noticeJson.hookSpecificOutput?.additionalContext ?? ''), '--notice: нет подсказки Claude про песочницу');
  check(!existsSync(join(home, '.claude')), '--notice ничего ставить не должен');

  const first = kit(home, '--auto');
  console.log('--- журнал первой установки ---\n' + readFileSync(join(home, '.ii-ramis', 'nabor.log'), 'utf8'));
  const firstJson = lastJson(first.stdout);
  check(/Набор урока 5 поставлен/.test(firstJson.systemMessage ?? ''), `--auto: после установки нет сообщения «поставлен»: ${first.stdout}`);
  const marker = state(home);
  check(marker.status === 'ok' && marker.kit === '2.6.0' && marker.tries === 1, `nabor.json после первой установки: ${JSON.stringify(marker)}`);
  check(/21st/.test(marker.notes), 'notes должны сказать, что 21st ждёт ключ');
  check(!existsSync(join(home, '.ii-ramis', 'nabor.lock')), 'замок установки не снят');

  for (const skill of ['find-skills', 'emil-design-eng', 'impeccable', 'humanizer', 'agent-reach', 'hyperframes', 'hyperframes-cli', 'hyperframes-registry', 'media-use', 'remotion-best-practices', 'remotion-markup']) {
    check(hasSkill(home, skill), `на диске нет навыка ${skill}`);
  }
  const plugins = spawnSync('claude', ['plugin', 'list', '--json'], { env: envFor(home), encoding: 'utf8' }).stdout;
  check(plugins.includes('"id": "superpowers@claude-plugins-official"'), 'плагин superpowers не установлен');
  check(!plugins.includes('"id": "humanizer@humanizer"') && !plugins.includes('"id": "impeccable@'), 'нельзя ставить плагины humanizer@humanizer и impeccable@ (чужие хуки)');
  const config = JSON.parse(readFileSync(join(home, '.claude.json'), 'utf8'));
  const pw = config.mcpServers?.playwright ?? {};
  check(pw.command === join(home, '.ii-ramis', 'mcp', 'node_modules', '.bin', 'playwright-mcp') && existsSync(pw.command), `playwright должен запускаться по абсолютному пути из ~/.ii-ramis/mcp, а не через npx: ${JSON.stringify(pw)}`);
  check(!JSON.stringify(pw).includes('npx'), 'playwright не должен запускаться через npx');
  check(JSON.parse(readFileSync(join(home, '.ii-ramis', 'mcp', 'node_modules', '@playwright', 'mcp', 'package.json'), 'utf8')).version === '0.0.84', 'playwright должен быть закреплён на 0.0.84');
  check(!config.mcpServers?.['21st'] && !config.mcpServers?.magic, '21st без согласия и ключа ставиться не должен');
  check(!existsSync(join(home, '.claude', 'settings.json')) || !/bypassPermissions|skipDangerousModePermissionPrompt/.test(readFileSync(join(home, '.claude', 'settings.json'), 'utf8')), 'в settings.json появился обход разрешений');

  // ---------- 2. Флаг «уже поставлено» и идемпотентность ----------
  const before = readFileSync(join(home, '.ii-ramis', 'nabor.json'), 'utf8');
  const second = kit(home, '--auto');
  check(second.stdout.trim() === '', '--auto при status ok должен молчать и ничего не делать');
  check(kit(home, '--notice').stdout.trim() === '', '--notice при status ok должен молчать');
  check(readFileSync(join(home, '.ii-ramis', 'nabor.json'), 'utf8') === before, 'при status ok файл состояния менять нельзя');
  const rerun = kit(home, '--run');
  console.log('--- повторный --run ---\n' + rerun.stdout);
  check(!/поставил:/.test(rerun.stdout), 'повторная установка ничего не должна ставить заново');
  check((rerun.stdout.match(/уже стоит:/g) ?? []).length >= 9, 'повторная установка: все 9 пунктов должны быть «уже стоит»');
  check(/ошибок: 0/.test(rerun.stdout), 'повторная установка: были ошибки');

  // ---------- 3. 21st: ключ из буфера, в вывод не попадает; без согласия (до этого шага) не ставился ----------
  const shims = join(home, '_shims');
  mkdirSync(shims);
  const fakeKey = 'fake-test-key-0123456789abcdef';
  writeFileSync(join(shims, 'pbpaste'), `#!/bin/sh\nprintf '%s' '${fakeKey}'\n`);
  writeFileSync(join(shims, 'pbcopy'), '#!/bin/sh\ncat >/dev/null\n');
  chmodSync(join(shims, 'pbpaste'), 0o755);
  chmodSync(join(shims, 'pbcopy'), 0o755);
  const keyBlock = readFileSync(klyuch, 'utf8').match(/```bash klyuch-21st-mac\n([\s\S]*?)```/)[1];
  const keyRun = spawnSync('bash', ['-c', keyBlock], { env: envFor(home, { PATH: `${shims}:${process.env.PATH}` }), encoding: 'utf8' });
  check(/21st подключён/.test(keyRun.stdout), '21st не подключился из буфера (после согласия и ключа ученика)');
  check(!(keyRun.stdout + keyRun.stderr).includes(fakeKey), 'КЛЮЧ ПОПАЛ В ВЫВОД команды');
  check(!kit(home, '--run').stdout.includes('ждёт ключ: 21st'), 'после подключения 21st установка не должна ждать ключ');

  // ---------- 4. Отказ «не ставь набор» ----------
  const refuser = newHome('declined');
  mkdirSync(join(refuser, '.ii-ramis'));
  writeFileSync(join(refuser, '.ii-ramis', 'nabor.json'), '{"kit":"2.6.0","status":"declined"}\n');
  check(kit(refuser, '--notice').stdout.trim() === '' && kit(refuser, '--auto').stdout.trim() === '', 'при declined хуки должны молчать');
  const declinedRun = kit(refuser, '--run');
  check(/отказ ученика/.test(declinedRun.stdout), '--run при declined должен пропускать установку');
  check(!existsSync(join(refuser, '.claude', 'skills')), 'при declined ничего ставиться не должно');
  check(state(refuser).status === 'declined', 'declined нельзя затирать');
  const envOptOut = newHome('optout');
  check(kit(envOptOut, '--notice', { II_RAMIS_NO_KIT: '1' }).stdout.trim() === '' && !existsSync(join(envOptOut, '.ii-ramis', 'nabor.json')), 'II_RAMIS_NO_KIT=1 отключает хуки');

  // ---------- 5. Переход с 2.4.0 и лимит попыток ----------
  const upgrader = newHome('upgrade');
  mkdirSync(join(upgrader, '.ii-ramis'));
  writeFileSync(join(upgrader, '.ii-ramis', 'nabor.json'), '{"kit":"2.4.0","lesson":5,"status":"ok","tries":1}\n');
  check(/ставит инструменты урока 5/.test(kit(upgrader, '--notice').stdout), 'с 2.4.0 набор 2.6.0 должен докачиваться');
  const exhausted = newHome('tries');
  mkdirSync(join(exhausted, '.ii-ramis'));
  writeFileSync(join(exhausted, '.ii-ramis', 'nabor.json'), '{"kit":"2.6.0","lesson":5,"status":"partial","tries":3,"missing":"agent-reach","notes":"uv"}\n');
  check(kit(exhausted, '--notice').stdout.trim() === '' && kit(exhausted, '--auto').stdout.trim() === '', 'после 3 неудачных попыток хук сам не повторяет');

  // ---------- 6. Эмуляция песочницы ----------
  // Песочница Claude Desktop запрещает командам Bash писать в ~/.claude и ~/.claude.json (code.claude.com/docs/en/sandboxing, «protected paths»).
  // Здесь запрет эмулируется правами доступа. Это не настоящая песочница, но то же поведение: запись в эти пути невозможна.
  const boxed = newHome('sandbox');
  mkdirSync(join(boxed, '.claude'));
  writeFileSync(join(boxed, '.claude.json'), '{}\n');
  chmodSync(join(boxed, '.claude'), 0o555);
  chmodSync(join(boxed, '.claude.json'), 0o444);
  const viaBash = kit(boxed, '--run');
  console.log('--- через Bash в «песочнице» ---\n' + viaBash.stdout);
  check(!hasSkill(boxed, 'find-skills') && /НЕ ПОСТАВИЛОСЬ/.test(viaBash.stdout), 'эмуляция: при запрете записи установка Bash-командой должна честно не получиться');
  check(state(boxed).status === 'partial' && state(boxed).tries === 1, 'эмуляция: после неудачи status partial, а не ok');
  // Хук приложение выполняет вне песочницы, то есть с обычными правами: снимаем запрет и запускаем тем же путём, что и хук.
  chmodSync(join(boxed, '.claude'), 0o755);
  chmodSync(join(boxed, '.claude.json'), 0o644);
  const viaHook = kit(boxed, '--auto');
  check(/Набор урока 5 поставлен/.test(viaHook.stdout) && state(boxed).status === 'ok' && hasSkill(boxed, 'find-skills'), `хук должен довести установку до конца: ${viaHook.stdout}`);
  check(state(boxed).tries === 2, 'счётчик попыток должен считать обе попытки');

  // ---------- 7. Без uv: ничего системного не ставим, честно partial ----------
  const noUv = newHome('nouv');
  const noUvShims = join(noUv, '_bin');
  mkdirSync(noUvShims);
  const claudeBin = spawnSync('bash', ['-c', 'command -v claude'], { env: process.env, encoding: 'utf8' }).stdout.trim();
  symlinkSync(claudeBin, join(noUvShims, 'claude'));
  const noUvPath = [noUvShims, ...process.env.PATH.split(':').filter((dir) => !existsSync(join(dir, 'uv')) && !existsSync(join(dir, 'brew')))].join(':');
  const noUvRun = spawnSync('bash', [script, '--run'], { env: { ...envFor(noUv), PATH: noUvPath }, encoding: 'utf8', timeout: 900000 });
  check(/ЖДЁТ uv: agent-reach/.test(noUvRun.stdout) && state(noUv).status === 'partial' && /uv/.test(state(noUv).notes), 'без uv скрипт должен сказать «ЖДЁТ uv» и записать partial');
} finally {
  for (const dir of homes) {
    spawnSync('chmod', ['-R', 'u+rwX', dir]);
    rmSync(dir, { recursive: true, force: true });
  }
}

if (failures.length > 0) {
  console.error(failures.map((line) => `FAIL: ${line}`).join('\n'));
  process.exit(1);
}
console.log('OK: набор 2.6 ставится скриптом хука, повтор ничего не дублирует, отказ и песочница обработаны');
