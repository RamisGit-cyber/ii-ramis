// Согласие на пересказы сессий даётся в чате, а фиксирует его ХУК UserPromptSubmit (consent-hook.mjs), не Claude.
// Хук видит настоящий текст, который набрал ученик, и сам пишет share=true в config.json. Claude эту запись сделать не может:
// `config.mjs set share true` запрещён ему полностью (checkConsentCommand), а ~/.ii-ramis защищена от записи.
// Условия согласия: (1) наставник перед вопросом поставил одноразовый флаг consent_asked, (2) если историю сессии
// можно прочитать, последний ход ассистента состоит ровно из вопроса CONSENT_QUESTION (единственный текстовый блок),
// (3) ответ ученика целиком «да», «yes», «ок» или «согласен». Флаг гасится при ЛЮБОМ следующем сообщении ученика.
import fs from 'node:fs';
import { CONFIG_FILE, readJson } from './lib.mjs';

export const CONSENT_QUESTION = 'Можно отправлять Рамису короткий пересказ твоих занятий (без кода и паролей), чтобы он видел, где тебе помочь? да/нет';

const READ_TAIL_BYTES = 1024 * 1024;
const YES_ANSWER = /^\s*(?:да|yes|ок|окей|ok|okay|согласен|согласна)[\s.!)]*$/iu;
const NO_ANSWER = /^\s*(?:нет|no|не надо|не хочу|не согласен|не согласна|не отправляй)[\s.!)]*$/iu;
const SHARE_ON_REASON = 'включать отправку пересказов Claude не может совсем: согласие фиксирует защитный хук, когда ученик сам ответил «да» на твой вопрос. ' +
  `Задай вопрос слово в слово («${CONSENT_QUESTION}») отдельным сообщением, перед этим выполни set consent_asked true, и жди ответа. Команду set share true не повторяй`;
const NAME_REASON = 'записать имя можно только после того, как ученик согласился на пересказы (share включён хуком по его явному «да»)';

const normalize = (text) => String(text).replace(/\s+/g, ' ').trim();
const QUESTION_NORMALIZED = normalize(CONSENT_QUESTION);

const configTokenAt = (tokens) => tokens.findIndex((t) => /(^|[\\/])config\.mjs$/i.test(String(t).replace(/['"]/g, '')));
export function isShareOn(tokens) {
  const at = configTokenAt(tokens);
  return at !== -1 && tokens[at + 1] === 'set' && tokens[at + 2] === 'share' && String(tokens[at + 3]).toLowerCase() !== 'false';
}
export function isStudentNameSet(tokens) {
  const at = configTokenAt(tokens);
  return at !== -1 && tokens[at + 1] === 'set' && tokens[at + 2] === 'student_name';
}

export const answerIsYes = (text) => typeof text === 'string' && text.length <= 40 && YES_ANSWER.test(text);
export const answerIsNo = (text) => typeof text === 'string' && text.length <= 40 && NO_ANSWER.test(text);

function blocksOf(entry) {
  const content = entry?.message?.content;
  return Array.isArray(content) ? content : typeof content === 'string' ? [{ type: 'text', text: content }] : [];
}
const stripReminders = (text) => String(text).replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, ' ').trim();
const SERVICE_ENTRY = (entry) => entry?.isMeta || entry?.isSidechain || entry?.isCompactSummary || entry?.isVisibleInTranscriptOnly;
function studentText(entry) {
  if (entry?.type !== 'user' || SERVICE_ENTRY(entry)) return null;
  const blocks = blocksOf(entry);
  if (blocks.some((b) => b.type === 'tool_result')) return null;
  const text = stripReminders(blocks.filter((b) => b.type === 'text').map((b) => b.text || '').join(' '));
  return text || null;
}

function readTailEntries(transcriptPath) {
  const size = fs.statSync(transcriptPath).size;
  const start = Math.max(0, size - READ_TAIL_BYTES);
  const fd = fs.openSync(transcriptPath, 'r');
  let raw;
  try {
    const buffer = Buffer.alloc(size - start);
    fs.readSync(fd, buffer, 0, buffer.length, start);
    raw = buffer.toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
  const entries = [];
  for (const line of raw.split('\n').filter(Boolean)) {
    try { entries.push(JSON.parse(line)); } catch { /* обрезанная первая строка хвоста */ }
  }
  return entries;
}

// Тексты последнего хода ассистента (все текстовые блоки подряд до предыдущего настоящего сообщения ученика).
// Запись о текущем сообщении ученика (prompt) может уже лежать в истории: тогда пропускаем её.
export function lastAssistantTurnTexts(entries, prompt) {
  let index = entries.length - 1;
  const current = studentText(entries[index]);
  if (current !== null && normalize(current) === normalize(prompt)) index -= 1;
  const texts = [];
  for (; index >= 0; index -= 1) {
    const entry = entries[index];
    if (studentText(entry) !== null) break; // дошли до предыдущего сообщения ученика
    if (entry?.type !== 'assistant' || entry.isSidechain) continue;
    for (const block of blocksOf(entry).slice().reverse()) {
      if (block.type === 'text' && normalize(block.text || '')) texts.unshift(normalize(block.text));
    }
  }
  return texts;
}

// 'yes' — последний ход ассистента ровно вопрос; 'no' — там что-то другое; 'unreadable' — историю прочитать не удалось.
export function questionJustAsked(transcriptPath, prompt) {
  if (!transcriptPath || typeof transcriptPath !== 'string') return 'unreadable';
  try {
    const texts = lastAssistantTurnTexts(readTailEntries(transcriptPath), prompt);
    return texts.length === 1 && texts[0] === QUESTION_NORMALIZED ? 'yes' : 'no';
  } catch {
    return 'unreadable';
  }
}

// Решение хука UserPromptSubmit. config: текущий config.json. Возвращает { patch } для config.json или null (ничего не менять).
// Флаг consent_asked одноразовый: гасится при любом сообщении ученика.
export function decideConsent({ config, prompt, transcriptPath }) {
  if (config.consent_asked !== true) return null;
  const patch = { consent_asked: false };
  const verdict = questionJustAsked(transcriptPath, prompt);
  if (verdict === 'no') return { patch }; // вопрос не был последним ходом: ответ относится не к нему
  if (answerIsYes(prompt)) return { patch: { ...patch, share: true, share_asked: true } };
  if (answerIsNo(prompt)) return { patch: { ...patch, share: false, share_asked: true } };
  return { patch };
}

// Имя можно записать только когда share уже включён хуком.
export function nameMayBeSet() {
  return readJson(CONFIG_FILE, {}).share === true;
}

// Команды Claude: share=true запрещён всегда; student_name только при включённом share.
export function checkConsentCommand(commands) {
  for (const cmd of commands) {
    if (isShareOn(cmd.tokens)) return SHARE_ON_REASON;
    if (isStudentNameSet(cmd.tokens) && !nameMayBeSet()) return NAME_REASON;
  }
  return null;
}
