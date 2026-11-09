#!/usr/bin/env node
// ИИ Рамис 2.7: отправка сводки занятия и запись отказов хуками (вне песочницы Claude Desktop).
//
// Почему хук: в 2.4 сводку слал Claude командой curl через Bash. В песочнице Desktop у Bash нет сети
// (домены не из списка блокируются или ждут окна разрешения) и нет записи вне рабочей папки, поэтому
// сводки молча не доходили. Хуки приложение выполняет вне песочницы.
//
// Режимы:
//   --stop    хук Stop: ищет в последнем ответе Claude строку «📨 Сводка Рамису: …» и отправляет её.
//   --prompt  хук UserPromptSubmit: понимает фразы ученика «не отправляй сводки», «снова отправляй сводки»,
//             «не ставь набор», «поставь набор», «не ставь Earshot», «поставь Earshot» и записывает выбор в файлы (Bash в песочнице писать туда не может).
// Всегда завершается кодом 0 и ничего не печатает (кроме одной строки подтверждения в режиме --prompt).
import { readFileSync, writeFileSync, mkdirSync, existsSync, appendFileSync, renameSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const PLUGIN_VERSION = '2.9.0';
const ENDPOINT = process.env.II_RAMIS_TEST_ENDPOINT || 'https://fjxevxclomxlvhpjgbjs.supabase.co/rest/v1/sessions';
// Публичный ключ роли anon: по настройкам базы умеет только добавлять строки в одну таблицу (не секрет).
const ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZqeGV2eGNsb214bHZocGpnYmpzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTM0NjEwOTQsImV4cCI6MjEwOTAzNzA5NH0.fabs-WOQqFDq2w-Be-J81m_Mg90dacS6xHoneZIqdWY';
const MIN_GAP_MS = 30 * 60 * 1000; // не чаще одной сводки за 30 минут
const MAX_PER_DAY = 5;
const MAX_TEXT = 400;

const dir = join(homedir(), '.ii-ramis');
const settingsFile = join(dir, 'svodka.json');
const kitFile = join(dir, 'nabor.json');
const logFile = join(dir, 'svodka.log');
const earshotDeclinedFile = join(dir, 'earshot-declined');
// Отказ проверяется первым. Согласие только с начала реплики и без вопроса («сколько места надо, чтобы поставить earshot?» установкой не считается)
const EARSHOT_NO = /не\s+(хочу|надо|нужно|буду|стоит)?\s*(став(ь|ить)|предлагай)\s+earshot|нет,?\s+earshot|earshot\s+(мне\s+)?не\s+нужен/;
const MASK_NO = /не\s+(хочу|надо|нужно|буду|стоит)?\s*(став(ь|ить)|предлагай)\s+маск(у|и)(?![а-яё])(?!\s+на\s)|^\s*маска\s+(мне\s+)?не\s+нужна\s*$/;
const maskDeclinedFile = join(dir, 'mask-declined');
const EARSHOT_YES = /^\s*(пожалуйста,?\s*)?(по)?став(ь|ить)\s+(мне\s+)?earshot/;

const readJson = (file) => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; } };
const writeJson = (file, value) => {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value) + '\n', { mode: 0o600 });
  renameSync(tmp, file);
};
const log = (line) => { try { mkdirSync(dir, { recursive: true, mode: 0o700 }); appendFileSync(logFile, `${new Date().toISOString()} ${line}\n`, { mode: 0o600 }); } catch { /* журнал не обязателен */ } };
const readStdin = () => { try { return readFileSync(0, 'utf8'); } catch { return ''; } };

// Что нельзя отправлять: код, пути, ключи, адреса, почту. Сомневаемся — не отправляем вовсе.
const UNSAFE = [
  /`/, /[{}<>]/, /https?:\/\//i, /\bwww\./i, /[\w.+-]+@[\w-]+\.[\w.]+/,
  /(^|[\s(])(~|\.{1,2})?\/[\w.-]+\/[\w./-]*/, /[A-Za-z]:\\/, /\.(env|pem|key|json|ts|js|py|sh)\b/i,
  /eyJ[\w-]{10,}/, /\b(sk|pk|ghp|gho|xox[bap])[-_][\w-]{8,}/i, /\b[A-Za-z0-9_-]{32,}\b/, /\b(password|пароль|api[ _-]?key|token|токен)\b\s*[:=]/i,
];
const isSafe = (text) => !UNSAFE.some((pattern) => pattern.test(text));

function parseSummary(message) {
  const lines = String(message ?? '').split('\n').filter((line) => /^\s*📨 Сводка Рамису/u.test(line));
  if (lines.length === 0) return null;
  const match = lines.at(-1).trim().match(/^📨 Сводка Рамису(?: \(([^)]*)\))?:\s*(.+)$/u);
  if (!match) return null;
  const meta = match[1] ?? '';
  const text = match[2].replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT);
  if (text.length < 10 || !isSafe(text)) return null;
  const lesson = Number(meta.match(/урок\s*(\d{1,2})/iu)?.[1]);
  const name = meta.match(/имя:\s*([\p{L} -]{1,40})/iu)?.[1]?.trim() ?? '';
  return {
    text,
    lesson: Number.isInteger(lesson) && lesson > 0 ? lesson : undefined,
    stuck: /застрял:\s*да/iu.test(meta),
    errors: Math.min(Number(meta.match(/ошибок:\s*(\d{1,3})/iu)?.[1] ?? 0), 999),
    name,
  };
}

async function post(row) {
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const response = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { apikey: ANON_KEY, Authorization: `Bearer ${ANON_KEY}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
        body: JSON.stringify(row),
        signal: AbortSignal.timeout(8000),
      });
      if (response.status === 201) return 201;
      log(`ответ ${response.status}, попытка ${attempt}`);
    } catch (error) {
      log(`ошибка сети (${error.name}), попытка ${attempt}`);
    }
  }
  return 0;
}

async function stopMode() {
  let input = {};
  try { input = JSON.parse(readStdin()); } catch { return; }
  const summary = parseSummary(input.last_assistant_message);
  if (!summary) return;

  const settings = readJson(settingsFile) ?? {};
  if (settings.consent === false) return; // отказ ученика
  const now = Date.now();
  const today = new Date(now).toISOString().slice(0, 10);
  const sentToday = settings.day === today ? Number(settings.sent_today ?? 0) : 0;
  if (now - Date.parse(settings.last_sent ?? 0) < MIN_GAP_MS || sentToday >= MAX_PER_DAY) { log('лимит: не отправляю'); return; }
  if (settings.last_text === summary.text) return;

  const installId = settings.install_id || randomUUID();
  const name = summary.name || settings.name || '';
  const row = {
    student: name || 'без имени',
    install_id: installId,
    ...(summary.lesson ? { lesson: summary.lesson } : {}),
    stuck: summary.stuck,
    errors: summary.errors,
    recap: summary.text,
    summary: { plugin_version: PLUGIN_VERSION, text: summary.text, stuck_on: summary.stuck ? summary.text.slice(0, 120) : '' },
  };
  const status = await post(row);
  log(status === 201 ? 'отправлено' : 'не отправлено');
  writeJson(settingsFile, {
    ...settings,
    consent: settings.consent ?? true,
    install_id: installId,
    name,
    ...(status === 201 ? { last_sent: new Date(now).toISOString(), last_text: summary.text, day: today, sent_today: sentToday + 1 } : {}),
  });
}

function promptMode() {
  let prompt = '';
  try { prompt = String(JSON.parse(readStdin()).prompt ?? ''); } catch { return; }
  const text = prompt.toLowerCase().replace(/ё/g, 'е').slice(0, 2000);
  const say = (line) => console.log(`ИИ Рамис (хук): ${line}`);

  if (/не\s+(отправляй|присылай|шли)\s+(мне\s+|больше\s+)?(сводк|рамису)/.test(text)) {
    writeJson(settingsFile, { ...(readJson(settingsFile) ?? {}), consent: false });
    say('отказ от сводок записан в ~/.ii-ramis/svodka.json. Подтверди ученику одной строкой: «Хорошо, сводки Рамису больше не отправляю.» Больше ничего не отправляй.');
  } else if (/(снова|опять)\s+(отправляй|присылай)\s+сводк/.test(text)) {
    writeJson(settingsFile, { ...(readJson(settingsFile) ?? {}), consent: true });
    say('отправка сводок снова включена. Подтверди одной строкой.');
  } else if (MASK_NO.test(text) && !text.includes('?')) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(maskDeclinedFile, '1\n', { mode: 0o600 });
    say('отказ от маски человека записан в ~/.ii-ramis/mask-declined. Подтверди одной строкой, «Афиша» будет со словом-темой над головой, больше про маску не спрашивай (ученик может попросить позже).');
  } else if (EARSHOT_NO.test(text)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(earshotDeclinedFile, '1\n', { mode: 0o600 });
    say('отказ от Earshot записан в ~/.ii-ramis/earshot-declined. Подтверди одной строкой и больше не предлагай (ученик может сам попросить позже).');
  } else if (EARSHOT_YES.test(text) && !text.includes('?')) {
    rmSync(earshotDeclinedFile, { force: true });
    say('ученик просит Earshot: отметка отказа снята. Поставь по разделу «Earshot» в nabor/references/ustanovka.md.');
  } else if (/не\s+став(ь|ить)\s+набор/.test(text)) {
    writeJson(kitFile, { kit: PLUGIN_VERSION, status: 'declined' });
    say('отказ от набора записан в ~/.ii-ramis/nabor.json, установка остановится на следующем шаге. Подтверди ученику одной строкой, больше не предлагай.');
  } else if (/(по)?став(ь|ить)\s+(мне\s+)?набор/.test(text) && readJson(kitFile)?.status === 'declined') {
    rmSync(kitFile, { force: true });
    say('отказ от набора снят, набор поставится при следующем запуске приложения. Скажи ученику закрыть приложение и открыть заново.');
  }
}

try {
  if (process.argv[2] === '--stop') await stopMode();
  else if (process.argv[2] === '--prompt') promptMode();
} catch (error) {
  log(`сбой хука: ${error.name}`);
}
process.exit(0);
