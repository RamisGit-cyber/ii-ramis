// Обновление плагина по фразе ученика: хук UserPromptSubmit запускает kit-install.sh --update-on-prompt (вне песочницы).
// Настоящий claude не нужен: подставляется поддельный, который меняет версию после `plugin update`.
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const script = join(root, 'plugins', 'ii-ramis', 'hooks', 'kit-install.sh');
const failures = [];
const check = (ok, message) => { if (!ok) failures.push(message); };
if (spawnSync('node', ['-e', '1']).status !== 0 || spawnSync('bash', ['-c', 'true']).status !== 0) { console.log('SKIP: нет node или bash'); process.exit(0); }

const base = mkdtempSync(join(tmpdir(), 'update-test-'));
const home = join(base, 'home');
const bin = join(base, 'bin');
mkdirSync(home);
mkdirSync(bin);
const versionFile = join(base, 'version');
const calls = join(base, 'calls.log');
writeFileSync(versionFile, '2.7.1');
writeFileSync(join(bin, 'claude'), `#!/usr/bin/env bash
echo "$@" >> "${calls}"
case "$1 $2" in
  "plugin list") echo "[{\\"id\\":\\"ii-ramis@ii-ramis\\",\\"version\\":\\"$(cat "${versionFile}")\\"}]" ;;
  "plugin marketplace") echo "marketplace updated" ;;
  "plugin update") echo "2.7.2" > "${versionFile}"; echo "updated" ;;
esac
`);
chmodSync(join(bin, 'claude'), 0o755);
const systemPath = `${bin}:${process.argv0.replace(/\/node$/, '')}:/usr/bin:/bin`;
const run = (prompt, homeDir = home, path = systemPath) => spawnSync('bash', [script, '--update-on-prompt'], {
  input: JSON.stringify({ prompt }), encoding: 'utf8',
  env: { PATH: path, HOME: homeDir, CLAUDE_CODE_EXECPATH: '' },
});

try {
  const other = ['обнови страницу сайта', 'обнови плагин?', 'сделай мне лендинг', 'как обновить плагин ИИ Рамис?', 'обнови Node'];
  for (const text of other) check(run(text).stdout === '', `«${text}» обновлением считаться не должно`);
  check(!existsSync(calls), 'на посторонние фразы claude не вызывается');
  const first = run('Обнови плагин ИИ Рамис');
  check(/до: 2\.7\.1/.test(first.stdout) && /после: 2\.7\.2/.test(first.stdout), `версия до и после в ответе хука: ${first.stdout}`);
  check(/ПОЛНОСТЬЮ перезапустить/.test(first.stdout), 'хук просит полностью перезапустить приложение');
  const log = readFileSync(calls, 'utf8');
  check(/plugin marketplace update ii-ramis/.test(log) && /plugin update ii-ramis@ii-ramis/.test(log), `команды обновления не те: ${log}`);
  writeFileSync(versionFile, '2.7.1');
  check(/после: 2\.7\.2/.test(run('обновись').stdout), '«обновись» тоже обновляет');
  writeFileSync(versionFile, '2.7.1');
  check(/после: 2\.7\.2/.test(run('обнови плагин').stdout), '«обнови плагин» тоже обновляет');
  const noClaude = run('обнови плагин', join(base, 'empty'), `${process.argv0.replace(/\/node$/, '')}:/usr/bin:/bin`);
  check(noClaude.status === 0 && /команда claude не найдена/.test(noClaude.stdout), `без claude хук честно говорит об этом и не падает: ${noClaude.stdout}`);
} finally {
  rmSync(base, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error(failures.map((line) => `FAIL: ${line}`).join('\n'));
  process.exit(1);
}
console.log('OK: «обнови плагин» запускает обновление вне песочницы, версия до и после, посторонние фразы не трогаются');
