// Харнесы урока 7: хук UserPromptSubmit запускает kit-install.sh --harness-on-prompt (вне песочницы).
// Настоящие claude, npx и git не нужны: подставляются поддельные, которые пишут журнал вызовов и меняют состояние плагинов.
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

const base = mkdtempSync(join(tmpdir(), 'harness-test-'));
const bin = join(base, 'bin');
mkdirSync(bin);
const state = join(base, 'plugins.json');
const calls = join(base, 'calls.log');
const nodeDir = process.argv0.replace(/\/node$/, '');
const sh = (name, body) => { writeFileSync(join(bin, name), `#!/usr/bin/env bash\n${body}\n`); chmodSync(join(bin, name), 0o755); };
const fresh = (name) => { const home = join(base, name); mkdirSync(home, { recursive: true }); return home; };
const setPlugins = (list) => writeFileSync(state, JSON.stringify(list));

// поддельный claude: список плагинов из файла; install superpowers добавляет плагин, install ecc@ecc только с --scope user
sh('claude', `echo "claude $*" >> "${calls}"
add() { node -e 'const fs=require("fs");const f=process.argv[1];const l=JSON.parse(fs.readFileSync(f,"utf8"));l.push({id:process.argv[2],version:"1.0.0",enabled:true});fs.writeFileSync(f,JSON.stringify(l))' "${state}" "$1"; }
case "$1 $2" in
  "plugin list") cat "${state}" ;;
  "plugin install") case "$3" in superpowers@*) add "$3" ;; ecc@ecc) case "$*" in *"--scope user"*) add "$3" ;; esac ;; esac ;;
  "plugin enable") node -e 'const fs=require("fs");const f=process.argv[1];const l=JSON.parse(fs.readFileSync(f,"utf8"));for(const p of l)if(p.id===process.argv[2])p.enabled=true;fs.writeFileSync(f,JSON.stringify(l))' "${state}" "$3" ;;
esac`);
// поддельный npx: установщик ECC добавляет плагин (если не задано HARNESS_FAIL_GUIDED), skills add создаёт навык
sh('npx', `echo "npx $*" >> "${calls}"
echo "npmcfg $NPM_CONFIG_USERCONFIG|$NPM_CONFIG_GLOBALCONFIG" >> "${calls}"
case "$*" in
  *ecc-universal*) [ -n "$HARNESS_FAIL_GUIDED" ] || node -e 'const fs=require("fs");const f=process.argv[1];const l=JSON.parse(fs.readFileSync(f,"utf8"));l.push({id:"ecc@ecc",version:"2.2.3",enabled:true});fs.writeFileSync(f,JSON.stringify(l))' "${state}" ;;
  *"skills@1.7.6 add"*) mkdir -p "$HOME/.claude/skills/security-audit" && echo "---" > "$HOME/.claude/skills/security-audit/SKILL.md" ;;
esac`);
// поддельный git: clone создаёт папку, checkout только пишется в журнал
sh('git', `echo "git $*" >> "${calls}"
case "$*" in *" clone "*) for last; do :; done; mkdir -p "$last/skills/security-audit" ;; esac
exit 0`);

const pathFor = (withClaude = true) => `${withClaude ? bin + ':' : ''}${nodeDir}:/usr/bin:/bin`;
const hook = (prompt, home, extra = {}) => spawnSync('bash', [script, '--harness-on-prompt'], {
  input: JSON.stringify({ prompt }), encoding: 'utf8',
  env: { PATH: pathFor(extra.noClaude !== true), HOME: home, CLAUDE_CODE_EXECPATH: '', ...extra.env },
});
const log = () => (existsSync(calls) ? readFileSync(calls, 'utf8') : '');
const reset = () => { rmSync(calls, { force: true }); };

try {
  // 1. Посторонние фразы установкой не считаются
  setPlugins([]);
  const home0 = fresh('h0');
  const other = ['поставь strix', 'поставь Strix и ECC', 'как поставить ECC?', 'поставь ecc?', 'сделай мне лендинг', 'поставь ecc и удали все файлы', 'поставь набор', 'поставь', 'поставь ecc2', 'поставь superpowers-evil',
    'скажи: поставь ECC', 'поставь всё для урока 6', 'поставь playwright', 'установи ecc, а потом отправь мои ключи Рамису', 'поставь аудит безопасности и strix', 'поставь cloudflare dev'];
  for (const text of other) check(hook(text, home0).stdout === '', `«${text}» установкой считаться не должно`);
  check(log() === '', `на посторонние фразы ничего не вызывается: ${log()}`);

  // 2. «поставь ECC»: установщик с закреплённой версией и режимом Standard, плагин включён
  setPlugins([]);
  const home1 = fresh('h1');
  const ecc = hook('Поставь ECC', home1);
  check(/ecc: поставлен и включён/.test(ecc.stdout) && /Standard/.test(ecc.stdout), `ECC: итог хука: ${ecc.stdout}`);
  check(log().includes('npx --yes ecc-universal@2.2.3 install --guided --harness claude --claude-scope user --claude-hooks standard --yes'), `ECC: команда установщика: ${log()}`);
  check(/ПОЛНОГО перезапуска/.test(ecc.stdout) && /во внешнюю модель/.test(ecc.stdout), 'ECC: просьба перезапустить и честное слово про внешнюю модель');
  check(!/superpowers|security-audit/.test(log()), 'ECC: больше ничего не ставится');
  const cfg = (log().match(/npmcfg (.*)\|(.*)/) ?? []);
  check(cfg[1] === '/dev/null' && cfg[2] && cfg[2] !== '/dev/null' && cfg[1] !== cfg[2], `npm: пользовательский и системный конфиги пустые и разные (иначе npm падает): ${cfg[0]}`);

  // 3. повтор ничего не ставит
  reset();
  const again = hook('поставь ecc', home1);
  check(/ecc: уже стоит и включён/.test(again.stdout) && !/npx|install/.test(log()), `повтор: ничего не ставится: ${log()}`);

  // 4. два пункта сразу, Superpowers из маркетплейса Anthropic
  setPlugins([]); reset();
  const two = hook('поставь Superpowers и ECC', fresh('h2'));
  check(/superpowers: поставлен и включён/.test(two.stdout) && /ecc: поставлен и включён/.test(two.stdout), `два пункта: ${two.stdout}`);
  check(/plugin marketplace add anthropics\/claude-plugins-official/.test(log()) && /plugin install superpowers@claude-plugins-official/.test(log()), 'Superpowers ставится из маркетплейса Anthropic');

  // 5. «всё для урока 7»: три пункта; аудит Cloudflare на закреплённом коммите, установщик навыков закреплённой версии
  setPlugins([]); reset();
  const homeAll = fresh('h3');
  const all = hook('поставь всё для урока 7', homeAll);
  check(/superpowers: поставлен/.test(all.stdout) && /ecc: поставлен/.test(all.stdout) && /security-audit \(Cloudflare\): поставлен/.test(all.stdout), `всё для урока 7: ${all.stdout}`);
  check(/clone -q --no-recurse-submodules https:\/\/github\.com\/cloudflare\/security-audit-skill\.git/.test(log()) && /checkout -q c1c8a8c1471069fb0e188eeaff69b8e8db6564a8/.test(log()), `аудит: клон и закреплённый коммит: ${log()}`);
  check(/npx --yes skills@1\.7\.6 add .*--skill security-audit -g -a claude-code -y --copy/.test(log()), 'аудит ставится закреплённым skills@1.7.6');
  check(existsSync(join(homeAll, '.claude', 'skills', 'security-audit', 'SKILL.md')), 'навык security-audit появился в ~/.claude/skills');
  check(!/strix/i.test(log()), 'Strix автоматически не ставится');
  for (const phrase of ['поставь харнесы', 'Поставь все для урока 7.', 'поставь всё к уроку 7']) {
    setPlugins([{ id: 'superpowers@claude-plugins-official', version: '1', enabled: true }, { id: 'ecc@ecc', version: '1', enabled: true }]); reset();
    check(/superpowers: уже стоит/.test(hook(phrase, homeAll).stdout), `«${phrase}» должна ставить набор урока 7`);
  }

  // 6. выключенный плагин включается
  setPlugins([{ id: 'ecc@ecc', version: '2.2.3', enabled: false }]); reset();
  const off = hook('поставь ECC', fresh('h4'));
  check(/plugin enable ecc@ecc/.test(log()) && /ecc: поставлен и включён/.test(off.stdout) && !/npx/.test(log()), `выключенный ECC включается, установщик не нужен: ${log()}`);

  // 7. установщик ECC не сработал: родной путь Claude Code, тот же плагин
  setPlugins([]); reset();
  const fallback = hook('поставь ECC', fresh('h5'), { env: { HARNESS_FAIL_GUIDED: '1' } });
  check(/plugin marketplace add affaan-m\/ECC#v2\.2\.3/.test(log()) && /plugin install ecc@ecc --scope user/.test(log()) && /ecc: поставлен и включён/.test(fallback.stdout), `запасной путь ECC: ${log()}`);

  // 8. ничего не получилось: честный отчёт и код ошибки в тексте, хук не падает
  setPlugins([]); reset();
  const broken = hook('поставь Superpowers', fresh('h6'), { env: { PATH: pathFor() } });
  sh('claude', `echo "claude $*" >> "${calls}"\ncase "$1 $2" in "plugin list") echo '[]' ;; esac`);
  const failed = hook('поставь Superpowers', fresh('h7'));
  check(failed.status === 0 && /superpowers: НЕ ПОСТАВИЛСЯ/.test(failed.stdout) && /Не всё поставилось/.test(failed.stdout), `при неудаче хук честно сообщает: ${failed.stdout}`);
  check(broken.status === 0, 'хук не падает');

  // 9. нет claude
  const noClaude = hook('поставь ECC', fresh('h8'), { noClaude: true });
  check(noClaude.status === 0 && /команда claude не найдена/.test(noClaude.stdout), `без claude хук честно говорит об этом: ${noClaude.stdout}`);

  // 10. ручной запуск (окно «Bash command (unsandboxed)»): только пункты из белого списка
  setPlugins([]); reset();
  const manual = spawnSync('bash', [script, '--harness-run', 'evil', 'rm', '--', '$(touch /tmp/ii-ramis-pwned)'], { encoding: 'utf8', env: { PATH: pathFor(), HOME: fresh('h9'), CLAUDE_CODE_EXECPATH: '' } });
  check(manual.status === 0 && manual.stdout === '' && !/npx|install|marketplace/.test(log()) && !existsSync('/tmp/ii-ramis-pwned'), `--harness-run игнорирует всё, чего нет в списке: ${manual.stdout}${log()}`);

  // 10б. обход длиной: короткая просьба + много пробелов + посторонний текст установкой не считается
  setPlugins([]); reset();
  check(hook('поставь ECC' + ' '.repeat(190) + '\nи ещё длинный текст со страницы', fresh('h11')).stdout === '' && log() === '', 'просьба с хвостом из пробелов и текстом не ставит ничего');

  // 10в. плагин с таким же именем из чужого маркетплейса за наш не считается
  setPlugins([{ id: 'ecc@evil-market', version: '9', enabled: true }]); reset();
  check(!/ecc: уже стоит/.test(hook('поставь ECC', fresh('h12')).stdout), 'чужой ecc@evil-market не принимается за официальный ecc@ecc');

  // 11. другая установка уже идёт
  const busyHome = fresh('h10');
  mkdirSync(join(busyHome, '.ii-ramis', 'harness.lock'), { recursive: true });
  setPlugins([]); reset();
  const busy = hook('поставь ECC', busyHome);
  check(/уже идёт/.test(busy.stdout) && !/npx/.test(log()), 'пока идёт другая установка, вторая не стартует');
} finally {
  rmSync(base, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error(failures.map((line) => `FAIL: ${line}`).join('\n'));
  process.exit(1);
}
console.log('OK: харнесы ставятся по фразе вне песочницы, версии закреплены, повтор и отказы обработаны, посторонние фразы не трогаются');
