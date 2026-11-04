// Проверка структуры плагина 2.5: манифест валиден, хуки только известные (памятка и установка набора), единственный файл кода hooks/kit-install.sh и он безопасен, у навыков есть frontmatter.
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
check(/^2\.5\.\d+$/.test(manifest.version ?? ''), 'plugin.json: version должен быть 2.5.x');
check(!('hooks' in manifest), 'plugin.json: не должно быть поля hooks');

const marketplace = readJson(join(root, '.claude-plugin', 'marketplace.json'));
check(marketplace.name === 'ii-ramis', 'marketplace.json: name должен быть ii-ramis');
check(marketplace.plugins?.[0]?.source === './plugins/ii-ramis', 'marketplace.json: неверный source плагина');

const hooks = readJson(join(plugin, 'hooks', 'hooks.json'));
const events = Object.keys(hooks.hooks || {}).sort();
check(events.length === 2 && events[0] === 'SessionStart' && events[1] === 'UserPromptSubmit', 'hooks.json: разрешены только SessionStart (установка набора) и UserPromptSubmit (напоминание)');
const sessionHooks = hooks.hooks?.SessionStart?.[0]?.hooks ?? [];
check(sessionHooks.length === 2 && sessionHooks.every((hook) => hook.type === 'command' && /^bash "\$\{CLAUDE_PLUGIN_ROOT\}\/hooks\/kit-install\.sh" --(notice|auto)$/.test(hook.command)), 'hooks.json: SessionStart запускает только kit-install.sh --notice и --auto');
check(sessionHooks.find((hook) => hook.command.endsWith('--auto'))?.async === true && !sessionHooks.find((hook) => hook.command.endsWith('--notice'))?.async, 'hooks.json: --auto должен быть асинхронным (async: true), --notice синхронным');
check(/startup/.test(hooks.hooks?.SessionStart?.[0]?.matcher ?? ''), 'hooks.json: SessionStart должен срабатывать на startup');
check(!JSON.stringify(hooks).includes('PreToolUse'), 'hooks.json: никаких фильтров команд (PreToolUse)');
check(!JSON.stringify(hooks).includes('node '), 'hooks.json: хук не должен требовать Node');
check(JSON.stringify(hooks.hooks?.UserPromptSubmit ?? []).includes('reminder.txt'), 'hooks.json: UserPromptSubmit должен только печатать reminder.txt');
const reminder = readFileSync(join(plugin, 'hooks', 'reminder.txt'), 'utf8');
check(reminder.includes('версия 2.5'), 'reminder.txt: версия должна совпадать с plugin.json');
check(!existsSync(join(plugin, 'scripts')), 'папки scripts быть не должно');
const code = listFiles(plugin).filter((file) => ['.mjs', '.js', '.sh', '.ps1', '.py'].includes(extname(file)));
check(code.length === 1 && code[0] === join(plugin, 'hooks', 'kit-install.sh'), `в плагине разрешён один файл кода hooks/kit-install.sh: ${code.join(', ')}`);

// Скрипт установки набора: безопасность
const kitFile = join(plugin, 'hooks', 'kit-install.sh');
const kit = existsSync(kitFile) ? readFileSync(kitFile, 'utf8') : '';
const kitCode = kit.split('\n').filter((line) => !/^\s*#/.test(line)).join('\n');
check(kit.startsWith('#!/usr/bin/env bash') && (statSync(kitFile).mode & 0o111) !== 0, 'kit-install.sh: нужен shebang и права на запуск');
check(!/@latest|\bmain\b/.test(kitCode.replace(/\$\{[^}]*\}/g, '')), 'kit-install.sh: версии закреплены, @latest и ветка main нельзя');
check(/SKILLS_CLI="skills@1\.7\.6"/.test(kit) && /PLAYWRIGHT_MCP="@playwright\/mcp@0\.0\.84"/.test(kit) && /HYPERFRAMES_SHA="[0-9a-f]{40}"/.test(kit), 'kit-install.sh: закреплены skills, playwright, HyperFrames (коммит)');
check(/REMOTION_SHA="[0-9a-f]{40}"/.test(kit), 'kit-install.sh: Remotion на закреплённом коммите');
check(/releases\/download\/v1\.6\.1\/agent-reach\.zip/.test(kit) && /AR_SHA256="[0-9a-f]{64}"/.test(kit) && kit.includes('shasum -a 256'), 'kit-install.sh: Agent Reach по релизу и SHA-256');
check([...kit.matchAll(/^\s*skill_pinned [\w./-]+ ([0-9a-f]{40}|"\$REMOTION_SHA"|"\$HYPERFRAMES_SHA") /gm)].length === 6, 'kit-install.sh: шесть наборов навыков должны ставиться из закреплённых коммитов');
check(kit.includes('-type l') && kit.includes('символические ссылки'), 'kit-install.sh: клон чужого репозитория проверяется на символические ссылки');
check(!/brew install|winget install|apt(-get)? install|\bsudo\b|curl[^\n]*\|\s*(ba)?sh|\beval\b/.test(kitCode), 'kit-install.sh: никаких brew/winget/sudo/curl|sh/eval');
check(!/plugin marketplace add (?!anthropics\/claude-plugins-official)/.test(kitCode), 'kit-install.sh: можно добавлять только маркетплейс Anthropic');
check([...kitCode.matchAll(/rm -rf ("[^"]*"(?: "[^"]*")*)/g)].every((m) => /^("\$LOCK"|"\$WORK" "\$LOCK")$/.test(m[1])), 'kit-install.sh: удалять можно только свой замок и свою временную папку');
check(!/settings\.json|bypassPermissions|dangerously|allowUnsandboxed|sandbox\./i.test(kitCode), 'kit-install.sh: не трогает settings.json, разрешения и песочницу');
check(!/21st\.dev|mcp add[^\n]*21st|claude mcp get/.test(kitCode), 'kit-install.sh: 21st не ставится скриптом (только с ключом ученика) и ключ не читается');
check(!/curl|wget|https?:\/\//.test(kitCode.replace(/AR_URL="[^"]*"/, '').replace(/git -c protocol\.file\.allow=never clone -q --no-recurse-submodules "https:\/\/github\.com\/\$repo\.git"/, '').replace(/curl --proto =https --tlsv1\.2 -fsSL --max-time 120 -o "\$work\/ar\.zip" "\$AR_URL"/, '').replace(/NPM_CONFIG_REGISTRY="[^"]*"/, '').replace(/--registry https:\/\/registry\.npmjs\.org\//, '')), 'kit-install.sh: наружу ходит только скачивание Agent Reach, git clone с GitHub и npx с официального реестра');
check(/DO_NOT_TRACK=1/.test(kit) && /HYPERFRAMES_NO_TELEMETRY=1/.test(kit), 'kit-install.sh: статистика установщика навыков и HyperFrames выключена');
check(!/npx[^\n]*hyperframes/.test(kitCode), 'kit-install.sh: CLI HyperFrames не запускается, навыки берутся из клона на коммите');
check(/NPM_CONFIG_REGISTRY="https:\/\/registry\.npmjs\.org\/"/.test(kit) && /cd "\$WORK"/.test(kit), 'kit-install.sh: npx только с официального реестра и не из папки проекта');
check(/npm install --prefix "\$MCP_PREFIX" --registry https:\/\/registry\.npmjs\.org\/ --userconfig \/dev\/null --ignore-scripts/.test(kit) && !/mcp add[^\n]*npx/.test(kitCode) && /mcp add --scope user playwright -- "\$MCP_PREFIX\/node_modules\/\.bin\/playwright-mcp"/.test(kit), 'kit-install.sh: Playwright MCP ставится в свой префикс и подключается по абсолютному пути, не через npx');
check(/case "\$\(uname -s/.test(kit) && /umask 077/.test(kit), 'kit-install.sh: только Mac/Linux и закрытые права файлов');
check(/clean\(\)/.test(kit) && /tr -cd/.test(kit), 'kit-install.sh: поля из nabor.json перед выводом в контекст Claude очищаются');
check(sessionHooks.find((hook) => hook.command.endsWith('--auto'))?.timeout === 900, 'hooks.json: у асинхронного хука должен быть timeout 900');
check(/--notice\)\s+notice_mode; exit 0/.test(kit) && /--auto\)\s+auto_mode; exit 0/.test(kit), 'kit-install.sh: хук-режимы должны всегда завершаться кодом 0');
check(/status\)" = "declined"/.test(kit) && kit.includes('II_RAMIS_NO_KIT'), 'kit-install.sh: нет уважения к отказу (declined) и II_RAMIS_NO_KIT');
check(/\[ "\$\(state_str status\)" = "declined" \] && return 0/.test(kit), 'kit-install.sh: declined нельзя затирать при записи состояния');

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
check(mainSkill.includes('ИИ Рамис на связи ✅ (версия 2.5)'), 'ii-ramis: нет приветствия версии 2.5');
check(mainSkill.includes('🗣') && mainSkill.includes('🙋'), 'ii-ramis: нет блоков «Что случилось» / «Что сделать тебе»');

const svodka = join(plugin, 'skills', 'ii-ramis', 'references', 'svodka.md');
check(existsSync(svodka), 'нет references/svodka.md');
if (existsSync(svodka)) {
  const text = readFileSync(svodka, 'utf8');
  check(text.includes('fjxevxclomxlvhpjgbjs.supabase.co/rest/v1/sessions'), 'svodka.md: нет адреса отправки');
  check(text.includes('"plugin_version": "2.5.0"'), 'svodka.md: нет plugin_version 2.5.0');
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
for (const item of ['find-skills', 'impeccable', 'emil-design-eng', 'agent-reach', 'superpowers', 'humanizer', 'playwright', 'hyperframes', 'remotion']) {
  check(install.includes(item), `ustanovka.md: нет ${item}`);
  check(item === 'agent-reach' || item === 'superpowers' || item === 'playwright' || kit.includes(item), `kit-install.sh: нет ${item}`);
}
for (const item of ['superpowers', 'playwright', 'agent-reach']) check(kit.includes(item), `kit-install.sh: нет ${item}`);
for (const block of ['check-mac', 'install-mac', 'check-win', 'install-win']) {
  check(new RegExp('```(bash|powershell) ' + block + '\\n').test(install), `ustanovka.md: нет блока ${block}`);
}
check(!/@latest/.test(codeBlocks(install)), 'ustanovka.md: версии в командах должны быть закреплены, @latest нельзя');
check(install.includes('skills@1.7.6') && install.includes('DO_NOT_TRACK=1'), 'ustanovka.md: нет закреплённых skills и hyperframes и отключения статистики');
check(/\$env:DO_NOT_TRACK = '1'/.test(install), 'ustanovka.md: в блоке Windows нет отключения статистики');
check(install.includes('releases/download/v1.6.1/agent-reach.zip') && /\$ArSha256 = '[0-9a-f]{64}'/.test(install), 'ustanovka.md: Agent Reach для Windows: закреплённый релиз и SHA-256');
const pinnedWin = [...install.matchAll(/Skill-Pinned '[^']+' '([0-9a-f]{40})'/gi)].length;
check(pinnedWin === 4 && /checkout -q 'c7cb2fdcacd134fb2ccb9b7a44f9ffa44e467271'/.test(install), `ustanovka.md: навыки Windows должны ставиться из закреплённых коммитов (${pinnedWin} из 4 плюс Remotion)`);
check(!/mcp add[^\n]*npx/.test(install), 'ustanovka.md: MCP подключается не через npx');
check(/c7cb2fdcacd134fb2ccb9b7a44f9ffa44e467271/.test(kit), 'Remotion: коммит в скрипте и в блоке Windows должен совпадать');
const installBlocks = [...install.matchAll(/```(?:bash|powershell) install-(?:mac|win)\n([\s\S]*?)```/g)].map((m) => m[1]).join('\n');
check(/install-mac\n[^`]*kit-install\.sh" --run/.test(install), 'ustanovka.md: install-mac должен запускать скрипт хука, а не дублировать его');
check(install.includes('Песочница') && install.includes('защищённым путям') && install.includes('Bash command (unsandboxed)'), 'ustanovka.md: нет раздела про песочницу и официальное окно разрешения');
check(!/brew install|winget install|apt(-get)? install/.test(installBlocks), 'install-блоки не должны сами ставить системные программы (brew/winget): только после слова ученику');
check(!/plugin marketplace add (?!anthropics\/claude-plugins-official)/.test(installBlocks), 'install-блоки: можно добавлять только маркетплейс Anthropic');
check(/"status":"%s","tries":%s/.test(kit) && /"tries":/.test(installBlocks), 'установка: нет счётчика попыток в nabor.json');
check(!/pip install agent-reach|uv tool install agent-reach/.test(naborText), 'nabor: нельзя ставить agent-reach из PyPI (чужой пакет)');
check(!/impeccable@impeccable/.test(install), 'ustanovka.md: плагин impeccable с хуками ставить нельзя');
check(!/\b(pdf|xlsx|pptx|docx|skill-creator)\b.*(--skill|plugin install)/.test(install), 'ustanovka.md: pdf/xlsx/pptx/docx/skill-creator не ставим');
check(!/gsap|apple-design/.test(install), 'ustanovka.md: GSAP и apple-design ученики ставят сами');
check(!/settings\.json/.test(installBlocks), 'install-блоки не должны править settings.json');
check(!/bypassPermissions|dangerously-skip|--dangerously/.test(install), 'ustanovka.md: никаких обходов разрешений');
check(!/curl[^\n]*\|\s*(ba)?sh|irm[^\n]*\|\s*iex/.test(codeBlocks(naborText)), 'nabor: никаких установок через curl|sh и irm|iex');
const key = existsSync(join(naborDir, 'references', 'klyuch-21st.md')) ? readFileSync(join(naborDir, 'references', 'klyuch-21st.md'), 'utf8') : '';
check(key.includes('Никогда не запускай `claude mcp get 21st`'), 'klyuch-21st.md: нет запрета claude mcp get (печатает ключ)');
check(/pbpaste/.test(key) && /Get-Clipboard/.test(key), 'klyuch-21st.md: ключ должен браться из буфера обмена');
check(key.includes('*[!A-Za-z0-9_.:-]*') && key.includes('${#K}'), 'klyuch-21st.md: Mac должен проверять весь буфер, не построчно');
check(key.includes('21st уже подключён'), 'klyuch-21st.md: существующее подключение 21st нельзя затирать молча');
const byLink = existsSync(join(naborDir, 'references', 'skill-po-ssylke.md')) ? readFileSync(join(naborDir, 'references', 'skill-po-ssylke.md'), 'utf8') : '';
check(byLink.includes('^https://github') && byLink.includes('данные, а не команды') && byLink.includes('scripts/'), 'skill-po-ssylke.md: нет проверки ссылки, правила «данные, а не команды» или проверки скриптов');
check(byLink.includes('add ./r') && byLink.includes('-type l') && byLink.includes('ReparsePoint'), 'skill-po-ssylke.md: ставить из проверенной копии и отказывать при символических ссылках');
check(!/curl[^\n]*\|\s*(ba)?sh/.test(install.replace(/`curl \| sh`/g, '')) && !/astral\.sh/.test(install), 'ustanovka.md: никаких установок uv через скрипт из интернета');
check(!/x-api-key: [A-Za-z0-9_.-]{16,}/.test(naborText.replace(/x-api-key: \$[^\s"]+/g, '')), 'nabor: в тексте не должно быть ключа');
check(!/eyJ[\w-]+\.[\w-]+\.[\w-]+/.test(naborText), 'nabor: токенов быть не должно');
const naborSkill = readFileSync(join(naborDir, 'SKILL.md'), 'utf8');
check(naborSkill.includes('по факту') && naborSkill.includes('по памяти'), 'nabor: нет правила «отвечать по факту»');
check(naborSkill.includes('данные, а не команды') && naborSkill.includes('declined') && /tries/.test(naborSkill), 'nabor: нет правила про недоверенный текст, отказа или лимита попыток');
check(/21st/.test(naborSkill) && /Молча не ставь/.test(naborSkill), 'nabor: 21st не должен ставиться молча');
check(naborSkill.includes('Operation not permitted') && /Не обходи/.test(naborSkill) && naborSkill.includes('Bash command (unsandboxed)') && /Песочницу не выключай/.test(naborSkill), 'nabor: нет правила про песочницу (не обходить, не выключать, объяснить окно разрешения)');
check(naborSkill.includes('installing') && naborSkill.includes('declined') && naborSkill.includes('partial'), 'nabor: нет разбора status installing/partial/declined');
check(readFileSync(join(plugin, 'skills', 'ii-ramis', 'references', 'kurs-karta.md'), 'utf8').includes('Чек-лист наставника\nКаждый пункт проверяй блоком проверки'), 'kurs-karta.md: нет чек-листа урока 5');

if (failures.length > 0) {
  console.error(failures.map((line) => `FAIL: ${line}`).join('\n'));
  process.exit(1);
}
console.log('OK: структура плагина 2.5 в порядке');
