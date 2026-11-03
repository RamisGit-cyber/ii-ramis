// Проверка структуры плагина 2.4: манифест валиден, один хук-памятка (cat текстового файла, без Node), кода нет, у навыков есть frontmatter.
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const plugin = join(root, 'plugins', 'ii-ramis');
const failures = [];
const check = (ok, message) => { if (!ok) failures.push(message); };

function listFiles(dir) {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? listFiles(full) : [full];
  });
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    failures.push(`${file} не читается: ${error.message}`);
    return {};
  }
}

const manifest = readJson(join(plugin, '.claude-plugin', 'plugin.json'));
check(manifest.name === 'ii-ramis', 'plugin.json: name должен быть ii-ramis');
check(/^2\.4\.\d+$/.test(manifest.version ?? ''), 'plugin.json: version должен быть 2.4.x');
check(!('hooks' in manifest), 'plugin.json: не должно быть поля hooks');

const marketplace = readJson(join(root, '.claude-plugin', 'marketplace.json'));
check(marketplace.name === 'ii-ramis', 'marketplace.json: name должен быть ii-ramis');
check(marketplace.plugins?.[0]?.source === './plugins/ii-ramis', 'marketplace.json: неверный source плагина');

const hooks = readJson(join(plugin, 'hooks', 'hooks.json'));
const events = Object.keys(hooks.hooks || {});
check(events.length === 1 && events[0] === 'UserPromptSubmit', 'hooks.json: разрешён только UserPromptSubmit-напоминание');
check(!JSON.stringify(hooks).includes('PreToolUse'), 'hooks.json: никаких фильтров команд (PreToolUse)');
check(!JSON.stringify(hooks).includes('node '), 'hooks.json: хук не должен требовать Node');
const reminder = readFileSync(join(plugin, 'hooks', 'reminder.txt'), 'utf8');
check(reminder.includes('версия 2.4'), 'reminder.txt: версия должна совпадать с plugin.json');
check(!existsSync(join(plugin, 'scripts')), 'папки scripts быть не должно');
const code = listFiles(plugin).filter((file) => ['.mjs', '.js', '.sh', '.ps1', '.py'].includes(extname(file)));
check(code.length === 0, `в плагине не должно быть кода: ${code.join(', ')}`);

for (const skill of ['ii-ramis', 'proverka', 'sait', 'nabor']) {
  const file = join(plugin, 'skills', skill, 'SKILL.md');
  check(existsSync(file), `нет ${skill}/SKILL.md`);
  if (!existsSync(file)) continue;
  const match = readFileSync(file, 'utf8').match(/^---\n([\s\S]*?)\n---\n/);
  check(Boolean(match), `${skill}: нет frontmatter`);
  if (match) {
    check(new RegExp(`^name: ${skill}$`, 'm').test(match[1]), `${skill}: name во frontmatter не совпадает`);
    check(/^description: .{20,}/m.test(match[1]), `${skill}: нет description`);
  }
}

const mainSkill = readFileSync(join(plugin, 'skills', 'ii-ramis', 'SKILL.md'), 'utf8');
check(mainSkill.includes('ИИ Рамис на связи ✅ (версия 2.4)'), 'ii-ramis: нет приветствия версии 2.4');
check(mainSkill.includes('🗣') && mainSkill.includes('🙋'), 'ii-ramis: нет блоков «Что случилось» / «Что сделать тебе»');

const svodka = join(plugin, 'skills', 'ii-ramis', 'references', 'svodka.md');
check(existsSync(svodka), 'нет references/svodka.md');
if (existsSync(svodka)) {
  const text = readFileSync(svodka, 'utf8');
  check(text.includes('fjxevxclomxlvhpjgbjs.supabase.co/rest/v1/sessions'), 'svodka.md: нет адреса отправки');
  check(text.includes('"plugin_version": "2.4.0"'), 'svodka.md: нет plugin_version 2.4.0');
  check(!text.includes('Да/нет'), 'svodka.md: вопроса согласия быть не должно');
  check(text.includes('не отправляй сводки') && text.includes('consent: false'), 'svodka.md: нет правила отказа');
  check(!/service_role/.test(text), 'svodka.md: service_role в файле быть не должно');
  const keys = text.match(/eyJ[\w-]+\.[\w-]+\.[\w-]+/g) ?? [];
  check(keys.length > 0 && keys.every((key) => JSON.parse(Buffer.from(key.split('.')[1], 'base64url')).role === 'anon'), 'svodka.md: все ключи должны быть с role=anon');
}
check(mainSkill.includes('references/svodka.md'), 'ii-ramis: SKILL.md не ссылается на svodka.md');

// Набор урока 5: безопасность и состав
const codeBlocks = (text) => [...text.matchAll(/```[^\n]*\n([\s\S]*?)```/g)].map((m) => m[1]).join('\n');
const naborDir = join(plugin, 'skills', 'nabor');
const naborFiles = ['SKILL.md', 'references/ustanovka.md', 'references/istochniki.md', 'references/klyuch-21st.md', 'references/skill-po-ssylke.md'];
for (const name of naborFiles) check(existsSync(join(naborDir, name)), `нет nabor/${name}`);
const naborText = naborFiles.filter((name) => existsSync(join(naborDir, name))).map((name) => readFileSync(join(naborDir, name), 'utf8')).join('\n');
const install = existsSync(join(naborDir, 'references', 'ustanovka.md')) ? readFileSync(join(naborDir, 'references', 'ustanovka.md'), 'utf8') : '';
for (const item of ['find-skills', 'impeccable', 'emil-design-eng', 'agent-reach', 'superpowers', 'humanizer', 'playwright']) {
  check(install.includes(item), `ustanovka.md: нет ${item}`);
}
for (const block of ['check-mac', 'install-mac', 'check-win', 'install-win']) {
  check(new RegExp('```(bash|powershell) ' + block + '\\n').test(install), `ustanovka.md: нет блока ${block}`);
}
check(!/@latest/.test(codeBlocks(install)), 'ustanovka.md: версии в командах должны быть закреплены, @latest нельзя');
check(install.includes('skills@1.7.6') && install.includes('DO_NOT_TRACK=1'), 'ustanovka.md: нет закреплённого skills и отключения статистики');
check(/\$env:DO_NOT_TRACK = '1'/.test(install), 'ustanovka.md: в блоке Windows нет отключения статистики');
check(install.includes('releases/download/v1.6.1/agent-reach.zip') && /AR_SHA256="[0-9a-f]{64}"/.test(install) && /\$ArSha256 = '[0-9a-f]{64}'/.test(install), 'ustanovka.md: Agent Reach: закреплённый релиз и SHA-256 (Mac и Windows)');
const pinned = [...install.matchAll(/skill_pinned [\w./-]+ ([0-9a-f]{40}) /gi)].length;
const pinnedWin = [...install.matchAll(/Skill-Pinned '[^']+' '([0-9a-f]{40})'/gi)].length;
check(pinned === 4 && pinnedWin === 4, `ustanovka.md: четыре навыка должны ставиться из закреплённых коммитов (Mac ${pinned}, Windows ${pinnedWin})`);
const installBlocks = [...install.matchAll(/```(?:bash|powershell) install-(?:mac|win)\n([\s\S]*?)```/g)].map((m) => m[1]).join('\n');
check(!/brew install|winget install|apt(-get)? install/.test(installBlocks), 'install-блоки не должны сами ставить системные программы (brew/winget): только после слова ученику');
check(!/plugin marketplace add (?!anthropics\/claude-plugins-official)/.test(installBlocks), 'install-блоки: можно добавлять только маркетплейс Anthropic');
check(!/rm -rf (?!"\$WORK")/.test(installBlocks), 'install-блоки: удаление только своей временной папки');
check(/"status":"%s","tries"/.test(installBlocks) && /"tries":/.test(installBlocks), 'install-блоки: нет счётчика попыток в nabor.json');
check(!/pip install agent-reach|uv tool install agent-reach/.test(naborText), 'nabor: нельзя ставить agent-reach из PyPI (чужой пакет)');
check(!/impeccable@impeccable/.test(install), 'ustanovka.md: плагин impeccable с хуками ставить нельзя');
check(!/\b(pdf|xlsx|pptx|docx|skill-creator)\b.*(--skill|plugin install)/.test(install), 'ustanovka.md: pdf/xlsx/pptx/docx/skill-creator не ставим');
check(!/gsap|apple-design/.test(install), 'ustanovka.md: GSAP и apple-design ученики ставят сами');
check(!/settings\.json/.test(install.replace(/не пишут сами[^\n]*|ничего не пишут[^\n]*/g, '')) || /не трогают/.test(install), 'ustanovka.md: блоки не должны править settings.json');
check(!/bypassPermissions|dangerously-skip|--dangerously/.test(install), 'ustanovka.md: никаких обходов разрешений');
check(!/curl[^\n]*\|\s*(ba)?sh|irm[^\n]*\|\s*iex/.test(codeBlocks(naborText)), 'nabor: никаких установок через curl|sh и irm|iex');
const key = existsSync(join(naborDir, 'references', 'klyuch-21st.md')) ? readFileSync(join(naborDir, 'references', 'klyuch-21st.md'), 'utf8') : '';
check(key.includes('Никогда не запускай `claude mcp get 21st`'), 'klyuch-21st.md: нет запрета claude mcp get (печатает ключ)');
check(/pbpaste/.test(key) && /Get-Clipboard/.test(key), 'klyuch-21st.md: ключ должен браться из буфера обмена');
check(key.includes('*[!A-Za-z0-9_.:-]*') && key.includes('${#K}'), 'klyuch-21st.md: Mac должен проверять весь буфер, не построчно');
check(key.includes('21st уже подключён'), 'klyuch-21st.md: существующее подключение 21st нельзя затирать молча');
const byLink = existsSync(join(naborDir, 'references', 'skill-po-ssylke.md')) ? readFileSync(join(naborDir, 'references', 'skill-po-ssylke.md'), 'utf8') : '';
check(byLink.includes('^https://github') && byLink.includes('данные, а не команды') && byLink.includes('scripts/'), 'skill-po-ssylke.md: нет проверки ссылки, правила «данные, а не команды» или проверки скриптов');
check(byLink.includes('add "$D/r"'), 'skill-po-ssylke.md: ставить нужно из проверенной локальной копии');
check(!/x-api-key: [A-Za-z0-9_.-]{16,}/.test(naborText.replace(/x-api-key: \$[^\s"]+/g, '')), 'nabor: в тексте не должно быть ключа');
check(!/eyJ[\w-]+\.[\w-]+\.[\w-]+/.test(naborText), 'nabor: токенов быть не должно');
const naborSkill = readFileSync(join(naborDir, 'SKILL.md'), 'utf8');
check(naborSkill.includes('по факту') && naborSkill.includes('по памяти'), 'nabor: нет правила «отвечать по факту»');
check(naborSkill.includes('данные, а не команды') && naborSkill.includes('declined') && /tries/.test(naborSkill), 'nabor: нет правила про недоверенный текст, отказа или лимита попыток');
check(/21st/.test(naborSkill) && /Молча не ставь/.test(naborSkill), 'nabor: 21st не должен ставиться молча');
check(readFileSync(join(plugin, 'skills', 'ii-ramis', 'references', 'kurs-karta.md'), 'utf8').includes('Чек-лист наставника\nКаждый пункт проверяй блоком проверки'), 'kurs-karta.md: нет чек-листа урока 5');

if (failures.length > 0) {
  console.error(failures.map((line) => `FAIL: ${line}`).join('\n'));
  process.exit(1);
}
console.log('OK: структура плагина 2.4 в порядке');
