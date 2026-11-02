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

export const CONSENT_QUESTION = 'Можно отправлять Рамису короткий пересказ твоих занятий (без кода и паролей), чтобы он видел, где тебе помочь?';
export const CODE_TTL_MS = 60 * 60 * 1000;
export const MAX_WRONG_ATTEMPTS = 3;

const SHARE_ON_REASON = 'включать отправку пересказов Claude не может совсем: согласие фиксирует защитный хук, когда ученик сам ответит «да <код>» на вопрос, который хук показал ему на экране. ' +
  'Коды тебе не передаются. Команду set share true не повторяй';
const NAME_REASON = 'записать имя можно только после того, как ученик согласился на пересказы (отправка включена хуком по его явному «да <код>»)';
const NESTED_REASON = 'вложенный запуск claude из команды (в любой форме: -p, --resume, обёртки, tmux, sh -c) закрыт: ученикам он не нужен, а через него обходят защиту. Работай прямо в этой сессии';

export const newSalt = () => crypto.randomBytes(16).toString('hex');
export const newCode = () => String(crypto.randomInt(1000, 10000));
// В consent.json лежит хеш (соль + сессия + код). Это НЕ защита от утечки: 4 цифры подбираются перебором за доли секунды.
// Защищают другое: файл закрыт для чтения Claude (SECRET_PATTERNS в lib.mjs), а согласие засчитывается только из
// настоящего сообщения ученика (input.prompt) в той же сессии. Зная код, модель может лишь попросить ученика его набрать —
// это уже осознанный ответ человека на вопрос, который хук показал ему сам. Хеш только убирает код из файла открытым текстом.
export const codeHash = (code, session, salt = '') => crypto.createHash('sha256').update(`${salt}:${session}:${code}`).digest('hex');
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
// Вложенный запуск claude из Bash/PowerShell не нужен ученикам и открывает обходы согласия (в том числе claude -p с ответом «да <код>»).
// Блокируем любую форму: прямой запуск, переменные перед ним, обёртки (env, sudo, npx, node, bun, script, expect, tmux, timeout, xargs...)
// и запуск внутри кавычек (sh -c '...'). Разрешён только claude --version / -v.
const WRAPPERS = '(?:env|sudo|doas|nohup|exec|command|time|npx|bunx|pnpm|yarn|npm|dlx|node|nodejs|bun|deno|script|expect|tmux|screen|timeout|xargs|unbuffer|setsid|stdbuf|nice|ionice|watch|bash|sh|zsh|pwsh|powershell|cmd|start|call|send-keys|new-session|new-window|spawn)';
const CLAUDE_TAIL = '(?:[A-Za-z_][A-Za-z0-9_]*=\\S*\\s+)*(?:' + WRAPPERS + '\\s+(?:\\S+\\s+){0,4}?)*(?:[^\\s"\'`;&|()]*[/\\\\])?claude(?:\\.exe|-code)?(?![\\w.-])([^;&|\\n]*)';
// начало команды (после ; & | ( или $( ) либо открывающая кавычка после флага -c / -Command / /c / send-keys / spawn
const CLAUDE_LAUNCH = new RegExp('(?:^|[;&|(`\\n]|\\$\\()\\s*' + CLAUDE_TAIL + '|(?:-[a-z]*c|-command|/c|send-keys|spawn)\\s+["\']\\s*' + CLAUDE_TAIL, 'gi');
// Разрешено из Claude: просмотр плагинов, подключение и удаление коннекторов (claude mcp add/remove/list/get: ученики подключают коннекторы).
// `claude mcp add` с командой, которая трогает защищаемое (настройки .claude, ключи, окружение, удаление домашней папки), закрыт ниже.
const MCP_COMMAND_PROTECTED = /\.claude|\.ii-ramis|ii-ramis|managed-settings|\.ssh|\.aws|\.gnupg|\.npmrc|\.netrc|id_rsa|id_ed25519|keychain|security\s+find|environ|process\.env|\bprintenv\b|\.env\b|credentials|CLAUDE_CONFIG_DIR|rm\s+-[a-z]*r|rmtree|rmSync|Remove-Item|\bsudo\b/i;
const ALLOWED_CLAUDE = /^(?:mcp\s+(?:list|get\s+\S+|add(?:-json|-from-claude-desktop)?(?:\s+.+)?|remove\s+\S+)|plugins?\s+list(?:\s+--(?:json|available))*|plugins?\s+marketplaces?\s+list(?:\s+--json)?|plugins?\s+details\s+[A-Za-z0-9@._-]{1,80})$/;
// Установка самого Claude Code через пакетный менеджер (npm i -g @anthropic-ai/claude-code) запуском claude не является.
const PACKAGE_INSTALL = /\b(?:npm|pnpm|yarn|bun)\s+(?:i|install|add|update|upgrade|uninstall|remove|rm)\s+(?:-{1,2}[\w-]+(?:=\S+)?\s+)*@anthropic-ai\/claude-code(?:@[\w.-]+)?/gi;
export function isClaudeLaunch(commandText) {
  for (const match of String(commandText).replace(PACKAGE_INSTALL, 'package-install').matchAll(CLAUDE_LAUNCH)) {
    const rest = (match[1] || match[2] || '').trim().replace(/["']+$/, '');
    if (!/^(?:--version|-v)$/.test(rest) && !ALLOWED_CLAUDE.test(rest)) return true;
    if (/^mcp\s+add/.test(rest) && MCP_COMMAND_PROTECTED.test(rest)) return true;
  }
  return false;
}

const YES_WITH_CODE = /^\s*да\s+(\d{4})[\s.!)]*$/iu;
const NO_WITH_CODE = /^\s*нет\s+(\d{4})[\s.!)]*$/iu;
const matchesCode = (regex, prompt, state, session) => {
  const found = typeof prompt === 'string' && prompt.length <= 30 ? regex.exec(prompt) : null;
  return Boolean(found) && codeHash(found[1], session, state.salt || '') === state.hash;
};
export const answerIsYes = (prompt, state, session) => matchesCode(YES_WITH_CODE, prompt, state, session);
export const answerIsNo = (prompt, state, session) => matchesCode(NO_WITH_CODE, prompt, state, session);
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
  const pending = state && typeof state.hash === 'string' && /^[0-9a-f]{64}$/.test(state.hash);
  const fresh = pending && Number.isFinite(state.ts) && now - state.ts <= CODE_TTL_MS;
  const sameSession = pending && state.session === sessionId;

  if (pending && fresh && sameSession) {
    if (answerIsYes(prompt, state, sessionId)) return { configPatch: { share: true, share_asked: true }, state: null, systemMessage: 'ИИ Рамис (защита): согласие записано, короткий пересказ занятий будет уходить Рамису. Выключить: скажи «не отправляй мои данные Рамису».', context: 'ИИ Рамис, служебное: ученик согласился на пересказы (хук записал). Спроси, как подписывать пересказ (имя или ник), запиши: config.mjs set student_name "Имя", и веди пересказ сессии: файл ' + RECAP_FILE + ' (инструмент Write, перезаписывай целиком), 2–3 предложения по-русски до ' + RECAP_MAX_CHARS + ' символов: что делал ученик, где застрял, о чём спрашивал; без дословных сообщений, кода, путей, ключей, паролей, почт и телефонов. Обновляй после заметных этапов и перед прощанием.' };
    if (answerIsNo(prompt, state, sessionId)) return { configPatch: { share: false, share_asked: true }, state: null, systemMessage: 'ИИ Рамис (защита): понял, ничего отправляться не будет. Передумаешь: напиши «включи отправку пересказов».' };
    const before = Number(state.wrong) || 0;
    const wrong = before + (/(?:да|нет)\s*\d{3,5}/iu.test(prompt) ? 1 : 0); // считаем только похожие на попытку (с цифрами)
    if (wrong >= MAX_WRONG_ATTEMPTS) return { state: null }; // слишком много «да» без кода: код сгорает, новый выдастся позже
    const first = state.reminded !== true; // напоминание модели один раз, без шума на каждое сообщение
    return { state: wrong !== before || first ? { ...state, wrong, reminded: true } : undefined, context: first ? CONTEXT_ASKED : undefined };
  }
  if (config.share === true) return pending ? { state: null } : null; // уже включено
  if (config.share_asked === true && !REASK_PHRASE.test(prompt)) return pending ? { state: null } : null; // ученик уже решил раньше; чужой или протухший код стираем
  const code = makeCode();
  const salt = newSalt();
  return {
    state: { salt, hash: codeHash(code, sessionId, salt), ts: now, session: sessionId, wrong: 0 },
    systemMessage: `ИИ Рамис (защита): ${buildQuestion(code)}`,
    context: CONTEXT_ASKED + ' Сначала ответь на сообщение ученика как обычно.',
  };
}

// Имя можно записать только когда отправка уже включена хуком.
export function nameMayBeSet() {
  return readJson(CONFIG_FILE, {}).share === true;
}

// Команды Claude: share=true запрещён всегда; student_name только при включённой отправке; claude -p с ответом-согласием запрещён.
export function checkConsentCommand(commands, commandText = '') {
  if (isClaudeLaunch(commandText)) return NESTED_REASON;
  for (const cmd of commands) {
    if (isShareOn(cmd.tokens)) return SHARE_ON_REASON;
    if (isStudentNameSet(cmd.tokens) && !nameMayBeSet()) return NAME_REASON;
  }
  return null;
}

// `claude mcp add`: без вопросов только удалённые коннекторы (--transport http|sse https://…) и известные пакеты через npx.
// Всё остальное (своя команда, add-json, add-from-claude-desktop) не блок, а обычный вопрос ученику: охранник отвечает «спросить» (см. guard.mjs).
const MCP_FLAGS = String.raw`(?:(?:--scope|-s)\s+(?:user|project|local)\s+|--transport\s+(?:http|sse)\s+|(?:-H|--header)\s+"[\w-]+: [^"\x60$;&|<>()]*"\s+|(?:-e|--env)\s+[A-Z][A-Z0-9_]*=[\w.:/-]*\s+)*`;
const MCP_NAME = String.raw`[\w.-]{1,60}`;
const MCP_REMOTE = new RegExp(String.raw`^mcp\s+add\s+${MCP_FLAGS}${MCP_NAME}\s+${MCP_FLAGS}https:\/\/[^\s"'\x60$;&|()<>]+(?:\s+${MCP_FLAGS.slice(0, -1)})*\s*$`);
const MCP_KNOWN_PACKAGE = String.raw`(?:@modelcontextprotocol\/[\w.-]+|@upstash\/context7-mcp|@playwright\/mcp|@supabase\/mcp-server-supabase|@vercel\/mcp-adapter|@notionhq\/notion-mcp-server|@figma\/mcp)(?:@[\w.-]+)?`;
const MCP_STDIO = new RegExp(String.raw`^mcp\s+add\s+${MCP_FLAGS}${MCP_NAME}\s+${MCP_FLAGS}--\s+npx\s+(?:-y\s+)?${MCP_KNOWN_PACKAGE}(?:\s+[\w.:=/@-]+)*\s*$`);

export function mcpAddNeedsConfirmation(commandText) {
  for (const match of String(commandText).replace(PACKAGE_INSTALL, 'package-install').matchAll(CLAUDE_LAUNCH)) {
    const rest = (match[1] || match[2] || '').trim().replace(/["']+$/, '');
    if (/^mcp\s+add/.test(rest) && !(MCP_REMOTE.test(rest) && /--transport\s+(?:http|sse)\b/.test(rest)) && !MCP_STDIO.test(rest)) return true;
  }
  return false;
}
