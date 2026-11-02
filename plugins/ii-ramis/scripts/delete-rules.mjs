// Правила про удаление файлов. Работают по разобранным командам (shell-parse.mjs), а не по сырой строке.
import os from 'node:os';
import path from 'node:path';
import { realpathNearest } from './lib.mjs';
import { isProtectedPath } from './protect-rules.mjs';
import { verbName, commandIndex, isAssignment } from './shell-parse.mjs';
import { directoryAfter } from './cd-track.mjs';

const SAFE_DIR_NAMES = new Set([
  'node_modules', 'dist', '.next', 'build', '.turbo', '.cache', 'coverage', 'out',
  '.vercel', '__pycache__', '.pytest_cache', '.parcel-cache', '.svelte-kit', '.nuxt', '.output', '.expo',
]);
const DELETE_VERBS = new Set(['rm', 'rmdir', 'rd', 'del', 'erase', 'remove-item', 'ri', 'unlink', 'shred', 'rimraf']);
const POWERSHELL_VERBS = new Set(['remove-item', 'ri']);
// Пары «инструмент + подкоманда rm»: npm rm lodash, docker rm web. Допустимо только на настоящей позиции команды.
const PACKAGE_TOOLS = new Set(['npm', 'pnpm', 'yarn', 'docker', 'podman', 'brew', 'pip', 'pip3', 'apt', 'apt-get', 'kubectl', 'helm', 'vercel', 'gh', 'supabase']);
const OBJECT_WORDS = new Set(['container', 'image', 'volume', 'network', 'system']);
const HOME_VARIABLES = /^(\$\{?HOME\}?|\$env:(USERPROFILE|HOME)|%USERPROFILE%|%HOMEPATH%)(?=$|[/\\])/i;
const SUSPICIOUS_ARGS = /^(-[a-zA-Z]*[rR][a-zA-Z]*|--recursive|--no-preserve-root|-recurse|~|\/|\/\*|~\/\*)$/;

function isInside(child, parent) {
  const relative = path.relative(parent, child);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function isRecursive(name, args, mode) {
  if (name === 'rimraf') return true;
  if (args.includes('--recursive')) return true;
  if (/^(rd|del|erase|rmdir)$/.test(name) && args.some((a) => /^\/s$/i.test(a))) return true;
  const powershell = POWERSHELL_VERBS.has(name) || mode === 'ps';
  if (powershell) return args.some((a) => /^-r(e(c(u(r(s(e)?)?)?)?)?)?(:.*)?$/i.test(a));
  return args.some((a) => /^-[a-zA-Z]*[rR][a-zA-Z]*$/.test(a));
}

function isFlag(arg) {
  return (/^-./.test(arg) && !/^-\d/.test(arg)) || /^\/[a-zA-Z]$/.test(arg);
}

function targetsOf(args) {
  const dashDash = args.indexOf('--');
  const before = dashDash === -1 ? args : args.slice(0, dashDash);
  const after = dashDash === -1 ? [] : args.slice(dashDash + 1);
  return [...before.filter((a) => !isFlag(a)), ...after].flatMap((a) => (/^[^,]+,.+/.test(a) && !/[$`]/.test(a) ? a.split(',').filter(Boolean) : [a]));
}

function expandKnownVariables(target, cwd) {
  if (/^\$\{?PWD\}?(?=$|[/\\])/.test(target)) return target.replace(/^\$\{?PWD\}?/, cwd);
  return target.replace(HOME_VARIABLES, os.homedir());
}

function resolveTarget(target, workingDir) {
  if (target === '~' || target.startsWith('~/') || target.startsWith('~\\')) {
    return path.join(os.homedir(), target.slice(1));
  }
  return path.resolve(workingDir, target);
}

// Закрыто только уничтожение: корень диска, домашняя папка целиком, её большие папки целиком (Рабочий стол, Документы, Загрузки…) и системные папки.
// Всё остальное (node_modules, src, .git, чужая папка проекта, файлы на диске) удалять можно.
const HOME_WHOLE_FOLDERS = new Set([
  'desktop', 'documents', 'downloads', 'pictures', 'movies', 'music', 'videos', 'library', 'applications', 'public', 'icloud drive', 'onedrive', 'dropbox',
  'google drive', 'my drive', 'creative cloud files', '.ssh', '.aws', '.gnupg', '.config', '.local', '.docker', '.kube', 'appdata', 'application support',
]);
const SYSTEM_ROOTS = [
  '/bin', '/sbin', '/usr', '/etc', '/var', '/System', '/Library', '/Applications', '/opt', '/boot', '/lib', '/lib32', '/lib64', '/dev', '/proc', '/sys',
  '/Users', '/home', '/root', '/srv', '/mnt', '/Volumes', '/private/etc', '/private/var/db', '/private/var/root', '/cores', '/nix',
];
// Временные папки внутри системных (мак: /private/var/folders, linux: /var/tmp) удалять можно.
const SYSTEM_EXCEPTIONS = ['/var/folders', '/private/var/folders', '/var/tmp', '/private/var/tmp', '/tmp', '/private/tmp', '/var/log/claude'];
const WINDOWS_SYSTEM = /^[A-Za-z]:[\\/]*(?:$|windows(?:[\\/]|$)|program files|programdata|users[\\/]*$|users[\\/][^\\/]+[\\/]*$|users[\\/][^\\/]+[\\/](?:desktop|documents|downloads|appdata|pictures|music|videos|onedrive)[\\/]*$)/i;

function destructionReason(realTarget, rawTarget) {
  const home = realpathNearest(os.homedir());
  const same = (a, b) => a.toLowerCase() === b.toLowerCase();
  if (path.parse(realTarget).root === realTarget) return `удаление корня диска (${rawTarget})`;
  if (same(realTarget, home)) return `удаление домашней папки целиком (${rawTarget})`;
  if (isInside(realTarget, home)) {
    const parts = path.relative(home, realTarget).split(path.sep);
    if (parts.length === 1 && HOME_WHOLE_FOLDERS.has(parts[0].toLowerCase())) return `удаление папки «${parts[0]}» целиком (${rawTarget})`;
    if (parts.length === 2 && ['library', 'appdata'].includes(parts[0].toLowerCase()) && HOME_WHOLE_FOLDERS.has(parts[1].toLowerCase())) return `удаление служебной папки (${rawTarget})`;
  }
  if (isInside(home, realTarget)) return `удаление папки, внутри которой лежит домашняя папка (${rawTarget})`;
  const excepted = SYSTEM_EXCEPTIONS.some((root) => realTarget === root ? false : isInside(realTarget, realpathNearest(root)));
  if (!excepted && SYSTEM_ROOTS.some((root) => same(realTarget, root) || isInside(realTarget, root) || isInside(realpathNearest(root), realTarget))) {
    // сама домашняя папка лежит внутри /Users или /home: туда уже посмотрели выше
    if (!isInside(realTarget, home) && !same(realTarget, home)) return `удаление системной папки (${rawTarget})`;
  }
  if (WINDOWS_SYSTEM.test(realTarget)) return `удаление системной папки Windows (${rawTarget})`;
  return null;
}

// Проверка одной цели удаления. Закрыто только уничтожение (корень, домашняя папка, Рабочий стол/Документы/Загрузки целиком, системные папки),
// а также удаление .claude (там защита) и любое рекурсивное удаление по переменной: оттуда может прийти ~ или /.
export function checkDeleteTarget(rawTarget, cwd, recursive, workingDir = cwd, powershell = false) {
  const target = expandKnownVariables(rawTarget, cwd);
  if (/[$`%]/.test(target)) return recursive ? `рекурсивное удаление по переменной или подстановке (${rawTarget}): не могу проверить, что там не домашняя папка или корень диска` : null;
  if (/^~[^/\\]/.test(target)) return `удаление в чужой домашней папке (${rawTarget})`;
  const isHomeTarget = target === '~' || target.startsWith('~/') || target.startsWith('~\\');
  if (process.platform !== 'win32' && /^[A-Za-z]:[\\/]/.test(target)) {
    return WINDOWS_SYSTEM.test(target) ? `удаление системной папки Windows (${rawTarget})` : null;
  }
  if (workingDir === null && !path.isAbsolute(target) && !isHomeTarget) return recursive ? `удаление после cd в непонятное место (${rawTarget}): не могу проверить, что именно сотрётся` : null;
  const resolved = resolveTarget(target, workingDir ?? cwd);
  const name = path.basename(resolved);
  const hasGlob = /[*?[]/.test(name) || /[*?[]/.test(path.dirname(target));
  // шаблон: смотрим на папку, внутри которой он раскрывается (`rm -rf ~/Desktop/*` стирает Рабочий стол целиком)
  const container = hasGlob ? resolved.slice(0, resolved.search(/[*?[]/)).replace(/[/\\][^/\\]*$/, '') || path.sep : null;
  const realTarget = realpathNearest(container ?? resolved);
  const reason = destructionReason(realTarget, rawTarget);
  if (reason && (recursive || container === null || hasGlob)) return reason;
  if (recursive && (name === '.claude' || name === '.ii-ramis')) return 'удаление папки настроек Claude Code (.claude) или данных плагина: выключить защиту может только ученик сам';
  if (recursive && /[*?[]/.test(name) && (powershell ? /^\*$/.test(name) || name.startsWith('.') : name.startsWith('.')) && globMayMatch(name, ['.claude', '.ii-ramis', '.git'])) {
    return `удаление по шаблону (${rawTarget}) может задеть .claude: назови папки явно`;
  }
  if (hasGlob && recursive && destructionReason(realpathNearest(path.dirname(resolved)), rawTarget)) return destructionReason(realpathNearest(path.dirname(resolved)), rawTarget);
  return null;
}

function globMayMatch(name, candidates) {
  const body = name.replace(/[.+^${}()|\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  try {
    const regex = new RegExp(`^${body}$`, 'i');
    return candidates.some((candidate) => regex.test(candidate));
  } catch {
    return true;
  }
}

function isCommandPosition(tokens, index) {
  return commandIndex(tokens) === index || tokens.slice(0, index).every((t) => isFlag(t) || isAssignment(t) || /^\d+$/.test(t) || /^(sudo|doas|env|command|exec|time|nohup)$/.test(verbName(t)));
}

function isPackageSubcommand(tokens, index) {
  const start = commandIndex(tokens);
  if (start === -1) return false;
  const tool = verbName(tokens[start]);
  if (tool === 'git') return tokens.includes('--cached');
  if (!PACKAGE_TOOLS.has(tool)) return false;
  return index === start + 1 || (index === start + 2 && OBJECT_WORDS.has(tokens[start + 1]));
}

function checkDeleteVerb(tokens, index, cwd, mode, workingDir) {
  const name = verbName(tokens[index]);
  const args = tokens.slice(index + 1);
  if (isPackageSubcommand(tokens, index)) return null; // npm rm lodash, docker rm x: это не удаление файлов
  const recursive = isRecursive(name, args, mode);
  const targets = targetsOf(args);
  if (!recursive && !isCommandPosition(tokens, index)) return null;
  if (recursive && targets.length === 0) return 'рекурсивное удаление без понятной цели (список файлов приходит откуда-то ещё)';
  for (const target of targets) {
    const reason = checkDeleteTarget(target, cwd, recursive, workingDir, mode === 'ps' || POWERSHELL_VERBS.has(name));
    if (reason) return reason;
  }
  return null;
}

function checkFind(tokens, index, cwd, workingDir) {
  const args = tokens.slice(index + 1);
  const deletes = args.includes('-delete') ||
    args.some((arg, i) => /^-(exec|execdir|ok|okdir)$/.test(arg) && DELETE_VERBS.has(verbName(args[i + 1] || '')));
  if (!deletes) return null;
  const starts = [];
  for (const arg of args) {
    if (arg.startsWith('-') || arg === '(' || arg === '!') break;
    starts.push(arg);
  }
  for (const start of starts.length > 0 ? starts : ['.']) {
    const reason = checkDeleteTarget(start, cwd, true, workingDir);
    if (reason) return `find с удалением: ${reason}`;
  }
  return null;
}

// Ссылки на защищённые места (ln -s ~/.claude x) закрыты: через ссылку можно было бы править настройки.
function checkLinkCreation(name, rest, cwd) {
  const isLn = name === 'ln';
  const isNewItem = (name === 'new-item' || name === 'ni') && rest.some((a) => /^(symboliclink|junction|hardlink)$/i.test(a));
  if (!isLn && !isNewItem && name !== 'mklink') return null;
  const operands = rest.filter((a) => !isFlag(a) && !/^(symboliclink|junction|hardlink)$/i.test(a));
  for (const operand of operands) {
    if (isProtectedPath(operand, cwd)) return `ссылка на защищённое место (${operand}): выключить защиту может только ученик сам в настройках`;
  }
  return null;
}

// Возвращает причину блокировки или null. commands — плоский список простых команд из parseShell.
export function checkDeletion(commands, cwd) {
  let workingDir = cwd; // меняется после cd: после `cd /` слово `usr` означает /usr, а не папку проекта
  for (const cmd of commands) {
    const moved = directoryAfter(cmd.tokens, workingDir);
    if (moved !== undefined) { workingDir = moved; continue; }
    const { tokens, mode } = cmd;
    const first = commandIndex(tokens);
    if (first !== -1) {
      const verb = tokens[first];
      const name = verbName(verb);
      const rest = tokens.slice(first + 1);
      const psExpression = mode === 'ps' && name === '$()' && /^-(?:i|c)?(?:replace|split|join|match|notmatch|like|notlike|eq|ne|gt|lt|ge|le|contains|in|f)$/i.test(rest[0] || '');
      if (!psExpression && /[$*?{]/.test(name) && rest.some((a) => SUSPICIOUS_ARGS.test(a))) {
        return 'команда собрана из переменной или шаблона и выглядит как удаление: не могу проверить';
      }
      const linkReason = checkLinkCreation(name, rest, cwd);
      if (linkReason) return linkReason;
    }
    tokens.forEach((token, index) => {
      if (cmd.deleteReason) return;
      const name = verbName(token);
      if (DELETE_VERBS.has(name)) cmd.deleteReason = checkDeleteVerb(tokens, index, cwd, mode, workingDir);
      else if (name === 'find') cmd.deleteReason = checkFind(tokens, index, cwd, workingDir);
      else if (name === 'xargs' && tokens.slice(index + 1).some((t) => DELETE_VERBS.has(verbName(t)))) {
        cmd.deleteReason = 'удаление через xargs: список файлов приходит из другой команды';
      }
    });
    if (cmd.deleteReason) return cmd.deleteReason;
  }
  return null;
}
