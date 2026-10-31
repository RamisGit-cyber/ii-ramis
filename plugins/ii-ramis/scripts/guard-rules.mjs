// Правила охранника: ключи и пароли, git, скрипты из интернета, базы данных, переменные окружения.
import { tokenMentionsSecret } from './lib.mjs';
import { verbName, commandIndex, isAssignment } from './shell-parse.mjs';

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

export function checkPipeToShell(command) {
  const pipeToShell =
    /(curl|wget|iwr|irm|invoke-webrequest|invoke-restmethod)\b[^|]*\|\s*(sudo(\s+-\S+)*\s+)?(sh|bash|zsh|ksh|dash|iex|invoke-expression|node|python3?)\b/i.test(command) ||
    /(sh|bash|zsh|dash)\s+(-\w+\s+)*["']?(<\(|\$\()\s*(curl|wget)/i.test(command) ||
    /\beval\s+["']?(\$\(|`)\s*(curl|wget)/i.test(command) ||
    /(iex|invoke-expression)\s*[(\s]+.*(irm|iwr|downloadstring|invoke-restmethod|invoke-webrequest)/i.test(command);
  if (!pipeToShell) return null;
  const urls = command.match(/[a-z][a-z0-9+.-]*:\/\/[^\s'"`|)<>;&]+/gi) || [];
  if (urls.length > 0 && urls.every(isTrustedUrl)) return null;
  return 'запуск скрипта, скачанного из интернета, с непроверенного адреса';
}

// Попытки выдать себе разрешение или переписать защиту: старый approve.mjs и файл одобрений.
export function checkSelfApproval(text) {
  return /approve\.mjs|[/\\]\.ii-ramis[/\\]+approv|approvals\.json/i.test(text)
    ? 'попытка выдать себе разрешение в обход защиты'
    : null;
}
