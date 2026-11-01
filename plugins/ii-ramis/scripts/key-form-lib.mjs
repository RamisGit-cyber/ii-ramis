// Проверки и запись для key-form.mjs: имена и значения переменных, файл ключей проекта, .gitignore, .env.example.
// Значения ключей здесь только пишутся в файл; наружу (в stdout, ошибки, логи) они не выходят никогда.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const NAME_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;
export const MAX_VALUE_LENGTH = 2048;
// Публичные префиксы фреймворков: всё с таким началом попадает в браузер, секрету там не место.
const PUBLIC_PREFIXES = ['NEXT_PUBLIC_', 'VITE_', 'PUBLIC_', 'EXPO_PUBLIC_', 'NUXT_PUBLIC_', 'REACT_APP_', 'GATSBY_', 'VUE_APP_', 'NG_APP_', 'PLASMO_PUBLIC_', 'SANITY_STUDIO_', 'STORYBOOK_'];
// Публичное имя с такими словами почти наверняка секрет, который утёк бы в браузер сайта (кроме публичных publishable / anon ключей).
const SECRET_WORDS = /SECRET|SERVICE_ROLE|PRIVATE|PASSW|TOKEN|(?<!PUBLISHABLE|ANON)_KEY$/;
// Переменные, которыми можно подменить запуск программ: в форму ключей им не место.
const FORBIDDEN_NAMES = new Set(['PATH', 'HOME', 'SHELL', 'USER', 'PWD', 'IFS', 'TMPDIR', 'BASH_ENV', 'ENV', 'BROWSER', 'EDITOR', 'VISUAL', 'PAGER', 'NO_PROXY', 'SSL_CERT_FILE', 'CURL_CA_BUNDLE']);
const FORBIDDEN_PREFIXES = ['LD_', 'DYLD_', 'NODE_', 'NPM_', 'BASH_', 'GIT_', 'VERCEL_', 'PYTHON', 'RUBY', 'PERL', 'JAVA_', 'SSL_', 'CURL_'];

export class FormError extends Error {}

export function isPublicName(name) {
  return PUBLIC_PREFIXES.some((prefix) => name.startsWith(prefix));
}

export function checkNames(plain, secret) {
  const all = [...plain, ...secret];
  if (all.length === 0) throw new FormError('нужно указать хотя бы одну переменную в --vars или --secret');
  if (all.length > 20) throw new FormError('слишком много переменных за один раз (максимум 20)');
  for (const name of all) {
    if (!NAME_PATTERN.test(name)) throw new FormError('недопустимое имя переменной: разрешены заглавные латинские буквы, цифры и _ (значения ключей в команду не передаются)');
    if (FORBIDDEN_NAMES.has(name) || /_PROXY$/.test(name) || FORBIDDEN_PREFIXES.some((p) => name.startsWith(p))) throw new FormError(`имя ${name} зарезервировано системой`);
  }
  if (new Set(all).size !== all.length) throw new FormError('одно и то же имя указано дважды');
  for (const name of all) {
    if (isPublicName(name) && SECRET_WORDS.test(name) && !secret.includes(name)) throw new FormError(`${name} похоже на секрет, но имя публичное: оно попадёт в браузер сайта. Дай секрету имя без публичного префикса и укажи его через --secret`);
    if (isPublicName(name) && SECRET_WORDS.test(name)) throw new FormError(`${name}: секретное значение с публичным префиксом попадёт в браузер сайта`);
  }
  for (const name of secret) {
    if (isPublicName(name)) throw new FormError(`секретная переменная ${name} не может иметь публичный префикс: такие значения попадают в браузер сайта`);
  }
}

// Возвращает текст ошибки по-русски или null, если значение подходит.
export function checkValue(name, rawValue) {
  if (typeof rawValue !== 'string') return 'значение не пришло';
  const value = rawValue.trim();
  if (value.length === 0) return 'поле пустое';
  if (value.length > MAX_VALUE_LENGTH) return 'слишком длинное значение';
  if (/[\r\n\0]/.test(value)) return 'внутри не должно быть переводов строки';
  if (/\s/.test(value)) return 'внутри не должно быть пробелов (проверь, что скопировал одно значение целиком)';
  if (/["'`\\$]/.test(value)) return 'внутри не должно быть кавычек, обратной косой черты и знака $ (скопируй значение без кавычек)';
  if (!/^[A-Za-z0-9._~+/=:@%,!-]+$/.test(value)) return 'допустимы латинские буквы, цифры и знаки . _ ~ + / = : @ % , ! - (проверь, что скопировал значение целиком и без лишнего)';
  if (/_URL$/.test(name)) {
    let url;
    try { url = new URL(value); } catch { return 'это не похоже на адрес, он должен начинаться с https://'; }
    if (url.protocol !== 'https:') return 'адрес должен начинаться с https://';
    if (!url.hostname || url.username || url.password) return 'адрес указан неверно';
  }
  return null;
}

const HOME = os.homedir();
const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function realOrSelf(target) {
  try { return fs.realpathSync(target); } catch { return path.resolve(target); }
}

function isInside(child, parent) {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

// Папка проекта: существующая, не домашняя, не корень, не папка Claude Code / плагина / конфига ИИ Рамис.
export function resolveProject(rawProject) {
  if (!rawProject) throw new FormError('нужно указать --project <папка проекта>');
  const resolved = realOrSelf(path.resolve(rawProject));
  let stat;
  try { stat = fs.statSync(resolved); } catch { throw new FormError('папка проекта не найдена'); }
  if (!stat.isDirectory()) throw new FormError('--project должен быть папкой');
  const dataDir = process.env.IIRAMIS_HOME || path.join(HOME, '.ii-ramis');
  const forbidden = [path.join(HOME, '.claude'), path.join(HOME, '.ii-ramis'), dataDir, PLUGIN_ROOT, realOrSelf(PLUGIN_ROOT), path.join(HOME, '.ssh'), path.join(HOME, '.aws'), path.join(HOME, '.gnupg'), path.join(HOME, '.config'), path.join(HOME, 'Library')];
  if (forbidden.some((dir) => isInside(resolved, dir))) throw new FormError('в эту папку ключи класть нельзя: выбери папку своего проекта');
  const looksLikeProject = ['package.json', '.git', '.vercel', 'next.config.js', 'next.config.mjs', 'next.config.ts', 'index.html'].some((marker) => fs.existsSync(path.join(resolved, marker)));
  if (!looksLikeProject) throw new FormError('это не похоже на папку проекта (нет package.json, .git или index.html): укажи папку сайта');
  if (resolved === path.parse(resolved).root || resolved === HOME || realOrSelf(HOME) === resolved) throw new FormError('укажи папку проекта, а не домашнюю папку или корень диска');
  return resolved;
}

function writeFileAtomic(target, text, mode) {
  try {
    if (fs.lstatSync(target).isSymbolicLink()) throw new FormError(`${path.basename(target)} — ссылка на другой файл, писать в неё не буду`);
  } catch (error) {
    if (error instanceof FormError) throw error;
    if (error.code !== 'ENOENT') throw error;
  }
  // Случайное имя и 'wx' (O_EXCL): заранее подложенная ссылка с таким именем не сработает.
  const temporary = path.join(path.dirname(target), `.${path.basename(target)}.${crypto.randomBytes(8).toString('hex')}.tmp`);
  try {
    fs.writeFileSync(temporary, text, { mode, flag: 'wx' });
    if (process.platform !== 'win32') fs.chmodSync(temporary, mode);
    fs.renameSync(temporary, target);
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    throw error;
  }
}

function readIfExists(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch (error) {
    if (error.code === 'ENOENT') return '';
    throw error;
  }
}

function eolOf(text) {
  return text.includes('\r\n') ? '\r\n' : '\n';
}

// Заменяет (или добавляет) только указанные переменные, остальные строки остаются как были.
export function mergeEnvText(existing, values) {
  const eol = eolOf(existing);
  const lines = existing === '' ? [] : existing.split(/\r?\n/);
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  const pending = new Map(Object.entries(values));
  const result = [];
  const written = new Set();
  for (const line of lines) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    if (match && Object.hasOwn(values, match[1])) {
      if (!written.has(match[1])) { result.push(`${match[1]}=${values[match[1]]}`); written.add(match[1]); }
      pending.delete(match[1]);
      continue;
    }
    result.push(line);
  }
  for (const [name, value] of pending) result.push(`${name}=${value}`);
  return result.join(eol) + eol;
}

export const ENV_FILE_NAME = '.env' + '.local';

export function writeEnvFile(project, values) {
  const target = path.join(project, ENV_FILE_NAME);
  writeFileAtomic(target, mergeEnvText(readIfExists(target), values), 0o600);
}

// Файлы ключей закрыты от git, файл с примером остаётся в репозитории.
export function ensureGitignore(project) {
  const target = path.join(project, '.gitignore');
  const existing = readIfExists(target);
  const eol = eolOf(existing);
  const rules = existing.split(/\r?\n/).map((line) => line.trim());
  const additions = [];
  if (!rules.includes('.env*')) additions.push('.env*');
  if (!rules.includes('!.env.example')) additions.push('!.env.example');
  if (additions.length === 0) return false;
  const separator = existing === '' || existing.endsWith('\n') ? '' : eol;
  const header = existing === '' ? '' : eol;
  writeFileAtomic(target, `${existing}${separator}${header}# ключи и пароли: только на компьютере, в git не попадают${eol}${additions.join(eol)}${eol}`, 0o644);
  return true;
}

// Только имена без значений, чтобы было видно, какие переменные нужны проекту.
export function ensureEnvExample(project, names) {
  const target = path.join(project, '.env.example');
  const existing = readIfExists(target);
  const present = new Set(existing.split(/\r?\n/).map((line) => line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/)?.[1]).filter(Boolean));
  const missing = names.filter((name) => !present.has(name));
  if (missing.length === 0) return false;
  const eol = eolOf(existing);
  const separator = existing === '' || existing.endsWith('\n') ? '' : eol;
  writeFileAtomic(target, `${existing}${separator}${missing.map((name) => `${name}=`).join(eol)}${eol}`, 0o644);
  return true;
}
