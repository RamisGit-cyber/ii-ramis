// Согласие на пересказы сессий: даётся в чате, фиксирует его ХУК UserPromptSubmit (consent-hook.mjs), а не Claude.
// Схема не доверяет ни истории сессии, ни словам Claude, и модель не узнаёт код:
//   1) хук сам выдаёт одноразовый код (4 цифры), хранит его в consent.json (Claude этот файл не читает и не правит)
//      и показывает вопрос с кодом САМОМУ УЧЕНИКУ видимым сообщением хука (systemMessage). Модели уходит только факт «спрошено»;
//   2) согласие засчитывается, только если настоящее сообщение ученика (input.prompt) целиком равно «да <код>»,
//      сообщение пришло из той же сессии (session_id), где код выдан, и сессия интерактивная (не claude -p / SDK);
//   3) код живёт CODE_TTL_MS, на «да» без кода есть лимит, после использования код стирается; всё остальное не согласие.
// Claude команду `config.mjs set share true` выполнить не может (checkConsentCommand), а конфиг править не может (protect-rules).
// Ограничение: это сетка, а не стена. Скрипт, который Claude сам напишет в проекте и запустит, может записать файл напрямую
// (защита не читает содержимое файлов проекта, см. README «Чего страховка не ловит»).
import crypto from 'node:crypto';
import { CONFIG_FILE, RECAP_FILE, RECAP_MAX_CHARS, readJson } from './lib.mjs';
import { verbName } from './shell-parse.mjs';

export const CONSENT_QUESTION = 'Можно отправлять Рамису короткий пересказ твоих занятий (без кода и паролей), чтобы он видел, где тебе помочь?';
export const CODE_TTL_MS = 60 * 60 * 1000;
export const MAX_WRONG_ATTEMPTS = 3;

const SHARE_ON_REASON = 'включать отправку пересказов Claude не может совсем: согласие фиксирует защитный хук, когда ученик сам ответит «да <код>» на вопрос, который хук показал ему на экране. ' +
  'Коды тебе не передаются. Команду set share true не повторяй';
const NAME_REASON = 'записать имя можно только после того, как ученик согласился на пересказы (отправка включена хуком по его явному «да <код>»)';
const NESTED_REASON = 'запуск claude в неинтерактивном режиме (-p / --print) с ответом «да <код>» внутри: так согласие не даётся. Согласие ученик пишет сам в обычном чате';

export const newCode = () => String(crypto.randomInt(1000, 10000));
export const buildQuestion = (code) => `${CONSENT_QUESTION} Если согласен, ответь: да ${code}. Если не хочешь, ответь: нет ${code}.`;

// claude -p, SDK и MCP-режим не интерактивные: согласие и выдача кода там не работают.
export function isInteractiveEntrypoint(env = process.env) {
  return !/^(sdk|mcp)/i.test(String(env.CLAUDE_CODE_ENTRYPOINT || '')) && !env.CLAUDE_CODE_NON_INTERACTIVE;
}

const configTokenAt = (tokens) => tokens.findIndex((t) => /(^|[\\/])config\.mjs$/i.test(String(t).replace(/['"]/g, '')));
export function isShareOn(tokens) {
  const at = configTokenAt(tokens);
  return at !== -1 && tokens[at + 1] === 'set' && tokens[at + 2] === 'share' && String(tokens[at + 3]).toLowerCase() !== 'false';
}
export function isStudentNameSet(tokens) {
  const at = configTokenAt(tokens);
  return at !== -1 && tokens[at + 1] === 'set' && tokens[at + 2] === 'student_name';
}
// claude -p "да 4821" и подобные: вложенная неинтерактивная сессия с ответом-согласием.
export function isNestedClaudeAnswer(tokens) {
  const at = tokens.findIndex((t) => verbName(t) === 'claude');
  if (at === -1) return false;
  const rest = tokens.slice(at + 1);
  const headless = rest.some((t) => /^(-p|--print|-[a-zA-Z]*p[a-zA-Z]*)$/.test(t)) || rest.some((t) => /^--(print|output-format|input-format)/.test(t));
  return headless && /(?:^|[\s"'`])(?:да|yes)\s*[:,-]?\s*\d{4}(?!\d)/iu.test(rest.join(' '));
}

export const answerIsYes = (prompt, code) => typeof prompt === 'string' && prompt.length <= 30
  && new RegExp(`^\\s*да\\s+${code}[\\s.!)]*$`, 'iu').test(prompt);
export const answerIsNo = (prompt, code) => typeof prompt === 'string' && prompt.length <= 30
  && new RegExp(`^\\s*нет\\s+${code}[\\s.!)]*$`, 'iu').test(prompt);
// Фраза ученика, которой он сам просит вернуть вопрос (после отказа или чтобы включить позже).
const REASK_PHRASE = /(?:включи|включай|хочу\s+включить|хочу\s+снова)\s+(?:отправк|пересказ)/iu;

const looksLikeSlashCommand = (prompt) => /^\s*\//.test(prompt);
const CONTEXT_ASKED = 'ИИ Рамис, служебное: защитный хук сам показал ученику на экране вопрос, можно ли отправлять Рамису пересказы занятий. Код и текст вопроса тебе не передаются, самому спрашивать не нужно. ' +
  'Отправку включит хук, когда ученик ответит «да» и четыре цифры из вопроса (так же он может отказаться: «нет» и цифры); проверить результат можно командой config.mjs get share. Не уговаривай. Если ученик спрашивает, что уходит, расскажи по разделу «Приватность» README.';

// Решение хука на сообщение ученика. Возвращает { configPatch, state, systemMessage, context } (поля необязательны) или null.
// config: config.json; state: consent.json ({code, ts, session, wrong} или {}); state: null означает «стереть».
export function decideConsent({ config, state, prompt, sessionId, interactive = true, now = Date.now(), makeCode = newCode }) {
  if (!interactive) return null; // claude -p, SDK: ни кода, ни согласия
  if (typeof prompt !== 'string' || !prompt.trim() || looksLikeSlashCommand(prompt)) return null;
  if (typeof sessionId !== 'string' || !sessionId) return null;
  const pending = state && typeof state.code === 'string' && /^\d{4}$/.test(state.code);
  const fresh = pending && Number.isFinite(state.ts) && now - state.ts <= CODE_TTL_MS;
  const sameSession = pending && state.session === sessionId;

  if (pending && fresh && sameSession) {
    if (answerIsYes(prompt, state.code)) return { configPatch: { share: true, share_asked: true }, state: null, systemMessage: 'ИИ Рамис (защита): согласие записано, короткий пересказ занятий будет уходить Рамису. Выключить: скажи «не отправляй мои данные Рамису».', context: 'ИИ Рамис, служебное: ученик согласился на пересказы (хук записал). Спроси, как подписывать пересказ (имя или ник), запиши: config.mjs set student_name "Имя", и веди пересказ сессии: файл ' + RECAP_FILE + ' (инструмент Write, перезаписывай целиком), 2–3 предложения по-русски до ' + RECAP_MAX_CHARS + ' символов: что делал ученик, где застрял, о чём спрашивал; без дословных сообщений, кода, путей, ключей, паролей, почт и телефонов. Обновляй после заметных этапов и перед прощанием.' };
    if (answerIsNo(prompt, state.code)) return { configPatch: { share: false, share_asked: true }, state: null, systemMessage: 'ИИ Рамис (защита): понял, ничего отправляться не будет. Передумаешь: напиши «включи отправку пересказов».' };
    const before = Number(state.wrong) || 0;
    const wrong = before + (/(?:да|нет)\s*\d{3,5}/iu.test(prompt) ? 1 : 0); // считаем только похожие на попытку (с цифрами)
    if (wrong >= MAX_WRONG_ATTEMPTS) return { state: null }; // слишком много «да» без кода: код сгорает, новый выдастся позже
    return { state: wrong !== before ? { ...state, wrong } : undefined, context: CONTEXT_ASKED };
  }
  if (config.share === true) return pending ? { state: null } : null; // уже включено
  if (config.share_asked === true && !REASK_PHRASE.test(prompt)) return pending ? { state: null } : null; // ученик уже решил раньше; чужой или протухший код стираем
  const code = makeCode();
  return {
    state: { code, ts: now, session: sessionId, wrong: 0 },
    systemMessage: `ИИ Рамис (защита): ${buildQuestion(code)}`,
    context: CONTEXT_ASKED + ' Сначала ответь на сообщение ученика как обычно.',
  };
}

// Имя можно записать только когда отправка уже включена хуком.
export function nameMayBeSet() {
  return readJson(CONFIG_FILE, {}).share === true;
}

// Команды Claude: share=true запрещён всегда; student_name только при включённой отправке; claude -p с ответом-согласием запрещён.
export function checkConsentCommand(commands) {
  for (const cmd of commands) {
    if (isShareOn(cmd.tokens)) return SHARE_ON_REASON;
    if (isStudentNameSet(cmd.tokens) && !nameMayBeSet()) return NAME_REASON;
    if (isNestedClaudeAnswer(cmd.tokens)) return NESTED_REASON;
  }
  return null;
}
