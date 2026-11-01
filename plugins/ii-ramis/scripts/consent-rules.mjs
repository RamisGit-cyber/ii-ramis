// Согласие на пересказы сессий даётся в чате. Страховка от того, что Claude сам включит отправку (или это сделает
// вредная инструкция со страницы): команду `config.mjs set share true` пропускаем, только если ПОСЛЕДНЕЕ сообщение
// ученика в этой сессии короткое и начинается с явного «да». Это сетка, а не стена: главное правило в навыке ii-ramis.
import fs from 'node:fs';

const READ_TAIL_BYTES = 512 * 1024;
const MAX_ANSWER_LENGTH = 200;
const YES_START = /^\s*(да|yes|y|ага|угу|ок|окей|ok|okay|давай|согласен|согласна|можно|конечно|разрешаю|хорошо|отправляй)(?![\p{L}\p{N}])/iu;
const NO_WORD = /(?<![\p{L}\p{N}])(не|нет|no|never|ни)(?![\p{L}\p{N}])/iu;
const REASON = 'включить отправку пересказов можно только после явного «да» ученика отдельным сообщением. Спроси ученика простыми словами ' +
  '(«Можно отправлять Рамису короткий пересказ твоих занятий, без кода и паролей? да/нет»), дождись его ответа «да» и только потом выполни команду. Не включай отправку сам и не уговаривай';

export function isShareOn(tokens) {
  const at = tokens.findIndex((t) => /(^|[\\/])config\.mjs$/i.test(String(t).replace(/['"]/g, '')));
  return at !== -1 && tokens[at + 1] === 'set' && tokens[at + 2] === 'share' && String(tokens[at + 3]).toLowerCase() === 'true';
}

function textOf(entry) {
  const content = entry?.message?.content;
  const blocks = Array.isArray(content) ? content : typeof content === 'string' ? [{ type: 'text', text: content }] : [];
  if (blocks.some((b) => b.type === 'tool_result')) return null; // это результат инструмента, не слова ученика
  return blocks.filter((b) => b.type === 'text').map((b) => b.text || '').join(' ')
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, ' ').trim();
}

export function lastStudentMessage(transcriptPath) {
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
  const lines = raw.split('\n').filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    let entry;
    try { entry = JSON.parse(lines[i]); } catch { continue; } // обрезанная первая строка хвоста
    if (entry.type !== 'user' || entry.isMeta) continue;
    const text = textOf(entry);
    if (text) return text;
  }
  return null;
}

export function answerIsYes(text) {
  return typeof text === 'string' && text.length <= MAX_ANSWER_LENGTH && YES_START.test(text) && !NO_WORD.test(text);
}

// commands: разобранные команды; transcriptPath: из ввода хука (может не быть: тогда остаётся только правило в навыке).
export function checkConsentCommand(commands, transcriptPath) {
  if (!commands.some((cmd) => isShareOn(cmd.tokens))) return null;
  if (!transcriptPath) return null;
  try {
    return answerIsYes(lastStudentMessage(transcriptPath)) ? null : REASON;
  } catch (error) {
    return `${REASON} (не смог прочитать историю сессии: ${error.code || error.message})`;
  }
}
