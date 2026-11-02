// Решение охранника: вернуть причину отказа или null. Отдельный модуль, чтобы поломка импорта не обходила защиту (см. guard.mjs).
import os from 'node:os';
import { tokenMentionsSecret, tokenMentionsShellStartup, tokenNamesSecret } from './lib.mjs';
import { parseShell, verbName, commandIndex } from './shell-parse.mjs';
import { checkDeletion } from './delete-rules.mjs';
import {
  checkSecrets, checkEnvironmentDump, checkGit, checkPipeToShell, checkSelfApproval,
  checkUnverifiableReads, checkTextPatterns, checkInlineCode, checkCurlSecretExfil, checkRecursiveSecretSearch,
} from './guard-rules.mjs';
import { checkProtectedShell, checkProtectedFileWrite, checkDynamicWriteTargets, mentionsPluginConfig, PLUGIN_ROOT } from './protect-rules.mjs';
import { checkWebFetch } from './web-rules.mjs';
import { checkConsentCommand, nameMayBeSet, mcpAddNeedsConfirmation } from './consent-rules.mjs';
import { inlineLiteralVariables, neutralizeSafeSubstitutions } from './inline-vars.mjs';
import { checkInstallerLaunch, checkTerminalWrappers, checkAgentMarkerTampering } from './installer-rules.mjs';

const WRITE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

const FILE_TOOLS = new Set(['Read', 'NotebookRead', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);
const PATH_KEY = /path|file|dir|folder|uri|glob|pattern|source|destination|target/i;

export class Denied extends Error {}
// Не отказ, а вопрос ученику: охранник отвечает Claude Code «спросить» (permissionDecision: ask), ученик решает сам.
export class Ask extends Error {}

function stringsUnder(value, keyMatches, key = '', depth = 0, found = []) {
  if (depth > 6 || value === null || value === undefined) return found;
  if (typeof value === 'string') {
    if (keyMatches(key)) found.push(value);
  } else if (Array.isArray(value)) {
    value.forEach((item) => stringsUnder(item, keyMatches, key, depth + 1, found));
  } else if (typeof value === 'object') {
    Object.entries(value).forEach(([k, v]) => stringsUnder(v, keyMatches, k, depth + 1, found));
  }
  return found;
}

function pathValuesFor(toolName, toolInput) {
  if (toolName === 'Grep') return stringsUnder(toolInput, (k) => k === 'path' || k === 'glob');
  if (toolName === 'Glob') return stringsUnder(toolInput, (k) => k === 'path' || k === 'pattern');
  if (FILE_TOOLS.has(toolName)) return stringsUnder(toolInput, (k) => k === 'file_path' || k === 'notebook_path' || k === 'path');
  return stringsUnder(toolInput, (k) => PATH_KEY.test(k)); // mcp__*: любые поля, похожие на пути
}

// Известные переменные заменяем настоящим путём ДО разбора: иначе `cat "${CLAUDE_PLUGIN_ROOT}/…"`, `Get-Content $HOME\…` и запись
// в `$TMPDIR/…` выглядят как «путь из переменной» и блокируются, хотя куда они смотрят, мы знаем точно.
// Подставляем ТОЛЬКО в «чистой» команде: нет других $-переменных и подстановок, нет присваиваний и любых способов поменять переменную
// (export, declare, env, eval, read, Set-Item, SetEnvironmentVariable…), нет знака «=» (кроме --флаг=значение), нет source. Иначе
// команда идёт как есть, и действует прежняя строгость: переменная в пути = отказ. Подставленный текст дальше проходит ВСЕ правила.
const KNOWN_NAMES = 'HOME|USERPROFILE|CLAUDE_PLUGIN_ROOT|TMPDIR|TEMP|TMP|APPDATA|LOCALAPPDATA';
const VARIABLE_FORMS = [
  new RegExp(String.raw`\$\{(${KNOWN_NAMES})\}`, 'g'),
  new RegExp(String.raw`\$(${KNOWN_NAMES})(?![A-Za-z0-9_])`, 'g'),
  new RegExp(String.raw`\$\{?env:(${KNOWN_NAMES})\}?(?![A-Za-z0-9_])`, 'gi'),
];
const MENTIONS_KNOWN_NAME = new RegExp(String.raw`(?<![A-Za-z0-9_])(?:${KNOWN_NAMES})(?![A-Za-z0-9_])`, 'i');
const VARIABLE_CHANGERS = new RegExp(
  String.raw`(?<![A-Za-z0-9_-])(?:export|declare|typeset|local|readonly|env|eval|source|read|readarray|mapfile|getopts|let|unset|trap|exec|printf\s+-v|` +
  String.raw`set-item|si|set-variable|sv|new-variable|nv|clear-item|setx|setenvironmentvariable|invoke-expression|iex|invoke-command|icm)(?![A-Za-z0-9_-])`,
  'i',
);
// В каком кавычечном контексте стоит позиция: null (вне кавычек), 'single' или 'double'. Грубый разбор достаточен: значения, которые мы
// подставляем, не содержат кавычек, а в сомнительных случаях подстановки просто не будет (останется прежняя строгость).
function quoteStateAt(text, offset, toolName) {
  const escape = toolName === 'PowerShell' ? '`' : '\\';
  let state = null;
  for (let i = 0; i < offset; i += 1) {
    const ch = text[i];
    if (state === 'single') { if (ch === "'") state = null; continue; }
    if (ch === escape) { i += 1; continue; }
    if (ch === '"') state = state === 'double' ? null : state === null ? 'double' : state;
    else if (ch === "'" && state === null) state = 'single';
  }
  return state;
}

// Значение подставляем, только если оно не способно изменить разбор команды: никаких кавычек, $, `, ; & | ( ) < > * ? [ ] { } ! #.
// Пробелы допустимы лишь внутри двойных кавычек (там оболочка не режет слово по пробелам); вне кавычек, в одинарных кавычках
// и при любом другом значении переменная остаётся как есть, и срабатывает прежнее строгое правило «путь из переменной».
const SAFE_VALUE = /^[\p{L}\p{N} _.\-/\\:~+@,]+$/u;

function commandIsClean(command) {
  const withoutKnown = VARIABLE_FORMS.reduce((text, form) => text.replace(form, ''), command);
  if (/\$|`/.test(withoutKnown)) return false; // другие переменные и подстановки
  if (/(?:^|[^\w])env:/i.test(withoutKnown)) return false; // New-Item env:X, Remove-Item env:X: меняют окружение
  if (MENTIONS_KNOWN_NAME.test(withoutKnown)) return false; // имя встречается не как чтение: присваивание, read, for…
  if (VARIABLE_CHANGERS.test(withoutKnown)) return false;
  if (/=/.test(withoutKnown.replace(/--[\w-]+=/g, ''))) return false;
  return !/(^|[;&|(]\s*)\.\s/.test(withoutKnown); // «. файл» исполняет файл в этой же оболочке
}

// Значение берём только из настоящего окружения хука (process.env), без запасных os.homedir()/os.tmpdir(): если переменная в оболочке
// не задана, она раскроется в пустоту, и «безопасный» подставленный путь ввёл бы охранника в заблуждение. В PowerShell голые
// $TEMP, $TMPDIR, $USERPROFILE, $CLAUDE_PLUGIN_ROOT это не переменные окружения: подставляем только $HOME (автопеременная) и $env:ИМЯ.
function knownValue(name, toolName, viaEnvPrefix) {
  const key = String(name).toUpperCase();
  if (toolName === 'PowerShell' && key === 'HOME' && !viaEnvPrefix) return os.homedir();
  if (toolName === 'PowerShell' && !viaEnvPrefix) return null;
  if (toolName !== 'PowerShell' && viaEnvPrefix) return null;
  const value = process.env[toolName === 'PowerShell' ? key : String(name)];
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function expandKnownVariables(command, toolName) {
  if (!commandIsClean(command)) return command;
  let result = command;
  VARIABLE_FORMS.forEach((form, formIndex) => {
    const source = result;
    result = source.replace(form, (match, name, offset) => {
      const raw = knownValue(name, toolName, formIndex === 2);
      if (raw === null || !SAFE_VALUE.test(raw)) return match;
      const quote = quoteStateAt(source, offset, toolName);
      if (quote === 'single' || (/\s/.test(raw) && quote !== 'double')) return match;
      return toolName === 'PowerShell' ? raw : raw.replace(/\\/g, '/');
    });
  });
  return result;
}

// jq умеет печатать окружение (env, $ENV) со всеми токенами, читать программу и данные из файлов, подключать модули.
const JQ_FORBIDDEN = /(?:^|[^A-Za-z0-9_])(?:env|input_filename|import|include|modulemeta)(?![A-Za-z0-9_])|\$ENV/;
const JQ_FORBIDDEN_FLAGS = /^(?:-f|--from-file|-L|--rawfile|--slurpfile|--argfile|--jsonargs|--args)$|^-[A-Za-z]*[fL][A-Za-z]*$/;
// Интерактивные программы: Claude они ни к чему, а через `less +!команда`, `vi -c`, `man` запускают что угодно.
const INTERACTIVE_VERBS = new Set(['less', 'more', 'most', 'vi', 'vim', 'view', 'nvim', 'ex', 'ed', 'nano', 'pico', 'emacs', 'man', 'pager']);

// В PowerShell скриптблок внутри Select-Object/Sort-Object/Where-Object/ForEach-Object (`@{e={Remove-Item …}}`, `Sort-Object {iex …}`)
// выполняет любой код, а правила смотрят только на слова верхнего уровня.
const PS_BLOCK_VERBS = new Set([
  'select-object', 'select', 'sort-object', 'sort', 'group-object', 'group', 'measure-object', 'measure', 'where-object', 'where', '?',
  'foreach-object', 'foreach', '%', 'format-table', 'ft', 'format-list', 'fl', 'tee-object', 'tee',
]);

// Скриптблок PowerShell, где только свойства файла и сравнения (`{ $_.Name -like "*.md" }`): кода там нет. Любое другое слово, вызов, конвейер, присваивание: блок остаётся закрытым.
const PS_PROPERTIES = new Set(['name', 'fullname', 'length', 'extension', 'basename', 'lastwritetime', 'creationtime', 'count', 'directory', 'directoryname', 'mode', 'psiscontainer', 'parent']);
const PS_OPERATORS = /^-(?:i|c)?(?:like|notlike|eq|ne|gt|lt|ge|le|match|notmatch|contains|notcontains|in|notin|and|or|not)$/i;
function psBlockIsHarmless(block) {
  const body = block.slice(1, -1).replace(/'[^']*'/g, 'S').replace(/"[^"$`]*"/g, 'S');
  if (/[|;&=<>@`]|\w\s*\(/.test(body.replace(/-(?:eq|ne)\b/gi, ''))) return false;
  return body.split(/[\s(),!]+/).filter(Boolean).every((token) => {
    if (token === 'S' || /^-?\d+(?:\.\d+)?$/.test(token) || PS_OPERATORS.test(token) || /^\$(?:true|false|null)$/i.test(token)) return true;
    const chain = token.match(/^\$(?:_|psitem)((?:\.\w+)*)$/i);
    return chain !== null && chain[1].split('.').filter(Boolean).every((name) => PS_PROPERTIES.has(name.toLowerCase()));
  });
}
function psBlocksAreHarmless(command) {
  const blocks = command.match(/\{[^{}]*\}/g);
  if (!blocks || /[{}]/.test(command.replace(/\{[^{}]*\}/g, ''))) return false;
  return blocks.every(psBlockIsHarmless);
}

function checkJqAndInteractive(commands, rawCommand = '') {
  for (const { tokens, mode } of commands) {
    const first = commandIndex(tokens);
    if (mode === 'ps' && first !== -1 && PS_BLOCK_VERBS.has(verbName(tokens[first])) && tokens.slice(first + 1).some((t) => /[{}]/.test(t)) && !psBlocksAreHarmless(rawCommand)) {
      return 'скриптблок { … } внутри конвейера PowerShell: внутри него выполняется любой код, которого защита не видит';
    }
    const start = commandIndex(tokens);
    if (start === -1) continue;
    const name = verbName(tokens[start]);
    if (INTERACTIVE_VERBS.has(name)) return `интерактивная программа ${name}: через неё запускают любые команды (less +!…, vi -c …), Claude она не нужна`;
    if (name === 'jq' && tokens.slice(start + 1).some((t) => JQ_FORBIDDEN_FLAGS.test(t) || JQ_FORBIDDEN.test(t))) {
      return 'jq с env, $ENV, чтением программы или данных из файла, подключением модулей: так выводят окружение с токенами и запускают чужое';
    }
  }
  return null;
}

// sudo/su/doas и права администратора: любые установки и правки системы ученик делает сам; настройку через переменную CLAUDE_CONFIG_DIR тоже.
// Форматирование и стирание дисков.
const DISK_VERBS = new Set(['format', 'mkfs', 'format-volume', 'clear-disk', 'remove-partition', 'initialize-disk', 'diskpart', 'fdisk', 'gdisk', 'parted', 'wipefs', 'newfs', 'newfs_hfs', 'newfs_apfs']);
function checkDiskDestruction(commands) {
  for (const { tokens } of commands) {
    const at = commandIndex(tokens);
    if (at === -1) continue;
    const name = verbName(tokens[at]);
    const args = tokens.slice(at + 1);
    if (DISK_VERBS.has(name) || /^mkfs\./.test(name)) return 'форматирование или стирание диска';
    if (name === 'diskutil' && args.some((a) => /^(erase\w*|partition\w*|reformat|zero\w*|secureerase|apfs|corestorage)$/i.test(a))) return 'diskutil стирает или переразмечает диск';
    if (name === 'dd' && args.some((a) => /^of=\/dev\//.test(a))) return 'dd пишет прямо на диск';
    if (tokens.some((t) => /^\/dev\/(r?disk|sd|nvme|hd)/.test(t)) && ['cat', 'cp', 'tee', 'mv'].includes(name)) return 'запись прямо на диск';
  }
  return null;
}

const PRIVILEGE_VERBS = new Set(['sudo', 'doas', 'pkexec', 'su', 'runas', 'gsudo']);
function checkPrivilegeAndConfigDir(commands, command) {
  for (const { tokens } of commands) {
    const at = commandIndex(tokens);
    const lead = at === -1 ? tokens : tokens.slice(0, at + 1);
    if (lead.some((t) => PRIVILEGE_VERBS.has(verbName(t)))) return 'sudo, su или запуск от имени администратора: системные установки и права ученик выполняет сам в обычном Терминале';
    if (tokens.some((t, i) => verbName(t) === 'start-process' && tokens.slice(i + 1).some((a) => /^runas$/i.test(a)))) return 'запуск от имени администратора (Start-Process -Verb RunAs)';
  }
  return /CLAUDE_CONFIG_DIR\s*=|env:CLAUDE_CONFIG_DIR\s*=|setx\s+CLAUDE_CONFIG_DIR|SetEnvironmentVariable\(\s*['"]CLAUDE_CONFIG_DIR/i.test(command)
    ? 'смена CLAUDE_CONFIG_DIR: так подменяют папку настроек Claude Code вместе с защитой' : null;
}

function shellReason(toolName, toolInput, cwd) {
  const originalCommand = toolInput.command;
  if (originalCommand === undefined || originalCommand === '') return null;
  if (typeof originalCommand !== 'string') throw new Denied('команда в непонятном формате');
  const mode = toolName === 'PowerShell' ? 'ps' : 'bash';
  // 1) $(date), $(lsof -ti :3000): безобидные подстановки; 2) присваивания с буквальным значением; 3) известные переменные ($HOME, $TMPDIR…)
  const neutral = neutralizeSafeSubstitutions(originalCommand, mode, cwd);
  const inlined = inlineLiteralVariables(neutral, mode, (value) => expandKnownVariables(value, toolName));
  const command = expandKnownVariables(inlined, toolName);
  const selfApproval = checkSelfApproval(command) || checkSelfApproval(originalCommand);
  if (selfApproval) return selfApproval;

  const parsed = parseShell(command, mode);
  const reason =
    checkPrivilegeAndConfigDir(parsed.commands, command) ||
    checkDiskDestruction(parsed.commands) ||
    checkInstallerLaunch(parsed.commands) ||
    checkTerminalWrappers(parsed.commands) ||
    checkAgentMarkerTampering(parsed.commands) ||
    checkConsentCommand(parsed.commands, command) ||
    checkProtectedShell(parsed.commands, cwd, { nameAllowed: nameMayBeSet }) ||
    checkDynamicWriteTargets(parsed.commands) ||
    checkSecrets(parsed.commands) ||
    checkEnvironmentDump(parsed.commands) ||
    checkInlineCode(parsed.commands) ||
    checkCurlSecretExfil(parsed.commands) ||
    checkRecursiveSecretSearch(parsed.commands) ||
    checkDeletion(parsed.commands, cwd) ||
    checkGit(parsed.commands) ||
    checkPipeToShell(parsed.commands) ||
    checkUnverifiableReads(parsed.commands) ||
    checkJqAndInteractive(parsed.commands, command) ||
    checkTextPatterns(command);
  if (reason) return reason;
  if (parsed.problems.length > 0) return `не смог разобрать команду (${parsed.problems[0]})`;
  if (mcpAddNeedsConfirmation(command)) throw new Ask('claude mcp add с незнакомым коннектором или своей командой: подключает программу, которая будет работать на твоём компьютере. Разрешить?');
  return null;
}

export function decide(input) {
  const toolName = String(input.tool_name || '');
  const toolInput = input.tool_input && typeof input.tool_input === 'object' ? input.tool_input : {};
  const cwd = typeof input.cwd === 'string' && input.cwd ? input.cwd : process.cwd();
  if (!toolName) throw new Denied('не понял, какой инструмент вызван');

  if (SHELL_TOOLS.has(toolName)) return shellReason(toolName, toolInput, cwd);
  if (toolName === 'WebFetch') return checkWebFetch(toolInput);

  for (const value of pathValuesFor(toolName, toolInput)) {
    const selfApproval = checkSelfApproval(value);
    if (selfApproval) return selfApproval;
    if ((WRITE_TOOLS.has(toolName) || toolName.startsWith('mcp__')) && checkProtectedFileWrite(value, cwd)) {
      return checkProtectedFileWrite(value, cwd);
    }
    if (toolName !== 'Glob' && mentionsPluginConfig(value, cwd, { ancestors: toolName === 'Grep' })) return 'прямое чтение config.json плагина (там идентификатор установки): используй config.mjs get <ключ> или show';
    // Glob только перечисляет имена файлов: шаблон `*.json` не открывает credentials.json. Явное имя секретного файла по-прежнему запрещено.
    const secretCheck = toolName === 'Glob' ? tokenNamesSecret : tokenMentionsSecret;
    if (secretCheck(value)) return 'обращение к файлу с ключами или паролями (.env, .pem, id_rsa и т.п.)';
    if (tokenMentionsShellStartup(value)) return 'файл запуска оболочки или история команд (~/.zshrc, ~/.bashrc, ~/.zsh_history и т.п.): через Claude их не читают и не правят';
  }
  return null;
}
