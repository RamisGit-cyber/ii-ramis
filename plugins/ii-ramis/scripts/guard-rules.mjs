// Правила охранника: ключи и пароли, git, скрипты из интернета, базы данных, переменные окружения.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tokenMentionsSecret, realpathNearest } from './lib.mjs';
import { verbName, commandIndex, isAssignment, FETCH_NAMES } from './shell-parse.mjs';

const TRUSTED_HOSTS = new Set([
  'claude.ai', 'bun.sh', 'astral.sh', 'brew.sh', 'deno.land', 'sh.rustup.rs', 'fnm.vercel.app',
]);
const RAW_GITHUB_HOST = 'raw.githubusercontent.com';
const RAW_GITHUB_PREFIXES = ['/RamisGit-cyber/', '/Homebrew/', '/nvm-sh/', '/thedotmack/'];

// Команды, которым можно упоминать секретный путь: они не читают содержимое.
const METADATA_VERBS = new Set([
  'echo', 'printf', 'write-output', 'write-host', 'test', '[', '[[', 'ls', 'dir', 'stat', 'touch', 'mkdir',
  'test-path', 'get-childitem', 'gci', 'get-item', 'gi', 'resolve-path', 'new-item', 'ni',
]);
const COPY_VERBS = new Set(['cp', 'copy', 'copy-item', 'cpi', 'mv', 'move', 'move-item', 'mi']);
const PATTERN_FIRST_VERBS = new Set(['grep', 'egrep', 'fgrep', 'rg', 'ag', 'sed', 'awk', 'gawk']);
const GIT_SAFE_SUBCOMMANDS = new Set(['check-ignore', 'ls-files', 'status']);
const TEXT_FLAGS = new Set(['-m', '-am', '--message', '--body', '-b', '--title', '-t']);

function gitSubcommand(args) {
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '-C' || args[i] === '-c') { i += 1; continue; }
    if (!args[i].startsWith('-')) return { name: args[i], rest: args.slice(i + 1) };
  }
  return { name: '', rest: [] };
}

function withoutTextArguments(tokens) {
  const kept = [];
  for (let i = 0; i < tokens.length; i += 1) {
    if (TEXT_FLAGS.has(tokens[i])) { i += 1; continue; }
    if (/^--(message|body|title)=/.test(tokens[i])) continue;
    kept.push(tokens[i]);
  }
  return kept;
}

function secretAllowed(cmd, mentionIndexes) {
  const { tokens } = cmd;
  const first = commandIndex(tokens);
  if (first === -1) return false;
  const name = verbName(tokens[first]);
  const args = tokens.slice(first + 1);
  if (METADATA_VERBS.has(name)) return true;
  if (COPY_VERBS.has(name)) {
    const operands = tokens.map((t, i) => ({ t, i })).filter(({ t, i }) => i > first && !t.startsWith('-'));
    const destination = operands.length > 0 ? operands[operands.length - 1].i : -1;
    return mentionIndexes.every((i) => i === destination);
  }
  if (PATTERN_FIRST_VERBS.has(name)) {
    // Упоминание допустимо только там, где команда ищет ТЕКСТ (шаблон/скрипт), а не читает файл.
    const patternIndexes = new Set();
    const usesPatternFile = args.some((a) => /^(--file(=.*)?|-[a-zA-Z]*[fe][a-zA-Z]*)$/.test(a));
    const usesFlagPattern = args.some((a) => /^(-e|--regexp)$/.test(a)) && !args.some((a) => /^(--file(=.*)?|-[a-zA-Z]*f[a-zA-Z]*)$/.test(a));
    if (usesFlagPattern) {
      args.forEach((a, i) => { if (a === '-e' || a === '--regexp') patternIndexes.add(first + 2 + i); });
    } else if (!usesPatternFile) {
      patternIndexes.add(tokens.findIndex((t, i) => i > first && !t.startsWith('-')));
    }
    return mentionIndexes.every((i) => patternIndexes.has(i));
  }
  if (name === 'git' || name === 'gh') {
    const visible = withoutTextArguments(args);
    const stillMentioned = visible.some(tokenMentionsSecret);
    if (!stillMentioned) return true;
    if (name !== 'git') return false;
    const { name: sub, rest } = gitSubcommand(visible);
    if (GIT_SAFE_SUBCOMMANDS.has(sub)) return true;
    if (sub === 'rm' && rest.includes('--cached')) return true;
    if ((sub === 'reset' || sub === 'restore') && !rest.includes('--hard') && (sub === 'reset' || rest.includes('--staged'))) return true;
  }
  return false;
}

export function checkSecrets(commands) {
  for (const cmd of commands) {
    const mentionIndexes = cmd.tokens
      .map((token, index) => (cmd.consumed.has(index) ? -1 : (tokenMentionsSecret(token) ? index : -1)))
      .filter((index) => index !== -1);
    if (mentionIndexes.length === 0) continue;
    const first = commandIndex(cmd.tokens);
    const isGit = first !== -1 && verbName(cmd.tokens[first]) === 'git';
    // Имя файла внутри $(...) — способ спрятать его от проверки, поэтому там не прощаем ничего.
    if (!secretAllowed(cmd, mentionIndexes) || cmd.pipedInto || cmd.inSubstitution) {
      return isGit && /\badd\b/.test(cmd.tokens.slice(first + 1).join(' '))
        ? 'попытка добавить файл с ключами в git'
        : 'команда трогает файл с ключами или паролями (.env, .pem, id_rsa и т.п.)';
    }
  }
  return null;
}

function isSecretVariable(name) {
  return /key|token|secret|pass|credential|auth/i.test(name);
}

export function checkEnvironmentDump(commands) {
  for (const { tokens } of commands) {
    const first = commandIndex(tokens);
    const rawFirst = tokens.findIndex((t) => !isAssignment(t));
    for (const index of new Set([first, rawFirst].filter((i) => i !== -1))) {
      const name = verbName(tokens[index]);
      const args = tokens.slice(index + 1).filter((a) => !a.startsWith('-') && !isAssignment(a));
      if (name === 'env' && args.length === 0) return 'вывод всех переменных окружения (там бывают ключи)';
      if (name === 'printenv' && (args.length === 0 || args.some(isSecretVariable))) return 'вывод переменных окружения (там бывают ключи)';
      if (name === 'set' && tokens.length === index + 1) return 'вывод всех переменных оболочки (там бывают ключи)';
      if ((name === 'export' || name === 'declare' || name === 'typeset') && tokens.slice(index + 1).some((a) => /^-[a-z]*[px]/.test(a)) && args.length === 0) {
        return 'вывод всех переменных окружения (там бывают ключи)';
      }
    }
    if (tokens.some((t) => /^env:\*?$/i.test(t) || /^env:.*(key|token|secret|pass)/i.test(t))) {
      return 'вывод переменных окружения (там бывают ключи)';
    }
    const gh = tokens.findIndex((t) => verbName(t) === 'gh');
    if (gh !== -1 && tokens[gh + 1] === 'auth' && tokens[gh + 2] === 'token') return 'вывод токена GitHub';
    if (tokens.some((t) => verbName(t) === 'security') && tokens.some((t) => /^find-(generic|internet)-password$/.test(t))) {
      return 'чтение паролей из связки ключей';
    }
  }
  return null;
}

function checkGitCommand(tokens, index) {
  const { name, rest } = gitSubcommand(tokens.slice(index + 1));
  const has = (pattern) => rest.some((a) => pattern.test(a));
  if (name === 'push') {
    if (has(/^(--force|--force-with-lease|--mirror|--delete)(=.*)?$/) || has(/^-[a-zA-Z]*[fd][a-zA-Z]*$/) || has(/^[+:][\w./-]+/)) {
      return 'git push --force или удаление ветки в облаке (перезапишет чужие сохранения)';
    }
  }
  if (name === 'reset' && has(/^--hard$/)) return 'git reset --hard (стирает несохранённую работу)';
  if (name === 'clean' && (has(/^-[a-zA-Z]*[fdx][a-zA-Z]*$/) || has(/^--force$/))) return 'git clean (удаляет файлы, которых нет в git)';
  if ((name === 'checkout' || name === 'restore') && (has(/^\.$/) || has(/^:\/$/))) return 'откат всех несохранённых правок в проекте';
  if (name === 'checkout' && has(/^(-f|--force)$/)) return 'git checkout --force (стирает несохранённую работу)';
  if (name === 'filter-branch' || name === 'filter-repo') return 'переписывание истории проекта';
  return null;
}

export function checkGit(commands) {
  for (const { tokens } of commands) {
    for (let index = 0; index < tokens.length; index += 1) {
      if (verbName(tokens[index]) !== 'git') continue;
      const reason = checkGitCommand(tokens, index);
      if (reason) return reason;
    }
  }
  return null;
}

export function checkDatabase(command) {
  const checks = [
    [/\bdrop\s+(database|table|schema)\b/i, 'удаление базы или таблицы (DROP)'],
    [/\btruncate\s+(table\s+)?\w+/i, 'очистка таблицы (TRUNCATE)'],
    [/\bdelete\s+from\s+[\w."]+\s*(;|"|'|$)/i, 'DELETE без условия WHERE: сотрёт все строки'],
    [/(^|[\s;&|])dropdb(\s|$)/i, 'dropdb: удаление базы'],
    [/supabase\s+(db\s+reset|projects\s+delete)/i, 'сброс или удаление проекта Supabase'],
    [/prisma\s+(migrate\s+reset|db\s+push[^|;&]*(--force-reset|--accept-data-loss))/i, 'сброс базы через Prisma'],
    [/dropdatabase|flushall|flushdb/i, 'удаление данных из базы'],
    [/gh\s+repo\s+delete/i, 'удаление репозитория на GitHub'],
    [/vercel\s+(project\s+)?(rm|remove)\b/i, 'удаление проекта на Vercel'],
  ];
  for (const [pattern, reason] of checks) {
    if (pattern.test(command)) return reason;
  }
  return null;
}

// Доверенный адрес: https, имя хоста строго из списка, без логина-пароля и порта.
// Префиксы пути доверяем только у raw.githubusercontent.com (там путь = чей репозиторий).
export function isTrustedUrl(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return false;
  if (TRUSTED_HOSTS.has(url.hostname)) return true;
  return url.hostname === RAW_GITHUB_HOST && RAW_GITHUB_PREFIXES.some((prefix) => url.pathname.startsWith(prefix));
}

// ---- Скрипты из интернета: запрет по умолчанию, смотрим на разобранные команды ----
// Любой конвейер «загрузчик -> интерпретатор» (и <(curl ...), и $(curl ...) внутри интерпретатора) разрешён
// только для доверенного https-адреса и безобидного набора флагов. Что читает интерпретатор, не угадываем.
const PIPE_TARGETS = new Set([
  'sh', 'bash', 'zsh', 'dash', 'ksh', 'ash', 'fish', 'csh', 'tcsh', 'node', 'nodejs', 'bun', 'deno', 'ruby', 'perl', 'php',
  'pwsh', 'powershell', 'iex', 'invoke-expression', 'eval', 'source', '.',
]);
const SAFE_FETCH_LONG_FLAGS = new Set(['--fail', '--silent', '--show-error', '--location', '--tlsv1.2', '-usebasicparsing']);
const SAFE_FETCH_SHORT_FLAGS = /^-[fsSLq]+$/;

function isInterpreterName(name) {
  return PIPE_TARGETS.has(name) || /^python[\d.]*$/.test(name);
}

// Загрузчик доверенный: все аргументы — безобидные флаги или https-адреса из списка, и хотя бы один адрес есть.
function fetchIsTrusted(tokens) {
  const start = tokens.findIndex((t) => FETCH_NAMES.has(verbName(t)));
  if (start === -1) return true;
  const args = tokens.slice(start + 1);
  let urls = 0;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '-O-' || arg === '-o-' || arg === '-qO-' || /^-uri$/i.test(arg)) continue;
    if ((arg === '-O' || arg === '-o') && args[i + 1] === '-') { i += 1; continue; }
    if (arg === '--proto' && args[i + 1] === '=https') { i += 1; continue; }
    if (SAFE_FETCH_SHORT_FLAGS.test(arg) || SAFE_FETCH_LONG_FLAGS.has(arg.toLowerCase())) continue;
    if (arg.startsWith('-')) return false;
    if (!isTrustedUrl(arg)) return false;
    urls += 1;
  }
  return urls > 0;
}

export function checkPipeToShell(commands) {
  for (const cmd of commands) {
    const start = commandIndex(cmd.tokens);
    if (start === -1 || !isInterpreterName(verbName(cmd.tokens[start]))) continue;
    const upstream = [];
    for (let prev = cmd.prev; prev; prev = prev.prev) upstream.push(prev);
    const fetchers = [...upstream, ...cmd.subs].filter((c) => c.tokens.some((t) => FETCH_NAMES.has(verbName(t))));
    if (fetchers.some((c) => !fetchIsTrusted(c.tokens))) {
      return 'запуск скрипта, скачанного из интернета, с непроверенного адреса или с нестандартными флагами';
    }
  }
  return null;
}

// ---- Интерпретаторы: белый список. Код в командной строке не разбираем, а запрещаем целиком ----
// Разрешено только: <интерпретатор> <файл внутри проекта> [аргументы], --version/-V/-v, python -m pip|venv|http.server,
// PowerShell -NoProfile -File <файл в проекте>. Всё остальное: «запиши код в файл проекта и запусти файл».
const INTERPRETER_VERBS = /^(python[\d.]*|node|nodejs|bun|deno|ruby|perl|php|pwsh|powershell)$/;
const VERSION_FLAGS = new Set(['--version', '-V', '-v']);
const PYTHON_MODULES = new Set(['pip', 'venv', 'http.server']);
const POWERSHELL_PRE_FLAGS = /^-(noprofile|noninteractive|nologo)$/i;
const INTERPRETER_DENY = 'интерпретатор запускает код из командной строки или с флагами, которые я не проверяю: запиши код в файл проекта и запусти файл';

function isScriptInProject(rawFile, cwd, extension) {
  const file = rawFile && rawFile.replace(/\$\{?CLAUDE_PLUGIN_ROOT\}?/g, path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
  if (!file || !extension.test(file) || file.startsWith('-') || /[$`*?[\]{}~<>]/.test(file) || /^[a-z][a-z0-9+.-]*:/i.test(file)) return false; // схемы http:, data:, npm:, jsr: — не файл
  const resolved = path.resolve(cwd, file);
  const inside = (child, parent) => {
    const relative = path.relative(parent, child);
    return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
  };
  const pluginScripts = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
  const isRealFile = (target) => {
    try { return fs.statSync(target).isFile(); } catch { return false; }
  };
  if (inside(resolved, pluginScripts)) return isRealFile(resolved);
  // файл обязан существовать внутри проекта (по реальному пути): «запиши код в файл» и запусти отдельным шагом
  return inside(resolved, cwd) && inside(realpathNearest(resolved), realpathNearest(cwd)) && isRealFile(resolved);
}

const SCRIPT_EXTENSION = {
  python: /\.py$/i, node: /\.(m?js|cjs|tsx?|jsx)$/i, ruby: /\.rb$/i, perl: /\.pl$/i, php: /\.php$/i, powershell: /\.ps1$/i,
};
const BUN_PACKAGE_COMMANDS = new Set(['install', 'i', 'add', 'remove', 'rm', 'update', 'pm']);
const CD_VERBS = new Set(['cd', 'pushd', 'set-location', 'sl', 'chdir']);

function extensionFor(name) {
  if (/^python/.test(name)) return SCRIPT_EXTENSION.python;
  if (/^(node|nodejs|bun|deno)$/.test(name)) return SCRIPT_EXTENSION.node;
  if (name === 'pwsh' || name === 'powershell') return SCRIPT_EXTENSION.powershell;
  return SCRIPT_EXTENSION[name];
}

function interpreterAllowed(name, args, cwd) {
  if (args.length === 1 && VERSION_FLAGS.has(args[0])) return true;
  if (name === 'pwsh' || name === 'powershell') {
    let i = 0;
    while (i < args.length && POWERSHELL_PRE_FLAGS.test(args[i])) i += 1;
    return /^-file$/i.test(args[i] || '') && isScriptInProject(args[i + 1], cwd, extensionFor(name));
  }
  if (/^python/.test(name) && args[0] === '-m') return PYTHON_MODULES.has(args[1]);
  const extension = extensionFor(name);
  if (name === 'deno') return args[0] === 'run' && isScriptInProject(args[1], cwd, extension);
  if (name === 'bun') {
    if (BUN_PACKAGE_COMMANDS.has(args[0])) return true; // пакетный менеджер, а не запуск кода
    if (args[0] === 'run') return isScriptInProject(args[1], cwd, extension) || /^[\w:-]+$/.test(args[1] || ''); // файл или скрипт из package.json
  }
  return isScriptInProject(args[0], cwd, extension);
}

// Общее правило: если в строке есть интерпретатор, то менять окружение или собирать команды «на лету» в этой же строке нельзя.
const ENVIRONMENT_VERBS = new Set(['export', 'declare', 'typeset', 'set', 'setenv', 'source', '.', 'unset', 'read', 'env']);
const INDIRECT_RUNNERS = new Set(['xargs', 'parallel', 'watch', 'env']);

function changesEnvironmentOrRunsIndirectly(cmd) {
  const { tokens } = cmd;
  const start = commandIndex(tokens);
  if (start !== -1 && ENVIRONMENT_VERBS.has(verbName(tokens[start]))) return true;
  if (tokens.some((t) => INDIRECT_RUNNERS.has(verbName(t)))) return true;
  if (tokens.some((t) => verbName(t) === 'find') && tokens.some((t) => /^-(exec|execdir)$/.test(t))) return true;
  return tokens.some((t) => /^\$?env:/i.test(t) || /CLAUDE_PLUGIN_ROOT=/.test(t));
}

export function checkInterpreters(commands, cwd) {
  const hasInterpreter = commands.some((cmd) => {
    const at = commandIndex(cmd.tokens);
    return at !== -1 && INTERPRETER_VERBS.test(verbName(cmd.tokens[at]));
  });
  if (hasInterpreter && commands.some(changesEnvironmentOrRunsIndirectly)) {
    return 'вместе с интерпретатором в одной строке меняется окружение или команда собирается на лету (export, source, env, xargs, find -exec): запускай по одному шагу';
  }
  let movedDirectory = false;
  for (const cmd of commands) {
    const start = commandIndex(cmd.tokens);
    if (start === -1) continue;
    const name = verbName(cmd.tokens[start]);
    if (CD_VERBS.has(name)) movedDirectory = true;
    if (!INTERPRETER_VERBS.test(name)) continue;
    if (movedDirectory) return INTERPRETER_DENY; // cd перед запуском: относительный путь означает уже не тот файл
    const prefix = cmd.tokens.slice(0, start);
    if (prefix.some((t) => isAssignment(t) || verbName(t) === 'env')) return INTERPRETER_DENY; // VAR=x python3 ..., env VAR=x node ...
    if (cmd.heredoc || cmd.tokens.some((t) => /^\d*<</.test(t) || /^\d*<(?!\()/.test(t))) return INTERPRETER_DENY; // любой ввод через <, <<, <<<
    if (!interpreterAllowed(name, cmd.tokens.slice(start + 1), cwd)) return INTERPRETER_DENY;
  }
  return null;
}

// ---- Читающая команда с переменной в аргументе: куда она смотрит, проверить нельзя ----
const READER_VERBS = new Set([
  'cat', 'less', 'more', 'head', 'tail', 'bat', 'xxd', 'od', 'strings', 'base64', 'type', 'get-content', 'gc',
  'nl', 'tac', 'cut', 'source', '.', 'tar', 'zip', 'scp', 'cp',
]);

export function checkUnverifiableReads(commands) {
  for (const { tokens } of commands) {
    const start = commandIndex(tokens);
    if (start === -1 || !READER_VERBS.has(verbName(tokens[start]))) continue;
    if (tokens.slice(start + 1).some((t) => /[$`]/.test(t))) {
      return 'читающая команда получает путь из переменной или подстановки: не могу проверить, что она откроет';
    }
  }
  return null;
}

// Попытки выдать себе разрешение или переписать защиту: старый approve.mjs и файл одобрений.
export function checkSelfApproval(text) {
  return /approve\.mjs|[/\\]\.ii-ramis[/\\]+approv|approvals\.json/i.test(text)
    ? 'попытка выдать себе разрешение в обход защиты'
    : null;
}
