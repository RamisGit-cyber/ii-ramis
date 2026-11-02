// Общие функции хуков «ИИ Рамис». Только стандартная библиотека Node, без npm.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

export const DATA_DIR = process.env.IIRAMIS_HOME || path.join(os.homedir(), '.ii-ramis');
export const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
export const PROGRESS_FILE = path.join(DATA_DIR, 'progress.jsonl');
export const STATE_FILE = path.join(DATA_DIR, 'state.json');
// Короткий пересказ текущей сессии: пишет ИИ Рамис, session-end чистит, прогоняет через redact и отправляет (если ученик согласился).
export const RECAP_FILE = path.join(DATA_DIR, 'recap.txt');
export const RECAP_MAX_CHARS = 400;
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
  // через временный файл и rename: оборванная запись не оставит наполовину записанный JSON
  const temp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(temp, file);
  } catch (error) {
    fs.rmSync(temp, { force: true });
    throw error;
  }
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
  String.raw`\.ii-ramis[/\\]consent\.json`, // хеш одноразового кода согласия (перебирается, поэтому файл закрыт для чтения целиком)
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

// Файлы запуска оболочки и истории команд: в них прячут автозапуск и подсматривают чужие команды и пароли.
// Читать и писать их через Claude нельзя. Отдельный список: автосохранение (session-start) на него не смотрит.
const STARTUP_PATTERN = new RegExp(
  START + String.raw`\.(?:z(?:sh[\w.-]*|profile|login|logout|env)|bash[\w.-]*|profile|[\w-]*_history|viminfo|lesshst)` + END + '|' +
  String.raw`fish[/\\](?:config\.fish|fish_history)|\.local[/\\]share[/\\]fish|` +
  String.raw`(?:Microsoft\.)?PowerShell_profile\.ps1|ConsoleHost_history\.txt|PSReadLine`,
  'i',
);
const STARTUP_DOTFILES = [
  '.zshrc', '.zsh_history', '.zprofile', '.zshenv', '.zlogin', '.bashrc', '.bash_profile', '.bash_history', '.bash_login',
  '.profile', '.python_history', '.node_repl_history', '.psql_history',
];

export function tokenMentionsShellStartup(token) {
  try {
    return expandBraces(token).some((variant) => {
      const plain = variant.replace(/['"]/g, '');
      if (STARTUP_PATTERN.test(' ' + variant + ' ') || STARTUP_PATTERN.test(' ' + plain + ' ')) return true;
      const name = plain.split(/[/\\]/).pop();
      return name.startsWith('.') && /[*?[]/.test(name) && STARTUP_DOTFILES.some((file) => globToRegex(name).test(file));
    });
  } catch {
    return true; // не смогли разобрать: считаем подозрительным
  }
}

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

// Только прямое имя секретного файла, без шаблонов со звёздочкой: для Glob, который лишь перечисляет имена файлов и содержимое не читает.
export function tokenNamesSecret(token) {
  try {
    return expandBraces(token).some((variant) => mentionsSecretPath(variant));
  } catch {
    return true;
  }
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
// Буквы любых алфавитов (\p{L}, флаг u) и пробелы внутри путей: «/Users/айбек/Проекты» и «C:\Users\Айбек Сапаров\...» тоже уходят.
// Лишнее лучше вычистить, чем оставить: путь с пробелами съедает хвост до кавычки или двоеточия.
const NAME_CHARS = String.raw`[\p{L}\p{N}_.@+~-]`;
const SECRET_VALUE = new RegExp(
  String.raw`(?<![\p{L}\p{N}_])(?:api[_-]?key|apikey|access[_-]?key|secret|token|password|passwd|pwd|authorization|key|пароль|ключ|токен|секрет)(?![\p{L}\p{N}])\s*(?:[:=]|is\b)\s*(?:"[^"]*"|'[^']*'|\S+)`,
  'giu',
);
const WINDOWS_PATH = /[A-Za-z]:\\[^\n'"`:*?<>|]*/g;
const UNC_PATH = /\\\\[^\n'"`:*?<>|]+/g;
const HOME_PATH = /\/(?:Users|home|Volumes|mnt|root|private|var|tmp|opt)(?=\/)[^\n'"`:;()<>|*?]*/giu;
const TILDE_PATH = /~[/\\][^\n'"`:;()<>|*?]*/gu;
const ABSOLUTE_PATH = new RegExp(String.raw`(?<!${NAME_CHARS})(?:/${NAME_CHARS}+){2,}`, 'gu');
const RELATIVE_PATH = new RegExp(String.raw`(?:${NAME_CHARS}+[/\\]){2,}${NAME_CHARS}+`, 'gu');
// Телефон: цифры с пробелами, скобками, дефисами (от 7 символов подряд). Для пересказа сессии это отдельный шаг.
const PHONE_LIKE = /\+?\d[\d\s().\u2010-\u2015-]{5,}\d/g;
// Режим пересказа (summary): короткие числа («урок 4») остаются, телефоны и длинные числа вычищаются.
export function redact(text, maxLength = 100, { summary = false } = {}) {
  const prepared = summary ? String(text).replace(PHONE_LIKE, '<phone>') : String(text);
  const cleaned = prepared
    .replace(SECRET_VALUE, '<secret>')
    .replace(/\bBearer\s+\S+/gi, '<secret>')
    .replace(WINDOWS_PATH, '<path>')
    .replace(UNC_PATH, '<path>')
    .replace(HOME_PATH, '<path>')
    .replace(TILDE_PATH, '<path>')
    .replace(ABSOLUTE_PATH, '<path>')
    .replace(RELATIVE_PATH, '<path>')
    .replace(/[\p{L}\p{N}._+-]+@[\p{L}\p{N}-]+\.[\p{L}\p{N}.-]+/gu, '<email>')
    .replace(/\b(sk|pk|ghp|gho|xox[a-z]|eyJ)[\w-]{8,}/g, '<key>')
    .replace(/\b[A-Za-z0-9_-]{24,}\b/g, '<token>')
    .replace(summary ? /\d{5,}/g : /\d+/g, 'N')
    .replace(/\s+/g, ' ')
    .trim();
  return Array.from(cleaned).slice(0, maxLength).join(''); // по символам: пару-суррогат (эмодзи) не режем пополам
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
