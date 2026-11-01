// Согласие на пересказы сессий даётся в чате. Строгая проверка (fail closed): `config.mjs set share true` проходит, только если
//   1) в истории сессии прямо перед ответом ученика стоит сообщение ассистента с ТОЧНЫМ вопросом CONSENT_QUESTION,
//   2) ответ ученика (его последнее настоящее сообщение) это целиком «да», «yes», «ок» или «согласен», без добавок,
//   3) история сессии (transcript_path) есть и читается.
// Это сетка, а не стена: кто умеет подделать историю сессии, это обойдёт. Главное правило остаётся в навыке ii-ramis.
import fs from 'node:fs';
import { CONFIG_FILE, readJson } from './lib.mjs';

export const CONSENT_QUESTION = 'Можно отправлять Рамису короткий пересказ твоих занятий (без кода и паролей), чтобы он видел, где тебе помочь? да/нет';

const READ_TAIL_BYTES = 512 * 1024;
const YES_ANSWER = /^\s*(?:да|yes|ок|окей|ok|okay|согласен|согласна)[\s.!)]*$/iu;
const REASON = 'включить отправку пересказов можно только если ты ровно перед этим задал ученику вопрос из навыка слово в слово ' +
  `(«${CONSENT_QUESTION}») и его следующее сообщение целиком «да» (или «yes», «ок», «согласен»). Задай вопрос, дождись ответа и только потом выполни команду. ` +
  'Не включай отправку сам, не уговаривай и не повторяй команду, пока ученик не ответил';
const NAME_REASON = 'записать имя можно только после того, как ученик согласился на пересказы (share включён по его явному «да»)';

const normalize = (text) => String(text).replace(/\s+/g, ' ').trim();

export function isShareOn(tokens) {
  const at = tokens.findIndex((t) => /(^|[\\/])config\.mjs$/i.test(String(t).replace(/['"]/g, '')));
  return at !== -1 && tokens[at + 1] === 'set' && tokens[at + 2] === 'share' && String(tokens[at + 3]).toLowerCase() === 'true';
}

export function isStudentNameSet(tokens) {
  const at = tokens.findIndex((t) => /(^|[\\/])config\.mjs$/i.test(String(t).replace(/['"]/g, '')));
  return at !== -1 && tokens[at + 1] === 'set' && tokens[at + 2] === 'student_name';
}

function textBlocks(entry) {
  const content = entry?.message?.content;
  const blocks = Array.isArray(content) ? content : typeof content === 'string' ? [{ type: 'text', text: content }] : [];
  return { blocks, hasToolResult: blocks.some((b) => b.type === 'tool_result'),
    text: blocks.filter((b) => b.type === 'text').map((b) => b.text || '').join(' ')
      .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, ' ').trim() };
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

// Возвращает { answer, question } : последний настоящий ответ ученика и текст ассистента непосредственно перед ним.
export function lastExchange(transcriptPath) {
  const entries = readTailEntries(transcriptPath);
  let index = entries.length - 1;
  let answer = null;
  for (; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry.type !== 'user' || entry.isMeta) continue;
    const { hasToolResult, text } = textBlocks(entry);
    if (hasToolResult || !text) continue;
    answer = text;
    break;
  }
  if (answer === null) return { answer: null, question: null };
  for (index -= 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry.type === 'assistant') {
      const { text } = textBlocks(entry);
      if (text) return { answer, question: text };
    } else if (entry.type === 'user' && !entry.isMeta) {
      const { hasToolResult, text } = textBlocks(entry);
      if (!hasToolResult && text) return { answer, question: null }; // между вопросом и ответом был ещё один ответ ученика
    }
  }
  return { answer, question: null };
}

export function answerIsYes(text) {
  return typeof text === 'string' && text.length <= 40 && YES_ANSWER.test(text);
}

export function exchangeIsConsent({ answer, question }) {
  return question !== null && answer !== null && normalize(question).includes(normalize(CONSENT_QUESTION)) && answerIsYes(answer);
}

// true только при подтверждённом согласии; нет истории или она не читается — false (fail closed).
export function shareConsentGiven(transcriptPath) {
  if (!transcriptPath || typeof transcriptPath !== 'string') return false;
  try {
    return exchangeIsConsent(lastExchange(transcriptPath));
  } catch {
    return false;
  }
}

// Имя можно записать только когда share уже включён (то есть согласие было подтверждено строгой проверкой выше).
export function nameMayBeSet() {
  return readJson(CONFIG_FILE, {}).share === true;
}

// commands: разобранные команды; transcriptPath: из ввода хука.
export function checkConsentCommand(commands, transcriptPath) {
  for (const cmd of commands) {
    if (isShareOn(cmd.tokens) && !shareConsentGiven(transcriptPath)) return REASON;
    if (isStudentNameSet(cmd.tokens) && !nameMayBeSet()) return NAME_REASON;
  }
  return null;
}
