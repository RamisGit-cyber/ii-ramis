// PreToolUse: страховка для новичков. Exit 2 = команда заблокирована, текст из stderr читает Claude.
// Идеи правил — из личного bash-safety Рамиса, переписано на Node, чтобы работало и на Mac, и на Windows.
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  APPROVALS_FILE, readJson, writeJson, readStdinJson, normalizeCommand, commandHash,
} from './lib.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const APPROVE_SCRIPT = path.join(SCRIPT_DIR, 'approve.mjs');

const SAFE_DIR_NAMES = new Set([
  'node_modules', 'dist', '.next', 'build', '.turbo', '.cache', 'coverage', 'out',
  '.vercel', '__pycache__', '.pytest_cache', '.parcel-cache', '.svelte-kit', '.nuxt', '.output', '.expo',
]);

const TRUSTED_INSTALL_SOURCES = [
  'claude.ai', 'bun.sh', 'astral.sh', 'brew.sh', 'deno.land', 'sh.rustup.rs', 'fnm.vercel.app',
  'raw.githubusercontent.com/RamisGit-cyber/', 'raw.githubusercontent.com/Homebrew/',
  'raw.githubusercontent.com/nvm-sh/', 'raw.githubusercontent.com/thedotmack/',
];

const SECRET_PATH = new RegExp(
  [
    String.raw`(^|[\s'"=/\\<])\.env(\.(?!example|sample|template)[\w-]+)?($|[\s'"])`,
    String.raw`\.(pem|p12|pfx|key)($|[\s'"])`,
    String.raw`(^|[\s'"/\\])id_(rsa|ed25519|ecdsa|dsa)(\.pub)?($|[\s'"])`,
    String.raw`[/\\]\.ssh[/\\]`,
    String.raw`[/\\]\.aws[/\\]credentials`,
    String.raw`\.netrc|\.pgpass|\.npmrc`,
    String.raw`credentials\.json|service[-_]?account[\w.-]*\.json|secrets?\.(json|ya?ml|txt)`,
  ].join('|'),
  'i',
);

const READER_VERBS = /(^|[\s;&|(])(cat|less|more|head|tail|bat|xxd|od|strings|grep|egrep|rg|sed|awk|scp|base64|type|get-content|gc|select-string|sls|source|nano|vim|vi)(\s|$)/i;

function deny(reason, approvable, command) {
  let message = `ИИ Рамис остановил команду: ${reason}\n`;
  if (approvable) {
    message +=
      'Что делать: объясни ученику простыми словами, что именно сотрётся или изменится, и спроси прямое «да». ' +
      'Если ученик написал «да», выполни `node "' + APPROVE_SCRIPT + '" "' + command.replace(/"/g, '\\"') +
      '"` и повтори ту же команду в течение 10 минут. Сам, без ответа ученика, не подтверждай.\n';
  } else {
    message +=
      'Эту команду не подтверждает никто. Чтобы проверить, что ключ на месте, достаточно узнать, что файл есть и не пустой ' +
      '(`ls -la` / `Test-Path`), не читая содержимое. Ключи в чат и в вывод не попадают.\n';
  }
  process.stderr.write(message);
  process.exit(2);
}

function isApproved(command) {
  const hash = commandHash(command);
  const now = Date.now();
  const list = readJson(APPROVALS_FILE, []);
  const fresh = list.filter((item) => item.exp > now);
  const found = fresh.find((item) => item.h === hash);
  if (fresh.length !== list.length || found) {
    writeJson(APPROVALS_FILE, fresh.filter((item) => item !== found)); // одноразовое
  }
  return Boolean(found);
}

function splitSegments(command) {
  return command.split(/&&|\|\||;|\||\n/).map((part) => part.trim()).filter(Boolean);
}

function tokenize(segment) {
  const tokens = segment.match(/"[^"]*"|'[^']*'|\S+/g) || [];
  return tokens.map((token) => token.replace(/^["']|["']$/g, ''));
}

function resolveTarget(target, cwd) {
  if (target === '~' || target.startsWith('~/') || target.startsWith('~\\')) {
    return path.join(os.homedir(), target.slice(1));
  }
  return path.resolve(cwd, target);
}

function isInside(child, parent) {
  const relative = path.relative(parent, child);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function recursiveDeleteTargets(segment) {
  const tokens = tokenize(segment);
  const verbIndex = tokens.findIndex((t) => /^(rm|rmdir|rd|del|erase|remove-item|ri)$/i.test(t));
  if (verbIndex === -1) return null;
  const args = tokens.slice(verbIndex + 1);
  const verb = tokens[verbIndex].toLowerCase();
  const recursive = args.some((a) =>
    /^-[a-z]*r[a-z]*$/i.test(a) && verb === 'rm' ||
    /^--recursive$/i.test(a) ||
    /^-recurse$/i.test(a) ||
    /^\/s$/i.test(a));
  if (!recursive) return null;
  return args.filter((a) => !/^-/.test(a) && !/^\/[a-z]$/i.test(a));
}

function checkRecursiveDelete(command, cwd) {
  for (const segment of splitSegments(command)) {
    const targets = recursiveDeleteTargets(segment);
    if (targets === null) continue;
    if (targets.length === 0) return 'рекурсивное удаление без понятной цели';
    for (const target of targets) {
      if (/[$`%]/.test(target)) return `удаление по переменной или подстановке (${target})`;
      const resolved = resolveTarget(target, cwd);
      const tmpRoots = [os.tmpdir(), '/tmp', '/private/tmp'];
      const cwdInTmp = tmpRoots.some((root) => isInside(cwd, root));
      if (!cwdInTmp && tmpRoots.some((root) => isInside(resolved, root))) continue;
      if (!isInside(resolved, cwd)) return `удаление вне папки проекта (${target})`;
      const segments = path.relative(cwd, resolved).split(path.sep);
      if (segments.includes('.git')) return 'удаление истории сохранений (.git)';
      if (!segments.some((name) => SAFE_DIR_NAMES.has(name))) {
        return `рекурсивное удаление не-мусорной папки (${target}): разрешены только node_modules, dist, .next, build и подобные`;
      }
    }
  }
  return null;
}

function checkSecretRead(command) {
  for (const segment of splitSegments(command)) {
    if (/\.gitignore/i.test(segment)) continue;
    if (SECRET_PATH.test(segment) && (READER_VERBS.test(segment) || /<\s*\S*\.env/i.test(segment))) {
      return 'чтение файла с ключами или паролями';
    }
    if (/git\s+add\b/i.test(segment) && SECRET_PATH.test(segment)) {
      return 'попытка добавить файл с ключами в git';
    }
  }
  if (/(^|[;&|]\s*)(printenv|env)(\s*$|\s*[|>;&])/i.test(command) || /(gci|get-childitem|dir|ls)\s+env:/i.test(command)) {
    return 'вывод всех переменных окружения (там бывают ключи)';
  }
  return null;
}

function urlsIn(command) {
  return (command.match(/https?:\/\/[^\s'"|)]+/gi) || []);
}

function isTrusted(url) {
  const stripped = url.replace(/^https?:\/\//i, '');
  return TRUSTED_INSTALL_SOURCES.some((source) => stripped.toLowerCase().startsWith(source.toLowerCase()));
}

function checkPipeToShell(command) {
  const pipeToShell =
    /(curl|wget|iwr|irm|invoke-webrequest|invoke-restmethod)\b[^|]*\|\s*(sudo\s+)?(sh|bash|zsh|ksh|iex|invoke-expression|node|python3?)\b/i.test(command) ||
    /(sh|bash|zsh)\s+(-c\s+)?["']?(<\(|\$\()\s*(curl|wget)/i.test(command) ||
    /(iex|invoke-expression)\s*[(\s]+.*(irm|iwr|downloadstring|invoke-restmethod|invoke-webrequest)/i.test(command);
  if (!pipeToShell) return null;
  const urls = urlsIn(command);
  if (urls.length > 0 && urls.every(isTrusted)) return null;
  return 'запуск скрипта, скачанного из интернета, с непроверенного адреса';
}

function checkGit(command) {
  for (const segment of splitSegments(command)) {
    if (/\bgit\b/i.test(segment) === false) continue;
    if (/git\s+push\b/i.test(segment) &&
      (/\s(--force|--force-with-lease|--mirror|-f)(\s|=|$)/.test(segment) || /\s\+[\w./-]+/.test(segment))) {
      return 'git push --force (перезапишет чужие сохранения в облаке)';
    }
    if (/git\s+reset\b[^|;&]*--hard/i.test(segment)) return 'git reset --hard (стирает несохранённую работу)';
    if (/git\s+clean\s+-[a-z]*[fd]/i.test(segment)) return 'git clean (удаляет файлы, которых нет в git)';
    if (/git\s+(checkout|restore)\s+(--\s+)?\.(\s|$)/i.test(segment)) return 'откат всех несохранённых правок в проекте';
    if (/git\s+filter-(branch|repo)/i.test(segment)) return 'переписывание истории проекта';
  }
  return null;
}

function checkDatabase(command) {
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

function guardRead(input) {
  const filePath = String(input.tool_input?.file_path || '');
  if (filePath && SECRET_PATH.test(` ${filePath} `)) {
    deny('чтение файла с ключами или паролями', false, filePath);
  }
}

function guardShell(input) {
  const command = String(input.tool_input?.command || '');
  if (!command) return;
  const cwd = input.cwd || process.cwd();
  const normalized = normalizeCommand(command);

  const secretReason = checkSecretRead(normalized);
  if (secretReason) deny(secretReason, false, normalized);

  const approvableReason =
    checkRecursiveDelete(normalized, cwd) ||
    checkGit(normalized) ||
    checkPipeToShell(normalized) ||
    checkDatabase(normalized);
  if (!approvableReason) return;
  if (isApproved(normalized)) return;
  deny(approvableReason, true, normalized);
}

const input = readStdinJson();
try {
  if (input.tool_name === 'Read') guardRead(input);
  else if (input.tool_name === 'Bash' || input.tool_name === 'PowerShell') guardShell(input);
} catch (error) {
  // Сбой самой страховки не должен ломать работу ученика, но и не должен быть тихим.
  console.error(`ii-ramis guard: внутренняя ошибка, команда пропущена: ${error.message}`);
}
process.exit(0);
