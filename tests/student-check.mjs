// Прогон списков действий через decide(): node tests/student-check.mjs <allow|block> <файл>
// Формат строки: Инструмент|значение (Bash, PowerShell, Read, Write, Edit, Glob, Grep, WebFetch). «⏎» внутри значения = перевод строки.
// allow: действие обязано пройти (то, что Claude делает за ученика); block: обязано быть закрыто (три защищаемые вещи).
// Запускать с HOME во временной папке: HOME=$(mktemp -d) node tests/student-check.mjs allow tests/attacks/student.txt
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { decide, Denied, Ask } = await import(path.join(root, 'plugins/ii-ramis/scripts/guard-core.mjs'));
const [mode, file] = process.argv.slice(2);
if (!['allow', 'block'].includes(mode) || !file) {
  console.error('usage: student-check.mjs <allow|block> <файл>');
  process.exit(2);
}
const home = process.env.HOME;
const cwd = path.join(home, 'proj');
fs.mkdirSync(cwd, { recursive: true });
const FIELDS = { Bash: 'command', PowerShell: 'command', Read: 'file_path', Write: 'file_path', Edit: 'file_path', Glob: 'pattern', Grep: 'pattern', WebFetch: 'url' };
const printOnly = process.env.PRINT_PASSING === '1';
let ok = 0;
let fail = 0;
for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
  if (!line.trim() || line.startsWith('#')) continue;
  const bar = line.indexOf('|');
  const tool = line.slice(0, bar);
  let value = line.slice(bar + 1).replace(/⏎/g, '\n');
  if (!['Bash', 'PowerShell', 'Grep', 'WebFetch'].includes(tool)) value = value.replace(/^~\//, `${home}/`);
  const input = { tool_name: tool, cwd, tool_input: { [FIELDS[tool]]: value } };
  if (tool === 'Write') input.tool_input.content = 'x';
  if (tool === 'Grep') input.tool_input.path = '.';
  let reason = null;
  try {
    reason = decide(input);
  } catch (error) {
    if (error instanceof Ask) reason = null; // вопрос ученику: не отказ
    else if (error instanceof Denied) reason = error.message;
    else throw error;
  }
  const blocked = Boolean(reason);
  const good = mode === 'allow' ? !blocked : blocked;
  if (printOnly) { if (good) console.log(line); continue; }
  if (good) ok += 1;
  else { fail += 1; console.log(`  FAIL [${mode}] ${tool}: ${value.replace(/\n/g, '⏎').slice(0, 160)}${blocked ? `\n       причина: ${reason.slice(0, 120)}` : ''}`); }
}
if (!printOnly) console.log(`ok=${ok} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
