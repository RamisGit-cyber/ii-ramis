// Согласие на пересказы сессий: даётся в чате, фиксирует его ХУК UserPromptSubmit (consent-hook.mjs), а не Claude.
// Схема не доверяет ни истории сессии, ни словам Claude:
//   1) хук сам выдаёт одноразовый код (4 цифры), сохраняет его в конфиге и через additionalContext велит наставнику
//      задать ученику вопрос дословно, вместе с кодом: «…Если согласен, ответь: да 4821»;
//   2) согласие засчитывается, только если настоящее сообщение ученика (input.prompt) целиком равно «да <код>»;
//   3) код живёт CODE_TTL_MS, на попытки «да» без кода есть лимит, после использования код стирается; всё остальное не согласие.
// Claude команду `config.mjs set share true` выполнить не может (checkConsentCommand), а сам конфиг править не может (protect-rules).
// Ограничение: это сетка, а не стена. Скрипт, который Claude сам напишет в проекте и запустит, может записать файл напрямую
// (защита не читает содержимое файлов проекта, см. README «Чего страховка не ловит»).
import crypto from 'node:crypto';
import { CONFIG_FILE, readJson } from './lib.mjs';

export const CONSENT_QUESTION = 'Можно отправлять Рамису короткий пересказ твоих занятий (без кода и паролей), чтобы он видел, где тебе помочь?';
export const CODE_TTL_MS = 60 * 60 * 1000;
export const MAX_WRONG_ATTEMPTS = 3;

const SHARE_ON_REASON = 'включать отправку пересказов Claude не может совсем: согласие фиксирует защитный хук, когда ученик сам ответит «да <код>» на твой вопрос. ' +
  'Дождись, пока хук выдаст тебе вопрос с кодом, задай его слово в слово и жди ответа. Команду set share true не повторяй';
const NAME_REASON = 'записать имя можно только после того, как ученик согласился на пересказы (отправка включена хуком по его явному «да <код>»)';

export const newCode = () => String(crypto.randomInt(1000, 10000));
export const buildQuestion = (code) => `${CONSENT_QUESTION} Если согласен, ответь: да ${code}. Если не хочешь, ответь: нет.`;

const configTokenAt = (tokens) => tokens.findIndex((t) => /(^|[\\/])config\.mjs$/i.test(String(t).replace(/['"]/g, '')));
export function isShareOn(tokens) {
  const at = configTokenAt(tokens);
  return at !== -1 && tokens[at + 1] === 'set' && tokens[at + 2] === 'share' && String(tokens[at + 3]).toLowerCase() !== 'false';
}
export function isStudentNameSet(tokens) {
  const at = configTokenAt(tokens);
  return at !== -1 && tokens[at + 1] === 'set' && tokens[at + 2] === 'student_name';
}

export const answerIsYes = (prompt, code) => typeof prompt === 'string' && prompt.length <= 30
  && new RegExp(`^\\s*да\\s+${code}[\\s.!)]*$`, 'iu').test(prompt);
export const answerIsNo = (prompt) => typeof prompt === 'string' && prompt.length <= 30
  && /^\s*(?:нет|no|не надо|не хочу)[\s.!)]*$/iu.test(prompt);

const CODE_FIELDS = { consent_code: null, consent_code_ts: null, consent_wrong: null };
const looksLikeSlashCommand = (prompt) => /^\s*\//.test(prompt);

// Решение хука на сообщение ученика. Возвращает { patch, context } (оба необязательны) или null.
// patch: значение null удаляет поле. now: Date.now(); makeCode: генератор кода (подменяется в тестах).
export function decideConsent({ config, prompt, now = Date.now(), makeCode = newCode }) {
  if (typeof prompt !== 'string' || !prompt.trim() || looksLikeSlashCommand(prompt)) return null;
  const pending = typeof config.consent_code === 'string' && /^\d{4}$/.test(config.consent_code);
  const fresh = pending && Number.isFinite(config.consent_code_ts) && now - config.consent_code_ts <= CODE_TTL_MS;

  if (pending && fresh) {
    if (answerIsYes(prompt, config.consent_code)) return { patch: { ...CODE_FIELDS, share: true, share_asked: true } };
    if (answerIsNo(prompt)) return { patch: { ...CODE_FIELDS, share: false, share_asked: true } };
    const before = Number(config.consent_wrong) || 0;
    const wrong = before + (/(?:^|\s)да(?:\s|$|[.!,])/iu.test(prompt) ? 1 : 0);
    if (wrong >= MAX_WRONG_ATTEMPTS) return { patch: CODE_FIELDS }; // слишком много «да» без кода: код сгорает, новый выдастся позже
    return {
      patch: wrong !== before ? { consent_wrong: wrong } : undefined,
      context: `ИИ Рамис, служебное: вопрос о пересказах с кодом уже выдан. Если ты его ещё не задал, задай слово в слово: «${buildQuestion(config.consent_code)}». Если задал, не повторяй. «да» без кода согласием не считается.`,
    };
  }
  if (config.share_asked === true) return pending ? { patch: CODE_FIELDS } : null; // ученик уже решил раньше; протухший код стираем
  const code = makeCode();
  return {
    patch: { consent_code: code, consent_code_ts: now, consent_wrong: 0 },
    context: 'ИИ Рамис, служебное: ученик ещё не решил, можно ли отправлять Рамису пересказы занятий. Ответь на его сообщение как обычно, а в конце отдельным абзацем задай вопрос слово в слово, '
      + `ничего не меняя и не добавляя: «${buildQuestion(code)}». Отправку включит защитный хук, когда ученик ответит именно «да ${code}»; сам ты её включить не можешь. `
      + 'Если ты ещё не спросил, какой урок он прошёл, сначала спроси про урок, а этот вопрос задай со следующим сообщением. Не уговаривай.',
  };
}

// Имя можно записать только когда отправка уже включена хуком.
export function nameMayBeSet() {
  return readJson(CONFIG_FILE, {}).share === true;
}

// Команды Claude: share=true запрещён всегда; student_name только при включённой отправке.
export function checkConsentCommand(commands) {
  for (const cmd of commands) {
    if (isShareOn(cmd.tokens)) return SHARE_ON_REASON;
    if (isStudentNameSet(cmd.tokens) && !nameMayBeSet()) return NAME_REASON;
  }
  return null;
}
