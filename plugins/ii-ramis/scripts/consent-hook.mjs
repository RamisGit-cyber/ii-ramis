// UserPromptSubmit: выдаёт ученику вопрос о пересказах с одноразовым кодом и фиксирует ответ «да <код>» (см. consent-rules.mjs).
// Молча: любая ошибка не мешает сообщению дойти до Claude. Пишет только в конфиг и в consent.json (код).
import fs from 'node:fs';
import path from 'node:path';
import { CONFIG_FILE, DATA_DIR, loadConfig, readJson, readStdinJson, writeJson } from './lib.mjs';
import { decideConsent, isInteractiveEntrypoint } from './consent-rules.mjs';

const CONSENT_STATE_FILE = path.join(DATA_DIR, 'consent.json');

try {
  const input = readStdinJson();
  const config = loadConfig();
  const decision = decideConsent({
    config,
    state: readJson(CONSENT_STATE_FILE, {}),
    prompt: typeof input.prompt === 'string' ? input.prompt : '',
    sessionId: typeof input.session_id === 'string' ? input.session_id : '',
    interactive: isInteractiveEntrypoint(),
  });
  const output = {};
  try {
    if (decision?.configPatch) writeJson(CONFIG_FILE, { ...readJson(CONFIG_FILE, config), ...decision.configPatch });
    if (decision && 'state' in decision && decision.state === null) fs.rmSync(CONSENT_STATE_FILE, { force: true });
    else if (decision?.state) writeJson(CONSENT_STATE_FILE, decision.state);
    if (decision?.systemMessage) output.systemMessage = decision.systemMessage; // видит ученик, модель нет
    if (decision?.context) output.hookSpecificOutput = { hookEventName: 'UserPromptSubmit', additionalContext: decision.context };
  } catch (error) {
    console.error(`ii-ramis consent-hook: не удалось записать: ${error.message}`);
    output.systemMessage = 'ИИ Рамис (защита): не удалось записать твой ответ про пересказы, отправка осталась выключенной. Ответь на вопрос ещё раз или напиши «включи отправку пересказов», чтобы получить новый.';
  }
  if (Object.keys(output).length > 0) process.stdout.write(JSON.stringify(output));
} catch (error) {
  console.error(`ii-ramis consent-hook: ${error.message}`);
}
process.exitCode = 0;
