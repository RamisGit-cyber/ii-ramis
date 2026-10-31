// Общие функции хуков «ИИ Рамис». Только стандартная библиотека Node, без npm.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

export const DATA_DIR = process.env.IIRAMIS_HOME || path.join(os.homedir(), '.ii-ramis');
export const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
export const PROGRESS_FILE = path.join(DATA_DIR, 'progress.jsonl');
export const STATE_FILE = path.join(DATA_DIR, 'state.json');
// Старый механизм «да» через модель удалён (модель могла подтвердить сама себя). Файл только вычищаем.
export const LEGACY_APPROVALS_FILE = path.join(DATA_DIR, 'approvals.json');

export function ensureDataDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

export function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.error(`ii-ramis: не прочитал ${file}: ${error.message}`);
    }
    return fallback;
  }
}

export function writeJson(file, value) {
  ensureDataDir();
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
}

export function loadConfig() {
  const existing = readJson(CONFIG_FILE, null);
  if (existing && existing.student_id && existing.install_id) return existing;
  const created = {
    student_id: crypto.randomUUID(),
    install_id: crypto.randomBytes(18).toString('base64url'), // 24 символа [A-Za-z0-9_-]
    share: false,
    lesson: null,
    autosave: true,
    ...(existing || {}),
  };
  if (!created.student_id) created.student_id = crypto.randomUUID();
  if (!created.install_id) created.install_id = crypto.randomBytes(18).toString('base64url');
  writeJson(CONFIG_FILE, created);
  return created;
}

export function readStdinJson() {
  try {
    const raw = fs.readFileSync(0, 'utf8');
    return raw.trim() ? JSON.parse(raw) : {};
  } catch (error) {
    console.error(`ii-ramis: не разобрал ввод хука: ${error.message}`);
    return {};
  }
}

// ---- Реестр секретных путей: один на охранника (guard.mjs) и автосохранение (session-start.mjs) ----
const END = String.raw`(?=$|[\s'"` + '`' + String.raw`;&|)<>,*?\[:])`;
const START = String.raw`(?:^|[^\w.-])`;
const SECRET_PATTERNS = [
  START + String.raw`\.env(?:\.(?!(?:example|sample|template|dist)(?![\w-]))[\w.-]+)?` + END,
  START + String.raw`\.dev\.vars(?:\.[\w-]+)?` + END,
  String.raw`\.(?:pem|p12|pfx|key|p8|jks|keystore)` + END,
  START + String.raw`id_(?:rsa|ed25519|ecdsa|dsa)` + END,
  String.raw`[/\\]\.ssh(?=$|[/\\\s'"` + '`' + String.raw`;&|)<>])`,
  String.raw`\.aws[/\\](?:credentials|config|sso)`,
  String.raw`\.netrc|\.pgpass|\.npmrc|\.pypirc|\.git-credentials`,
  String.raw`\.docker[/\\]config\.json|\.kube[/\\]config|gh[/\\]hosts\.yml|\.config[/\\]gcloud`,
  String.raw`credentials\.json|service[-_]?account[\w.-]*\.json|secrets?\.(?:json|ya?ml|txt)`,
  String.raw`/proc/[\w/]*environ`,
];
const SECRET_PATH = new RegExp(SECRET_PATTERNS.join('|'), 'i');
// Публичный ключ (.pub) показывать можно: он нужен для GitHub.
const PUBLIC_KEY_TOKEN = /[^\s'"`;&|<>()]*\.pub(?=$|[\s'"`;&|)<>])/gi;

export function mentionsSecretPath(text) {
  const original = String(text);
  const variants = [original, original.replace(/['"]/g, '')];
  return variants.some((variant) => SECRET_PATH.test(' ' + variant.replace(PUBLIC_KEY_TOKEN, ' ') + ' '));
}

const SECRET_DOTFILES = ['.env', '.env.local', '.env.production', '.dev.vars', '.npmrc', '.netrc', '.pgpass', '.git-credentials'];
const SECRET_NAMES = ['server.pem', 'private.key', 'id_rsa', 'id_ed25519', 'credentials.json', 'secrets.json', 'service-account.json'];

export function expandBraces(token, budget = 50) {
  const match = String(token).match(/^(.*?)\{([^{}]*)\}(.*)$/s);
  if (!match || !match[2].includes(',')) return [String(token)];
  const results = [];
  for (const option of match[2].split(',')) {
    results.push(...expandBraces(match[1] + option + match[3], budget));
    if (results.length >= budget) break;
  }
  return results.slice(0, budget);
}

function globToRegex(glob) {
  let source = '';
  for (let i = 0; i < glob.length; i += 1) {
    const ch = glob[i];
    if (ch === '*') source += '[^/]*';
    else if (ch === '?') source += '[^/]';
    else if (ch === '[') {
      const close = glob.indexOf(']', i + 2);
      if (close === -1) { source += '\\['; continue; }
      source += '[' + glob.slice(i + 1, close).replace(/^!/, '^').replace(/\\/g, '\\\\') + ']';
      i = close;
    } else source += ch.replace(/[.+^${}()|\\]/g, '\\$&');
  }
  return new RegExp(`^${source}$`, 'i');
}

// Шаблоны вроде `.e*`, `.en?` могут раскрыться в имя файла с ключами: ловим по имени файла.
function globMayMatchSecret(name) {
  if (!/[*?[]/.test(name)) return false;
  const regex = globToRegex(name);
  if (name.startsWith('.')) return SECRET_DOTFILES.some((file) => regex.test(file));
  const literal = name.replace(/[*?[\]]/g, '');
  return literal.length >= 3 && SECRET_NAMES.some((file) => regex.test(file));
}

// Токен команды упоминает секретный путь: прямо, через раскрытие {a,b} или через шаблон со звёздочкой.
export function tokenMentionsSecret(token) {
  try {
    return expandBraces(token).some((variant) =>
      mentionsSecretPath(variant) || globMayMatchSecret(variant.split(/[/\\]/).pop()));
  } catch {
    return true; // не смогли разобрать: считаем подозрительным
  }
}

// Убираем из текста всё, что похоже на путь, ключ или почту: в отчёт это не должно попасть.
export function redact(text, maxLength = 100) {
  return String(text)
    .replace(/[A-Za-z]:\\[^\s'"]+/g, '<path>')
    .replace(/(?:\/[\w.@+~-]+){2,}/g, '<path>')
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '<email>')
    .replace(/\b(sk|pk|ghp|gho|xox[a-z]|eyJ)[\w-]{8,}/g, '<key>')
    .replace(/\b[A-Za-z0-9_-]{24,}\b/g, '<token>')
    .replace(/\d+/g, 'N')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

// Ближайший существующий родитель + реальный путь: так видны симлинки (node_modules -> ~).
export function realpathNearest(target) {
  let current = target;
  const rest = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync(current), ...rest.reverse());
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return target;
      rest.push(path.basename(current));
      current = parent;
    }
  }
}
