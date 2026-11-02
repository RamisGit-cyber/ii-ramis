// Защита самой защиты: настройки Claude Code, папка плагина и конфиг ИИ Рамис не должны меняться через Claude.
// Правило «запрет по умолчанию»: защищённое место можно только читать простыми читающими командами.
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { realpathNearest, expandBraces } from './lib.mjs';
import { verbName, commandIndex, isAssignment } from './shell-parse.mjs';

export const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOME = os.homedir();
const DATA_DIR = process.env.IIRAMIS_HOME || path.join(HOME, '.ii-ramis');
const STUDENT_ONLY = 'выключить защиту может только ученик сам в настройках';
const REASON = `изменение настроек Claude Code, папки плагина или конфига ИИ Рамис: ${STUDENT_ONLY}`;

// Защищено только то, что отключает или подменяет защиту. Память, skills, agents, commands, CLAUDE.md и данные claude-mem
// (они лежат в ~/.claude-mem) ученику и Claude писать можно.
// Шаблоны привязаны к началу сегмента пути: `foo.claude/settings.json` и `/tmp/claude-501/settings.json` не защищены, а `.claude/settings.json`
// в любой папке (в том числе проектной) и точное имя `.claude.json` защищены.
const SEG = String.raw`(?:^|[/\\])`;
const PROTECTED_PATTERNS = [
  new RegExp(SEG + String.raw`\.claude[/\\]settings`, 'i'),
  new RegExp(SEG + String.raw`\.claude[/\\](?:plugins|hooks)(?=$|[/\\\s'"*])`, 'i'),
  new RegExp(SEG + String.raw`\.claude\.json(?=$|[\s'"])`, 'i'),
  new RegExp(SEG + String.raw`\.ii-ramis[/\\]config\.json`, 'i'),
  new RegExp(SEG + String.raw`(?:\.claude|ClaudeCode|claude-code)[/\\]managed-settings`, 'i'),
];
const CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR ? path.resolve(process.env.CLAUDE_CONFIG_DIR) : null;
// Системные (managed) настройки Claude Code: тоже отключают защиту.
const MANAGED_DIRS = [
  '/etc/claude-code', '/Library/Application Support/ClaudeCode', path.join(HOME, 'Library', 'Application Support', 'ClaudeCode'),
  'C:\\ProgramData\\ClaudeCode', 'C:\\Program Files\\ClaudeCode',
];
// ~/.ii-ramis защищена целиком (там же лежит установленный node), кроме файлов, которые пишут сами хуки.
const PROTECTED_DIRS = [
  PLUGIN_ROOT, path.join(HOME, '.claude', 'plugins'), path.join(HOME, '.claude', 'hooks'), DATA_DIR, path.join(HOME, '.ii-ramis'),
  ...MANAGED_DIRS,
  ...(CONFIG_DIR ? [path.join(CONFIG_DIR, 'plugins'), path.join(CONFIG_DIR, 'hooks')] : []),
];
// recap.txt: короткий пересказ сессии, его пишет ИИ Рамис (Write), а хук session-end чистит и отправляет.
const HOOK_WRITTEN_FILES = [DATA_DIR, path.join(HOME, '.ii-ramis')].flatMap((dir) => [path.join(dir, 'state.json'), path.join(dir, 'progress.jsonl'), path.join(dir, 'recap.txt')]);
const PROTECTED_FILES = [
  path.join(HOME, '.claude.json'), path.join(DATA_DIR, 'config.json'), path.join(HOME, '.ii-ramis', 'config.json'),
  path.join(HOME, '.claude', 'settings.json'), path.join(HOME, '.claude', 'settings.local.json'), path.join(HOME, '.claude', 'managed-settings.json'),
  ...(CONFIG_DIR ? ['settings.json', 'settings.local.json', 'managed-settings.json', '.claude.json'].map((name) => path.join(CONFIG_DIR, name)) : []),
];
// Папки, куда нельзя «войти» через cd и потом писать по относительным путям.
const GUARDED_WORKING_DIRS = [path.join(HOME, '.claude'), DATA_DIR, path.join(HOME, '.ii-ramis'), ...(CONFIG_DIR ? [CONFIG_DIR] : [])];
const READ_VERBS = new Set([
  'cat', 'head', 'tail', 'grep', 'egrep', 'rg', 'ls', 'dir', 'stat', 'test', '[', '[[', 'wc', 'file', 'diff',
  'jq', 'find', 'tree', 'type', 'get-content', 'gc', 'select-string', 'sls', 'test-path', 'get-childitem', 'gci', 'get-item', 'gi',
]);
// find только ищет и печатает имена, пока нет действий над найденным и записи в файл.
const FIND_UNSAFE = new Set(['-exec', '-execdir', '-ok', '-okdir', '-delete', '-fprint', '-fprint0', '-fprintf', '-fls']);
const READ_ONLY_GIT = new Set(['status', 'diff', 'log', 'show', 'ls-files', 'check-ignore']);
const SAFE_GIT_FLAGS = new Set([
  '--', '-n', '-s', '-b', '-p', '-a', '--stat', '--shortstat', '--numstat', '--summary', '--name-only', '--name-status',
  '--oneline', '--short', '--porcelain', '--cached', '--staged', '--no-color', '--graph', '--decorate', '--patch', '--all', '--no-pager',
]);
const OUTPUT_OR_EXEC_FLAGS = /^(--output|-o|--pre|--exec|--ext-diff|--textconv|--open-files-in-pager)(=|$)/;
const WRITE_VERBS = new Set([
  'cp', 'mv', 'tee', 'rm', 'sed', 'ln', 'install', 'dd', 'truncate', 'touch', 'copy', 'move', 'del', 'erase', 'rd', 'rmdir',
  'set-content', 'out-file', 'add-content', 'copy-item', 'move-item', 'remove-item', 'new-item', 'clear-content', 'ri', 'ni',
]);
const CD_VERBS = new Set(['cd', 'pushd', 'set-location', 'sl', 'chdir']);
const RUNNERS = new Set(['bash', 'sh', 'node', 'pwsh', 'powershell']);
const REDIRECT = /^(?:\d*|&)>>?[|&]?/;
// Только чтение: диагностика. Установщики и setup-settings через Claude не запускаются вообще.
const DIAGNOSE_SCRIPTS = new Set(['diagnose.sh', 'diagnose.ps1']);

function expand(token) {
  return token
    .replace(/\$\{?CLAUDE_PLUGIN_ROOT\}?/g, PLUGIN_ROOT)
    .replace(/^(\$\{?HOME\}?|~)(?=$|[/\\])/, HOME);
}

function stripRedirect(token) {
  const match = token.match(REDIRECT);
  return match && match[0].length < token.length ? token.slice(match[0].length) : token;
}

const same = (a, b) => a.toLowerCase() === b.toLowerCase();
function insideOrEqual(child, parent) {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

// Папки, внутри которых прямо лежат защищённые файлы и папки: класть в них новые файлы нельзя (cp settings.json ~/.claude/).
const CONTAINER_DIRS = [path.join(HOME, '.claude'), DATA_DIR, path.join(HOME, '.ii-ramis'), ...(CONFIG_DIR ? [CONFIG_DIR] : [])];

// Что именно защищено: 'inside' (само защищённое место или что-то внутри), 'container' (папка, где оно лежит прямо),
// 'ancestor' (папка выше: ~, Library/Application Support/Claude, /private/var/folders/…/T). Выше-папки опасны только удалением, переносом и chmod.
function kindOf(candidate) {
  const lower = candidate.toLowerCase();
  if (HOOK_WRITTEN_FILES.some((file) => same(candidate, file))) return null;
  const dirs = [...PROTECTED_DIRS, realpathNearest(PLUGIN_ROOT)];
  if (dirs.some((dir) => insideOrEqual(lower, dir.toLowerCase()))) return 'inside';
  if (PROTECTED_FILES.some((file) => same(candidate, file))) return 'inside';
  if (same(path.basename(path.dirname(candidate)), '.claude') && path.basename(candidate).toLowerCase().startsWith('settings')) return 'inside';
  if (CONTAINER_DIRS.some((dir) => same(candidate, dir))) return 'container';
  // и наоборот: путь, внутри которого лежит защищённое (~, ~/.claude, /): rm, mv, chmod задели бы и его
  if ([...dirs, ...PROTECTED_FILES].some((target) => insideOrEqual(target.toLowerCase(), lower))) return 'ancestor';
  return null;
}

const KIND_RANK = { inside: 3, container: 2, ancestor: 1 };
const strongest = (a, b) => ((KIND_RANK[a] || 0) >= (KIND_RANK[b] || 0) ? a : b);

// Шаблон со звёздочкой: раскрываем честно (по полному пути), а не «любой префикс считаем защищённым».
// Так `~/Library/Application Support/Claude/*/outputs/*.pdf` не путается с `~/.claude/*`.
function globKind(text, cwd) {
  const absolute = path.resolve(cwd, text);
  const regex = fullPathGlob(absolute.replace(/\\/g, '/'));
  const patternSegments = absolute.replace(/\\/g, '/').split('/');
  const hasDeepStar = absolute.includes('**');
  const matches = (candidate) => {
    const normal = candidate.replace(/\\/g, '/');
    if (!regex.test(normal)) return false;
    if (hasDeepStar) return true;
    const parts = normal.split('/');
    // `*` и `?` в начале имени не раскрываются в имена с точкой (.claude): так ведёт себя оболочка
    return !patternSegments.some((segment, i) => /^[*?[]/.test(segment) && (parts[i] || '').startsWith('.'));
  };
  const targets = [...PROTECTED_DIRS, ...PROTECTED_FILES, realpathNearest(PLUGIN_ROOT)];
  let kind = null;
  for (const target of targets) {
    if ([target, `${target}/x`, `${target}/x/x`].some(matches)) return 'inside';
    for (let dir = path.dirname(target); dir !== path.dirname(dir); dir = path.dirname(dir)) {
      if (matches(dir)) kind = strongest(kind, CONTAINER_DIRS.some((c) => same(c, dir)) ? 'container' : 'ancestor');
    }
  }
  return kind;
}

export function protectionKind(raw, cwd) {
  const text = expand(String(raw));
  if (/\{[^{}]*\.\.[^{}]*\}/.test(text)) return 'inside'; // {1..3}: не раскрываем, значит считаем защищённым
  const variants = expandBraces(text);
  if (variants.length >= 50) return 'inside'; // упёрлись в лимит раскрытия скобок: не проверили всё, значит защищено
  if (variants.length > 1 || variants[0] !== text) return variants.reduce((kind, variant) => strongest(kind, protectionKind(variant, cwd)), null);
  if (text.startsWith('-')) {
    const eq = text.indexOf('='); // --output=путь
    return eq > 0 ? protectionKind(text.slice(eq + 1), cwd) : null;
  }
  if (PROTECTED_PATTERNS.some((pattern) => pattern.test(text))) return 'inside';
  if (/[*?[]/.test(text)) return globKind(text, cwd);
  if (/[$`]/.test(text)) return null;
  const resolved = path.resolve(cwd, text);
  return strongest(kindOf(resolved), kindOf(realpathNearest(resolved)));
}

export function isProtectedPath(raw, cwd) {
  return protectionKind(raw, cwd) !== null;
}

function isProtectedDir(raw, cwd) {
  const text = expand(String(raw));
  if (/[$`*?[\]{}]/.test(text)) return true; // неразрешимая цель cd считается защищённой
  const resolved = path.resolve(cwd, text);
  return [resolved, realpathNearest(resolved)].some((c) =>
    PROTECTED_DIRS.some((dir) => insideOrEqual(c.toLowerCase(), dir.toLowerCase())) ||
    GUARDED_WORKING_DIRS.some((dir) => same(c, dir)) || same(path.basename(c), '.claude'));
}

function resolvesToScript(token, names, cwd) {
  const expanded = expand(token);
  if (!path.isAbsolute(expanded)) return false;
  const resolved = path.resolve(cwd, expanded);
  // регистр и «настоящий» путь (симлинк, диск C: и c:) не должны ломать узнавание своего скрипта
  const scriptsDirs = [path.join(PLUGIN_ROOT, 'scripts'), path.join(realpathNearest(PLUGIN_ROOT), 'scripts')];
  const dirs = [path.dirname(resolved), path.dirname(realpathNearest(resolved))];
  return dirs.some((dir) => scriptsDirs.some((scripts) => same(dir, scripts))) && names.has(path.basename(resolved));
}

// consent: { nameAllowed(): boolean }. share=true Claude не включает вообще: это делает хук UserPromptSubmit по коду «да <код>» (consent-rules.mjs).
function isConfigSet(args, consent = {}) {
  return args.length === 3 && args[0] === 'set' && (
    (args[1] === 'lesson' && /^\d{1,2}$/.test(args[2])) || (args[1] === 'autosave' && /^(true|false)$/.test(args[2])) ||
    (args[1] === 'checked' && /^(true|false)$/.test(args[2])) ||
    (args[1] === 'share' && args[2] === 'false') || // выключить отправку можно всегда
    (args[1] === 'student_name' && /^[\p{L}\p{N} ._-]{1,40}$/u.test(args[2]) && !/\S{21,}|sk-|ghp_|eyJ/.test(args[2]) && consent.nameAllowed?.() === true));
}

// Чтение конфига: get <ключ> и show ничего не меняют (show прячет идентификатор установки). Записать можно только через isConfigSet.
function isConfigRead(args) {
  return (args.length === 1 && args[0] === 'show') ||
    (args.length === 2 && args[0] === 'get' && /^[a-z_]{1,30}$/.test(args[1]) && !['student_id', 'install_id'].includes(args[1]));
}

// Форма ключей (key-form.mjs): принимает только имена переменных, папку проекта и название окна. Значения ключей в команду
// не попадают: сама форма их не принимает, а охранник пропускает только эти флаги и только в таком виде.
const KEY_FORM_NAMES = /^[A-Z][A-Z0-9_]{0,63}(,[A-Z][A-Z0-9_]{0,63}){0,19}$/;
const KEY_FORM_TITLE = /^[\p{L}\p{N} ._,:()«»-]{1,60}$/u;
const KEY_FORM_UNSAFE_PATH = /[$`*?[\]{}<>|;&"'\\]|^-/;
export function isKeyFormArgs(args) {
  const seen = new Set();
  for (let i = 0; i < args.length; i += 1) {
    const flag = args[i];
    if (seen.has(flag)) return false;
    seen.add(flag);
    if (flag === '--vercel') continue;
    const value = args[i + 1];
    i += 1;
    if (value === undefined) return false;
    if ((flag === '--vars' || flag === '--secret') && KEY_FORM_NAMES.test(value)) continue;
    if (flag === '--title' && KEY_FORM_TITLE.test(value)) continue;
    if (flag === '--project' && value.length > 0 && value.length < 400 && !KEY_FORM_UNSAFE_PATH.test(value)) continue;
    return false;
  }
  return seen.has('--project') && (seen.has('--vars') || seen.has('--secret'));
}

function isPluginCommand(tokens) {
  const claude = tokens.findIndex((t) => verbName(t) === 'claude');
  if (tokens.some((t) => /^\/plugins?$/.test(t))) return true;
  if (claude === -1 || !tokens.slice(claude + 1).some((t) => /^plugins?$/.test(t))) return false;
  return tokens.some((t) => /ii-ramis/i.test(t)) && tokens.some((t) => /^(disable|uninstall|remove|delete)$/.test(t));
}

// Свой скрипт: команда начинается прямо с него (без env-присваиваний и обёрток), других упоминаний защищённых мест нет.
function isOwnScriptCall(cmd, mentioned, cwd, consent) {
  const { tokens } = cmd;
  if (mentioned.length !== 1 || cmd.pipedInto || cmd.prev || cmd.inSubstitution) return false;
  const at = mentioned[0];
  const runner = verbName(tokens[0]);
  if (resolvesToScript(tokens[at], new Set(['config.mjs']), cwd)) {
    return runner === 'node' && at === 1 && (isConfigSet(tokens.slice(2), consent) || isConfigRead(tokens.slice(2)));
  }
  if (resolvesToScript(tokens[at], new Set(['key-form.mjs']), cwd)) {
    return runner === 'node' && at === 1 && isKeyFormArgs(tokens.slice(2));
  }
  if (!resolvesToScript(tokens[at], DIAGNOSE_SCRIPTS, cwd)) return false;
  const args = tokens.slice(at + 1);
  const launcher = at === 0 || (RUNNERS.has(runner) && tokens.slice(1, at).every((t) => t.startsWith('-')));
  return launcher && args.length <= 1;
}

// ---- config.json плагина: читать только через config.mjs get/show (там скрыты идентификаторы) ----
const CONFIG_FILES = [path.join(DATA_DIR, 'config.json'), path.join(HOME, '.ii-ramis', 'config.json')];
const CONFIG_REASON = 'прямое чтение config.json плагина (там идентификатор установки): используй node "${CLAUDE_PLUGIN_ROOT}/scripts/config.mjs" get <ключ> или show';
const METADATA_VERBS = new Set(['ls', 'dir', 'stat', 'test', '[', '[[', 'test-path', 'get-childitem', 'gci']);
const OUTPUT_ONLY_VERBS = new Set(['echo', 'printf', 'write-output', 'write-host']);
const RECURSIVE_SEARCHERS = new Set(['grep', 'egrep', 'fgrep', 'rg', 'ag', 'ack']);

function fullPathGlob(glob) {
  let source = '';
  for (let i = 0; i < glob.length; i += 1) {
    const ch = glob[i];
    if (ch === '*') { if (glob[i + 1] === '*') { source += '.*'; i += 1; } else source += '[^/\\\\]*'; }
    else if (ch === '?') source += '[^/\\\\]';
    else if (ch === '[' && glob.indexOf(']', i + 2) !== -1) { const close = glob.indexOf(']', i + 2); source += '[' + glob.slice(i + 1, close).replace(/^!/, '^').replace(/\\/g, '\\\\') + ']'; i = close; }
    else source += ch.replace(/[.+^${}()|\\[\]]/g, '\\$&');
  }
  try { return new RegExp(`^${source}$`, 'i'); } catch { return /^$/; }
}

// Путь указывает на config.json плагина (прямо, через шаблон, ../, симлинк). ancestors=true: и на папку, внутри которой он лежит.
export function mentionsPluginConfig(raw, cwd, { ancestors = false } = {}) {
  const text = expand(String(raw).replace(/^-[^=]*=/, ''));
  if (text.startsWith('-')) return false;
  return expandBraces(text.replace(/\\/g, '/')).some((variant) => { // обратные слэши Windows читаем как обычные
    if (/[$`]/.test(variant)) return false; // переменные разбирают другие правила
    const resolved = path.resolve(cwd, variant);
    if (/[*?[]/.test(variant)) return CONFIG_FILES.some((file) => fullPathGlob(resolved).test(file));
    const candidates = [resolved, realpathNearest(resolved)].map((c) => c.toLowerCase());
    return CONFIG_FILES.some((file) => {
      const targets = [file, realpathNearest(file)].map((c) => c.toLowerCase());
      return candidates.some((c) => targets.some((t) => c === t || (ancestors && insideOrEqual(t, c)) ));
    });
  });
}

// ---- запись через переменную: путь собран из присваивания или подстановки, значит проверить его нельзя ----
// Исключения только у явно читающих и «выводящих» команд. git, npm, pnpm, yarn, pip, gh, node, python сюда НЕ входят: у них есть
// флаги и подкоманды, пишущие по пути из аргумента (git clone URL $d/hooks, npm --prefix $d, pip install -t $d, gh release download -D $d).
const DYNAMIC_SAFE_VERBS = new Set([
  'cat', 'head', 'tail', 'grep', 'egrep', 'fgrep', 'rg', 'ls', 'dir', 'stat', 'test', '[', '[[', 'wc', 'file', 'diff', 'find', 'tree', 'jq',
  'cd', 'pushd', 'popd', 'pwd', 'echo', 'printf', 'true', 'false', 'exit', 'return', 'export', 'unset', 'read', 'local', 'declare', 'set',
  'which', 'type', 'sleep', 'date',
  // выполнение текста и запуск оболочек разбирают правила про скрипты из интернета и интерпретаторы, а не эта проверка
  'eval', 'source', '.', 'bash', 'sh', 'zsh', 'iex', 'invoke-expression', 'pwsh', 'powershell',
  'get-content', 'gc', 'get-childitem', 'gci', 'get-item', 'gi', 'select-string', 'sls', 'test-path', 'set-location', 'sl', 'cd',
  'write-output', 'write-host', 'resolve-path',
]);
// Текст сообщения (git commit -m "fix $(date)", gh pr create --body "$(cat <<EOF…)") путём записи не является.
const MESSAGE_FLAGS = new Set(['-m', '-am', '--message', '--body', '-b', '--title', '-t', '--notes', '-n', '--description']);
function withoutMessageValues(tokens) {
  const kept = [];
  for (let i = 0; i < tokens.length; i += 1) {
    if (MESSAGE_FLAGS.has(tokens[i])) { i += 1; continue; }
    if (/^--(message|body|title|notes|description)=/.test(tokens[i])) continue;
    kept.push(tokens[i]);
  }
  return kept;
}

export function checkDynamicWriteTargets(commands) {
  const dynamic = commands.some((cmd) =>
    cmd.inSubstitution || (cmd.subs && cmd.subs.length > 0) || cmd.tokens.some((t) => isAssignment(t) || /^\$[\w:]+=|^=$|`/.test(t)) ||
    ['for', 'while', 'read', 'declare', 'typeset', 'export', 'foreach'].includes(verbName(cmd.tokens[0] || '')));
  if (!dynamic) return null;
  for (const cmd of commands) {
    const first = commandIndex(cmd.tokens);
    if (first === -1 || DYNAMIC_SAFE_VERBS.has(verbName(cmd.tokens[first]))) continue;
    if (withoutMessageValues(cmd.tokens.slice(first + 1)).some((t) => /\$[A-Za-z_{(]|\$\(\)|`/.test(t))) {
      return 'команда пишет или меняет файл по пути из переменной или подстановки (a=…; sort -o $a, curl -o $a, chmod $a): не могу проверить, что это не защищённый файл';
    }
  }
  return null;
}

function readOnlyUse(tokens, first) {
  const name = verbName(tokens[first]);
  if (name === 'find') return !tokens.slice(first + 1).some((t) => FIND_UNSAFE.has(t.toLowerCase()));
  if (tokens.slice(first + 1).some((t) => OUTPUT_OR_EXEC_FLAGS.test(t))) return false;
  if (READ_VERBS.has(name)) return true;
  if (name !== 'git') return false;
  const rest = tokens.slice(first + 1);
  const flagsAreSafe = rest.every((t) => !t.startsWith('-') || SAFE_GIT_FLAGS.has(t) || /^-\d+$/.test(t));
  return flagsAreSafe && READ_ONLY_GIT.has(rest.find((t) => !t.startsWith('-')));
}

// Вывод читающей команды уходит только в фильтры, которые ничего не пишут и не запускают. У каждого фильтра разрешены только
// перечисленные флаги: sort -o, uniq с файлом, rg --hostname-bin, grep -f, jq, less, скриптблоки PowerShell сюда не входят.
const NUMBER = /^\+?\d+$/;
const allArgs = (args, ok) => args.every(ok);
function noPositionals(args, valued, flag) { // flag(arg) -> true для флага без значения; valued: флаги, за которыми идёт значение
  for (let i = 0; i < args.length; i += 1) {
    if (valued.test(args[i])) { i += 1; if (args[i] === undefined) return false; continue; }
    if (!flag.test(args[i])) return false;
  }
  return true;
}
const SINK_RULES = {
  head: (args) => allArgs(args, (a) => /^(-[nc]?\d+|-[nc]|\+?\d+|-q|-v|--lines=\d+|--bytes=\d+)$/.test(a)),
  wc: (args) => allArgs(args, (a) => /^-[lwcmL]+$/.test(a)),
  tr: () => true, // tr файлов не открывает
  cut: (args) => noPositionals(args, /^-[bcdf]$/, /^(-[bcdf]\S+|--complement|-s)$/),
  grep: (args) => {
    let patterns = 0;
    for (let i = 0; i < args.length; i += 1) {
      const arg = args[i];
      if (/^-[ivnclwxoqshEFaHIT]+$/.test(arg) || /^-[ABCm]\d+$/.test(arg) || /^--colou?r(=(never|auto|always))?$/.test(arg)) continue;
      if (/^-[ABCm]$/.test(arg) && /^\d+$/.test(args[i + 1] || '')) { i += 1; continue; }
      if (arg.startsWith('-')) return false; // -f файл, -r, -e и прочее
      patterns += 1;
    }
    return patterns === 1; // один шаблон, файлов нет: читает только вход
  },
  'select-string': (args) => {
    let patterns = 0;
    for (let i = 0; i < args.length; i += 1) {
      const arg = args[i].toLowerCase();
      if (/^-(simplematch|casesensitive|notmatch|quiet|allmatches)$/.test(arg)) continue;
      if (arg === '-pattern') { i += 1; patterns += 1; if (args[i] === undefined) return false; continue; }
      if (arg.startsWith('-')) return false;
      patterns += 1;
    }
    return patterns === 1;
  },
  'select-object': (args) => args.length === 2 && /^-(first|last|skip)$/i.test(args[0]) && /^\d+$/.test(args[1]),
  'measure-object': (args) => allArgs(args, (a) => /^-(line|word|character)$/i.test(a)),
  'out-string': (args) => args.length === 0,
};
SINK_RULES.tail = SINK_RULES.head;
SINK_RULES.egrep = SINK_RULES.grep;
SINK_RULES.fgrep = SINK_RULES.grep;
SINK_RULES.sls = SINK_RULES['select-string'];

function pipesOnlyIntoFilters(cmd, commands) {
  const sinks = commands.filter((other) => other.prev === cmd);
  if (sinks.length === 0) return false;
  return sinks.every((sink) => {
    const at = commandIndex(sink.tokens);
    if (at === -1 || sink.inSubstitution || at !== 0) return false;
    const rule = SINK_RULES[verbName(sink.tokens[at])];
    if (!rule) return false;
    // никаких перенаправлений, подстановок, скобок, скриптблоков и фоновых запусков
    if (sink.tokens.some((t) => REDIRECT.test(t) || /[`<>{}@&;]|\$/.test(t))) return false;
    if (!rule(sink.tokens.slice(at + 1))) return false;
    return !sink.pipedInto || pipesOnlyIntoFilters(sink, commands);
  });
}

// Относительное имя после `cd ~/.ii-ramis`: config.json или шаблон, который его накрывает.
function mentionsPluginConfigName(token) {
  const name = String(token).replace(/^\.[/\\]/, '');
  return /[*?[]/.test(name) ? fullPathGlob(name).test('config.json') : same(name, 'config.json');
}

function isRedirectTarget(tokens, index) {
  const attached = REDIRECT.test(tokens[index]) && tokens[index].length > tokens[index].match(REDIRECT)[0].length;
  return attached || (index > 0 && /^(?:\d*|&)>>?[|&]?$/.test(tokens[index - 1]));
}

// Путь для записи собран из переменной: проверить нельзя, значит запрещено.
function hasUnresolvableWriteTarget(tokens, first) {
  const redirectToVariable = tokens.some((t, i) => isRedirectTarget(tokens, i) && /[$`]/.test(stripRedirect(t)));
  const writer = first !== -1 && WRITE_VERBS.has(verbName(tokens[first])) && tokens.slice(first + 1).some((t) => /[$`]/.test(t));
  return redirectToVariable || writer;
}

// Папка ВЫШЕ защищённого (~, .../Application Support/Claude, /private/var/folders/.../T) как цель записи безобидна: soffice --outdir, pandoc -o, tar -C ~,
// mkdir, curl -o. Опасно только то, что сносит, переносит или меняет права на всю папку целиком.
const WHOLE_TREE_VERBS = new Set([
  'rm', 'rmdir', 'rd', 'del', 'erase', 'remove-item', 'ri', 'unlink', 'shred', 'chmod', 'chown', 'chgrp', 'chflags', 'ln', 'mklink', 'truncate', 'dd',
  'rsync', 'zip', '7z', '7za', 'sed', 'install', 'xargs', 'rename', 'icacls', 'attrib', 'set-acl', 'takeown',
]);
const MOVERS = new Set(['cp', 'mv', 'copy', 'move', 'copy-item', 'move-item', 'cpi', 'mi']);
const SENSITIVE_SOURCE_NAMES = /^(?:\.claude|\.claude\.json|\.ii-ramis|managed-settings\.json|settings(?:\.local)?\.json|plugins|hooks|config\.json)$/i;

function ancestorIsHarmless(kind, tokens, index, first, verb) {
  if (kind !== 'ancestor' || first === -1 || WHOLE_TREE_VERBS.has(verb)) return false;
  if (MOVERS.has(verb)) {
    const operands = tokens.map((t, i) => ({ t, i })).filter(({ t, i }) => i > first && !t.startsWith('-'));
    const last = operands[operands.length - 1];
    if (!last || last.i !== index) return false; // папка выше защищённого может быть только местом назначения
    // cp -r . ~ и cp -r x/. ~ вливают скрытые папки (.claude) в назначение
    return operands.slice(0, -1).every(({ t }) => !SENSITIVE_SOURCE_NAMES.test(path.basename(t.replace(/[/\\]+$/, ''))) && !/(^|[/\\])\.{1,2}[/\\]?$|[/\\]\.\*|^\.[*?[]/.test(t));
  }
  if (verb === 'tar' || verb === 'bsdtar') {
    const before = tokens[index - 1] || '';
    const extracting = tokens.some((t) => /^--extract$|^-[a-zA-Z]*x[a-zA-Z]*$|^[a-zA-Z]*x[a-zA-Z]*f?$/.test(t) && !t.includes('/'));
    return extracting && /^(?:-C|--directory)$/.test(before);
  }
  if (verb === 'unzip') return tokens[index - 1] === '-d';
  return true;
}

export function checkProtectedShell(commands, cwd, consent = {}) {
  const movesIntoProtected = commands.some((cmd) => {
    const at = cmd.tokens.findIndex((t) => CD_VERBS.has(verbName(t)));
    return at !== -1 && cmd.tokens.slice(at + 1).some((t) => !t.startsWith('-') && isProtectedDir(t, cwd));
  });
  for (const cmd of commands) {
    const { tokens } = cmd;
    if (isPluginCommand(tokens)) return `управление плагином через команду: ${STUDENT_ONLY}`;
    const first = commandIndex(tokens);
    if (hasUnresolvableWriteTarget(tokens, first)) return 'запись в путь из переменной: не могу проверить, что это не защищённый файл';
    const isCd = first !== -1 && CD_VERBS.has(verbName(tokens[first]));
    const verb = first === -1 ? '' : verbName(tokens[first]);
    // echo $HOME, Write-Host $env:USERPROFILE: команда только печатает текст, даже если он похож на защищённый путь (пока нет перенаправления)
    if (OUTPUT_ONLY_VERBS.has(verb) && !tokens.some((t, i) => /[<>]/.test(t) || REDIRECT.test(t) || isRedirectTarget(tokens, i))) continue;
    if (!METADATA_VERBS.has(verb) && !isCd) {
      const viaWorkingDir = movesIntoProtected && tokens.slice(first + 1).some((t) => !t.startsWith('-') && !/[/\\]/.test(t) && mentionsPluginConfigName(t));
      if (viaWorkingDir || tokens.some((t, i) => !cmd.consumed.has(i) && mentionsPluginConfig(stripRedirect(t), cwd))) return CONFIG_REASON;
      if (RECURSIVE_SEARCHERS.has(verb) && tokens.slice(first + 1).some((t, i) => !t.startsWith('-') && mentionsPluginConfig(t, cwd, { ancestors: true })) &&
        (verb === 'rg' || verb === 'ag' || verb === 'ack' || tokens.some((t) => /^-[a-zA-Z]*[rR]|^--(recursive|dereference-recursive)$/.test(t)))) return CONFIG_REASON;
    }
    const mentioned = tokens
      .map((token, index) => {
        if (cmd.consumed.has(index)) return -1;
        const kind = protectionKind(stripRedirect(token), cwd);
        return kind !== null && !ancestorIsHarmless(kind, tokens, index, first, verb) ? index : -1;
      })
      .filter((index) => index !== -1);
    if (isCd && !mentioned.some((i) => isRedirectTarget(tokens, i))) continue; // сам cd безвреден; перенаправление в защищённое файл — нет
    const redirected = tokens.some((t, i) => isRedirectTarget(tokens, i));
    if (movesIntoProtected && !isCd && (first === -1 || !readOnlyUse(tokens, first) || redirected)) return REASON;
    if (mentioned.length === 0) continue;
    const redirectedIntoProtected = mentioned.some((i) => isRedirectTarget(tokens, i));
    if (!redirectedIntoProtected && isOwnScriptCall(cmd, mentioned, cwd, consent)) continue;
    if (first !== -1 && !redirectedIntoProtected && (!cmd.pipedInto || pipesOnlyIntoFilters(cmd, commands)) && readOnlyUse(tokens, first)) continue;
    return REASON;
  }
  return null;
}

export function checkProtectedFileWrite(rawPath, cwd) {
  return isProtectedPath(rawPath, cwd) ? REASON : null;
}
