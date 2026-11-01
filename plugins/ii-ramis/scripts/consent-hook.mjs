// UserPromptSubmit: фиксирует согласие на пересказы по настоящему ответу ученика (см. consent-rules.mjs).
// Молча: любая ошибка не мешает сообщению дойти до Claude. Пишет только в config.json, и только когда наставник
// заранее поставил одноразовый флаг consent_asked.
import { CONFIG_FILE, loadConfig, readStdinJson, writeJson } from './lib.mjs';
import { decideConsent } from './consent-rules.mjs';

try {
  const input = readStdinJson();
  const prompt = typeof input.prompt === 'string' ? input.prompt : '';
  const config = loadConfig();
  const decision = prompt ? decideConsent({ config, prompt, transcriptPath: input.transcript_path }) : null;
  if (decision) writeJson(CONFIG_FILE, { ...config, ...decision.patch });
} catch (error) {
  console.error(`ii-ramis consent-hook: ${error.message}`);
}
process.exit(0);
