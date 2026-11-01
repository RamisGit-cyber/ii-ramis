// Отправка сводок сессий в Supabase (таблица public.sessions, anon умеет только INSERT).
// Только при согласии ученика (config.share === true). Любая ошибка тихая: запись остаётся в progress.jsonl
// и уходит при следующей сессии (до 20 штук за раз). Через node fetch, не curl.
import fs from 'node:fs';
import { PROGRESS_FILE, STATE_FILE, RECAP_MAX_CHARS, readJson, writeJson, redact } from './lib.mjs';
import { REPORT_URL, ANON_KEY } from './report-config.mjs';

const MAX_PER_RUN = 20;
const REQUEST_TIMEOUT_MS = 5000;
const TOTAL_BUDGET_MS = 10000; // SessionEnd живёт 15 секунд
const MAX_SUMMARY_BYTES = 8 * 1024;
const INSTALL_ID = /^[A-Za-z0-9_-]{8,64}$/;
const REJECTED_FOR_GOOD = new Set([400, 409, 422]); // строка не пройдёт никогда: не держим очередь

const clamp = (value, min, max) => Math.min(max, Math.max(min, Math.trunc(Number(value) || 0)));

// Что именно уходит в сводку: только счётчики и обезличенные подписи ошибок (их чистит session-end.redact).
function buildSummary(record) {
  const summary = {
    prompts: record.prompts, duration_min: record.duration_min, end_reason: record.end_reason,
    categories: record.categories, files_edited: record.files_edited, file_types: record.file_types,
    asked_user: record.asked_user, self_done: record.self_done, stuck_on: record.stuck_on,
    errors: record.errors, tools: record.tools,
  };
  for (const droppable of [null, 'tools', 'file_types', 'errors']) {
    if (droppable) delete summary[droppable];
    if (Buffer.byteLength(JSON.stringify(summary)) <= MAX_SUMMARY_BYTES) return summary;
  }
  return null;
}

// recap чистим ещё раз при отправке: progress.jsonl лежит на диске и мог быть изменён после session-end.
function recapField(value) {
  const clean = typeof value === 'string' ? redact(value, RECAP_MAX_CHARS, { summary: true }) : '';
  return clean ? { recap: clean } : {};
}

export function resolveReportUrl(override) {
  return override && /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(override) ? override : REPORT_URL;
}

export function buildRow(record, config) {
  if (!INSTALL_ID.test(String(config.install_id || ''))) return null;
  const summary = buildSummary(record);
  if (!summary) return null;
  const name = String(config.student_name || '').trim().slice(0, 80) || 'без имени';
  const errorCount = (record.errors || []).reduce((sum, item) => sum + (Number(item.count) || 0), 0);
  return {
    student: name,
    install_id: config.install_id,
    lesson: clamp(record.lesson, 0, 20),
    os: String(record.os || 'unknown').slice(0, 20),
    stuck: record.stuck === true,
    errors: clamp(errorCount, 0, 1000),
    summary,
    ...recapField(record.recap),
  };
}

// Колонки recap может ещё не быть в базе (миграция применяется отдельно): тогда сервер отвечает 400.
// Не теряем запись, а шлём ту же строку без пересказа.
async function post(url, row, timeoutMs) {
  const result = await postOnce(url, row, timeoutMs);
  if (result === 'drop' && row.recap !== undefined) {
    const { recap, ...withoutRecap } = row;
    return postOnce(url, withoutRecap, timeoutMs);
  }
  return result;
}

async function postOnce(url, row, timeoutMs) {
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        apikey: ANON_KEY,
        Authorization: `Bearer ${ANON_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal',
      },
      body: JSON.stringify(row),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.ok) return 'sent';
    return REJECTED_FOR_GOOD.has(response.status) ? 'drop' : 'retry';
  } catch {
    return 'retry'; // нет сети, таймаут, сервер лежит: молча, попробуем в следующий раз
  }
}

// Отправляет накопленные записи по порядку. Прогресс хранится в state.json (sentLines).
// Записи, сделанные без согласия, пропускаются и не уходят никогда, даже если согласие дали позже.
export async function flushQueue(config) {
  if (config.share !== true || !fs.existsSync(PROGRESS_FILE)) return;
  // подмена адреса только для тестов и только на локальный сервер: чужой адрес из окружения проекта не принимаем
  const url = resolveReportUrl(process.env.IIRAMIS_REPORT_URL);
  const lines = fs.readFileSync(PROGRESS_FILE, 'utf8').split('\n').filter(Boolean);
  const state = readJson(STATE_FILE, {});
  let position = Math.min(Number(state.sentLines) || 0, lines.length);
  const deadline = Date.now() + TOTAL_BUDGET_MS;
  let sent = 0;
  const remember = () => writeJson(STATE_FILE, { ...readJson(STATE_FILE, {}), sentLines: position });

  while (position < lines.length && sent < MAX_PER_RUN) {
    let record = null;
    try { record = JSON.parse(lines[position]); } catch { /* битая строка: пропускаем */ }
    const row = record && record.consent === true ? buildRow(record, config) : null;
    if (!row) { position += 1; continue; }
    const timeLeft = deadline - Date.now();
    if (timeLeft < 500) break;
    const result = await post(url, row, Math.min(REQUEST_TIMEOUT_MS, timeLeft));
    if (result === 'retry') break;
    position += 1;
    if (result === 'sent') sent += 1;
    remember();
  }
  remember();
}
