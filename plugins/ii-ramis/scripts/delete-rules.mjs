// Правила про удаление файлов. Работают по разобранным командам (shell-parse.mjs), а не по сырой строке.
import os from 'node:os';
import path from 'node:path';
import { verbName, commandIndex, isAssignment } from './shell-parse.mjs';

const SAFE_DIR_NAMES = new Set([
  'node_modules', 'dist', '.next', 'build', '.turbo', '.cache', 'coverage', 'out',
  '.vercel', '__pycache__', '.pytest_cache', '.parcel-cache', '.svelte-kit', '.nuxt', '.output', '.expo',
]);
const DELETE_VERBS = new Set(['rm', 'rmdir', 'rd', 'del', 'erase', 'remove-item', 'ri', 'unlink', 'shred', 'rimraf']);
const POWERSHELL_VERBS = new Set(['remove-item', 'ri']);
const PACKAGE_TOOLS = new Set(['npm', 'pnpm', 'yarn', 'docker', 'podman', 'brew', 'pip', 'pip3', 'apt', 'apt-get', 'kubectl', 'helm', 'vercel', 'gh', 'supabase']);
const HOME_VARIABLES = /^(\$\{?HOME\}?|\$env:(USERPROFILE|HOME)|%USERPROFILE%|%HOMEPATH%)(?=$|[/\\])/i;
const INTERPRETERS = new Set(['python', 'python3', 'node', 'perl', 'ruby', 'php', 'deno', 'bun']);
const INLINE_CODE_FLAG = /^(-c|-e|-p|--eval|--print|-r)$/;
const DESTRUCTIVE_CODE = /rmSync|rmdirSync|unlinkSync|fs\.rm\b|fs\.unlink|rimraf|rmtree|removedirs|os\.remove|os\.unlink|\brm\s+-[a-z]*r|Remove-Item/i;
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
  return [...before.filter((a) => !isFlag(a)), ...after];
}

function expandKnownVariables(target, cwd) {
  if (/^\$\{?PWD\}?(?=$|[/\\])/.test(target)) return target.replace(/^\$\{?PWD\}?/, cwd);
  return target.replace(HOME_VARIABLES, os.homedir());
}

function resolveTarget(target, cwd) {
  if (target === '~' || target.startsWith('~/') || target.startsWith('~\\')) {
    return path.join(os.homedir(), target.slice(1));
  }
  return path.resolve(cwd, target);
}

// Проверка одной цели удаления. recursive: папки можно только мусорные внутри проекта.
export function checkDeleteTarget(rawTarget, cwd, recursive) {
  const target = expandKnownVariables(rawTarget, cwd);
  if (/[$`%]/.test(target)) return `удаление по переменной или подстановке (${rawTarget}): не могу проверить, что именно сотрётся`;
  if (/^~[^/\\]/.test(target)) return `удаление в чужой домашней папке (${rawTarget})`;
  if (process.platform !== 'win32' && (/^[A-Za-z]:[\\/]/.test(target) || target.startsWith('\\\\'))) {
    return `удаление вне папки проекта (${rawTarget})`;
  }
  const resolved = resolveTarget(target, cwd);
  const tmpRoots = [os.tmpdir(), '/tmp', '/private/tmp'];
  const cwdInTmp = tmpRoots.some((root) => isInside(cwd, root));
  if (!cwdInTmp && tmpRoots.some((root) => isInside(resolved, root))) return null;
  if (!isInside(resolved, cwd)) return `удаление вне папки проекта (${rawTarget})`;
  if (!recursive) return null;
  const segments = path.relative(cwd, resolved).split(path.sep);
  if (segments.includes('.git')) return 'удаление истории сохранений (.git)';
  if (!segments.some((name) => SAFE_DIR_NAMES.has(name))) {
    return `рекурсивное удаление не-мусорной папки (${rawTarget}): разрешены только node_modules, dist, .next, build и подобные`;
  }
  return null;
}

function isCommandPosition(tokens, index) {
  return commandIndex(tokens) === index || tokens.slice(0, index).every((t) => isFlag(t) || isAssignment(t) || /^\d+$/.test(t) || /^(sudo|doas|env|command|exec|time|nohup)$/.test(verbName(t)));
}

function checkDeleteVerb(tokens, index, cwd, mode) {
  const name = verbName(tokens[index]);
  const previous = index > 0 ? verbName(tokens[index - 1]) : '';
  const args = tokens.slice(index + 1);
  if (PACKAGE_TOOLS.has(previous)) return null; // npm rm lodash, docker rm x: это не удаление файлов
  if (previous === 'git' && args.includes('--cached')) return null;
  const recursive = isRecursive(name, args, mode);
  const targets = targetsOf(args);
  if (!recursive && !isCommandPosition(tokens, index)) return null;
  if (recursive && targets.length === 0) return 'рекурсивное удаление без понятной цели (список файлов приходит откуда-то ещё)';
  for (const target of targets) {
    const reason = checkDeleteTarget(target, cwd, recursive);
    if (reason) return reason;
  }
  return null;
}

function checkFind(tokens, index, cwd) {
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
    const reason = checkDeleteTarget(start, cwd, true);
    if (reason) return `find с удалением: ${reason}`;
  }
  return null;
}

// Возвращает причину блокировки или null. commands — плоский список простых команд из parseShell.
export function checkDeletion(commands, cwd) {
  for (const cmd of commands) {
    const { tokens, mode } = cmd;
    const first = commandIndex(tokens);
    if (first !== -1) {
      const verb = tokens[first];
      const name = verbName(verb);
      const rest = tokens.slice(first + 1);
      if (/[$*?{]/.test(name) && rest.some((a) => SUSPICIOUS_ARGS.test(a))) {
        return 'команда собрана из переменной или шаблона и выглядит как удаление: не могу проверить';
      }
      if (INTERPRETERS.has(name) && rest.some((a, i) => INLINE_CODE_FLAG.test(a) && DESTRUCTIVE_CODE.test(rest[i + 1] || ''))) {
        return 'удаление файлов через встроенный скрипт (python/node): не могу проверить, что сотрётся';
      }
    }
    tokens.forEach((token, index) => {
      if (cmd.deleteReason) return;
      const name = verbName(token);
      if (DELETE_VERBS.has(name)) cmd.deleteReason = checkDeleteVerb(tokens, index, cwd, mode);
      else if (name === 'find') cmd.deleteReason = checkFind(tokens, index, cwd);
      else if (name === 'xargs' && tokens.slice(index + 1).some((t) => DELETE_VERBS.has(verbName(t)))) {
        cmd.deleteReason = 'удаление через xargs: список файлов приходит из другой команды';
      }
    });
    if (cmd.deleteReason) return cmd.deleteReason;
  }
  return null;
}
