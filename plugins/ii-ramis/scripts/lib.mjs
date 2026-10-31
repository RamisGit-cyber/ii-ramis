// Общие функции хуков «ИИ Рамис». Только стандартная библиотека Node, без npm.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

export const DATA_DIR = process.env.IIRAMIS_HOME || path.join(os.homedir(), '.ii-ramis');
export const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
export const PROGRESS_FILE = path.join(DATA_DIR, 'progress.jsonl');
export const STATE_FILE = path.join(DATA_DIR, 'state.json');
export const APPROVALS_FILE = path.join(DATA_DIR, 'approvals.json');

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
  if (existing && existing.student_id) return existing;
  const created = {
    student_id: crypto.randomUUID(),
    share: false,
    lesson: null,
    autosave: true,
    ...(existing || {}),
  };
  if (!created.student_id) created.student_id = crypto.randomUUID();
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

// Одинаковая нормализация команды в хуке и в approve.mjs
export function normalizeCommand(command) {
  return String(command).replace(/\s+/g, ' ').trim();
}

export function commandHash(command) {
  return crypto.createHash('sha256').update(normalizeCommand(command)).digest('hex');
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
