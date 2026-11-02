// Проверка структуры плагина 2.1: манифест валиден, хуков и исполняемого кода нет, у навыков есть frontmatter.
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
check(/^2\.1\.\d+$/.test(manifest.version ?? ''), 'plugin.json: version должен быть 2.1.x');
check(!('hooks' in manifest), 'plugin.json: не должно быть поля hooks');

const marketplace = readJson(join(root, '.claude-plugin', 'marketplace.json'));
check(marketplace.name === 'ii-ramis', 'marketplace.json: name должен быть ii-ramis');
check(marketplace.plugins?.[0]?.source === './plugins/ii-ramis', 'marketplace.json: неверный source плагина');

check(!existsSync(join(plugin, 'hooks')), 'папки hooks быть не должно');
check(!existsSync(join(plugin, 'scripts')), 'папки scripts быть не должно');
const code = listFiles(plugin).filter((file) => ['.mjs', '.js', '.sh', '.ps1', '.py'].includes(extname(file)));
check(code.length === 0, `в плагине не должно быть кода: ${code.join(', ')}`);

for (const skill of ['ii-ramis', 'proverka', 'sait']) {
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
check(mainSkill.includes('ИИ Рамис на связи ✅ (версия 2.1)'), 'ii-ramis: нет приветствия версии 2.1');
check(mainSkill.includes('🗣') && mainSkill.includes('🙋'), 'ii-ramis: нет блоков «Что случилось» / «Что сделать тебе»');

const svodka = join(plugin, 'skills', 'ii-ramis', 'references', 'svodka.md');
check(existsSync(svodka), 'нет references/svodka.md');
if (existsSync(svodka)) {
  const text = readFileSync(svodka, 'utf8');
  check(text.includes('fjxevxclomxlvhpjgbjs.supabase.co/rest/v1/sessions'), 'svodka.md: нет адреса отправки');
  check(text.includes('"plugin_version": "2.1.0"'), 'svodka.md: нет plugin_version 2.1.0');
  check(text.includes('Код, файлы и ключи не отправляются. Да/нет'), 'svodka.md: нет текста вопроса согласия');
  check(!/service_role/.test(text), 'svodka.md: service_role в файле быть не должно');
  const keys = text.match(/eyJ[\w-]+\.[\w-]+\.[\w-]+/g) ?? [];
  check(keys.length > 0 && keys.every((key) => JSON.parse(Buffer.from(key.split('.')[1], 'base64url')).role === 'anon'), 'svodka.md: все ключи должны быть с role=anon');
}
check(mainSkill.includes('references/svodka.md'), 'ii-ramis: SKILL.md не ссылается на svodka.md');

if (failures.length > 0) {
  console.error(failures.map((line) => `FAIL: ${line}`).join('\n'));
  process.exit(1);
}
console.log('OK: структура плагина 2.1 в порядке');
