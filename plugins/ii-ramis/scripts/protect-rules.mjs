// Защита самой защиты: настройки Claude Code, папка плагина и конфиг ИИ Рамис не должны меняться через Claude.
// Правило «запрет по умолчанию»: защищённое место можно только читать простыми читающими командами.
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { realpathNearest, expandBraces } from './lib.mjs';
import { verbName, commandIndex } from './shell-parse.mjs';

export const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOME = os.homedir();
const DATA_DIR = process.env.IIRAMIS_HOME || path.join(HOME, '.ii-ramis');
const STUDENT_ONLY = 'выключить защиту может только ученик сам в настройках';
const REASON = `изменение настроек Claude Code, папки плагина или конфига ИИ Рамис: ${STUDENT_ONLY}`;

const PROTECTED_PATTERNS = [/\.claude[/\\]settings/i, /\.claude[/\\]plugins(?=$|[/\\\s'"*])/i, /\.ii-ramis[/\\]config\.json/i];
const PROTECTED_DIRS = [PLUGIN_ROOT, path.join(HOME, '.claude'), DATA_DIR, path.join(HOME, '.ii-ramis')];
const READ_VERBS = new Set([
  'cat', 'less', 'more', 'head', 'tail', 'grep', 'egrep', 'rg', 'ls', 'dir', 'stat', 'test', '[', '[[', 'wc', 'file', 'diff',
  'jq', 'type', 'get-content', 'gc', 'select-string', 'sls', 'test-path', 'get-childitem', 'gci', 'get-item', 'gi',
]);
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
const REDIRECT = /^\d*>>?\|?/;
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

// Принцип: каталоги ~/.claude, ~/.ii-ramis и папка плагина защищены целиком, плюс settings*.json в любом проекте.
function matchesProtected(candidate) {
  const lower = candidate.toLowerCase();
  const dirs = [...PROTECTED_DIRS, realpathNearest(PLUGIN_ROOT)];
  if (dirs.some((dir) => insideOrEqual(lower, dir.toLowerCase()))) return true;
  return same(path.basename(path.dirname(candidate)), '.claude') && path.basename(candidate).toLowerCase().startsWith('settings');
}

// Шаблон со звёздочкой, который мог бы раскрыться внутри защищённой папки (~/.claude/*, ~/.cl*/settings.json).
function globProtected(text, cwd) {
  const prefix = text.slice(0, text.search(/[*?[]/));
  const resolved = path.resolve(cwd, prefix || '.');
  return PROTECTED_DIRS.some((dir) => dir.toLowerCase().startsWith(resolved.toLowerCase()) || insideOrEqual(resolved, dir));
}

export function isProtectedPath(raw, cwd) {
  const text = expand(String(raw));
  if (/\{[^{}]*\.\.[^{}]*\}/.test(text)) return true; // {1..3}: не раскрываем, значит считаем защищённым
  const variants = expandBraces(text);
  if (variants.length > 1 || variants[0] !== text) return variants.some((variant) => isProtectedPath(variant, cwd));
  if (text.startsWith('-')) {
    const eq = text.indexOf('='); // --output=путь
    return eq > 0 ? isProtectedPath(text.slice(eq + 1), cwd) : false;
  }
  if (PROTECTED_PATTERNS.some((pattern) => pattern.test(text))) return true;
  if (/[*?[]/.test(text)) return globProtected(text, cwd);
  if (/[$`]/.test(text)) return false;
  const resolved = path.resolve(cwd, text);
  return matchesProtected(resolved) || matchesProtected(realpathNearest(resolved));
}

function isProtectedDir(raw, cwd) {
  const text = expand(String(raw));
  if (/[$`*?[\]{}]/.test(text)) return true; // неразрешимая цель cd считается защищённой
  const resolved = path.resolve(cwd, text);
  return [resolved, realpathNearest(resolved)].some((c) =>
    PROTECTED_DIRS.some((dir) => insideOrEqual(c.toLowerCase(), dir.toLowerCase())) || /(^|[/\\])\.claude([/\\]|$)/i.test(c));
}

function resolvesToScript(token, names, cwd) {
  const expanded = expand(token);
  if (!path.isAbsolute(expanded)) return false;
  const resolved = path.resolve(cwd, expanded);
  return path.dirname(resolved) === path.join(PLUGIN_ROOT, 'scripts') && names.has(path.basename(resolved));
}

function isConfigSet(args) {
  return args.length === 3 && args[0] === 'set' && (
    (args[1] === 'lesson' && /^\d{1,2}$/.test(args[2])) || (args[1] === 'autosave' && /^(true|false)$/.test(args[2])));
}

function isPluginCommand(tokens) {
  const claude = tokens.findIndex((t) => verbName(t) === 'claude');
  if (tokens.some((t) => /^\/plugins?$/.test(t))) return true;
  if (claude === -1 || !tokens.slice(claude + 1).some((t) => /^plugins?$/.test(t))) return false;
  return tokens.some((t) => /ii-ramis/i.test(t)) && tokens.some((t) => /^(disable|uninstall|remove|delete)$/.test(t));
}

// Свой скрипт: команда начинается прямо с него (без env-присваиваний и обёрток), других упоминаний защищённых мест нет.
function isOwnScriptCall(cmd, mentioned, cwd) {
  const { tokens } = cmd;
  if (mentioned.length !== 1 || cmd.pipedInto || cmd.prev || cmd.inSubstitution) return false;
  const at = mentioned[0];
  const runner = verbName(tokens[0]);
  if (resolvesToScript(tokens[at], new Set(['config.mjs']), cwd)) {
    return runner === 'node' && at === 1 && isConfigSet(tokens.slice(2));
  }
  if (!resolvesToScript(tokens[at], DIAGNOSE_SCRIPTS, cwd)) return false;
  const args = tokens.slice(at + 1);
  const launcher = at === 0 || (RUNNERS.has(runner) && tokens.slice(1, at).every((t) => t.startsWith('-')));
  return launcher && args.length <= 1;
}

function readOnlyUse(tokens, first) {
  const name = verbName(tokens[first]);
  if (tokens.slice(first + 1).some((t) => OUTPUT_OR_EXEC_FLAGS.test(t))) return false;
  if (READ_VERBS.has(name)) return true;
  if (name !== 'git') return false;
  const rest = tokens.slice(first + 1);
  const flagsAreSafe = rest.every((t) => !t.startsWith('-') || SAFE_GIT_FLAGS.has(t) || /^-\d+$/.test(t));
  return flagsAreSafe && READ_ONLY_GIT.has(rest.find((t) => !t.startsWith('-')));
}

function isRedirectTarget(tokens, index) {
  const attached = REDIRECT.test(tokens[index]) && tokens[index].length > tokens[index].match(REDIRECT)[0].length;
  return attached || (index > 0 && /^\d*>>?\|?$/.test(tokens[index - 1]));
}

// Путь для записи собран из переменной: проверить нельзя, значит запрещено.
function hasUnresolvableWriteTarget(tokens, first) {
  const redirectToVariable = tokens.some((t, i) => isRedirectTarget(tokens, i) && /[$`]/.test(stripRedirect(t)));
  const writer = first !== -1 && WRITE_VERBS.has(verbName(tokens[first])) && tokens.slice(first + 1).some((t) => /[$`]/.test(t));
  return redirectToVariable || writer;
}

export function checkProtectedShell(commands, cwd) {
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
    if (isCd) continue; // сам cd безвреден: что делать дальше в этой папке, решает movesIntoProtected
    const mentioned = tokens
      .map((token, index) => (!cmd.consumed.has(index) && isProtectedPath(stripRedirect(token), cwd) ? index : -1))
      .filter((index) => index !== -1);
    const redirected = tokens.some((t, i) => isRedirectTarget(tokens, i));
    if (movesIntoProtected && !isCd && (first === -1 || !readOnlyUse(tokens, first) || redirected)) return REASON;
    if (mentioned.length === 0) continue;
    const redirectedIntoProtected = mentioned.some((i) => isRedirectTarget(tokens, i));
    if (!redirectedIntoProtected && isOwnScriptCall(cmd, mentioned, cwd)) continue;
    if (first !== -1 && !redirectedIntoProtected && !cmd.pipedInto && readOnlyUse(tokens, first)) continue;
    return REASON;
  }
  return null;
}

export function checkProtectedFileWrite(rawPath, cwd) {
  return isProtectedPath(rawPath, cwd) ? REASON : null;
}
