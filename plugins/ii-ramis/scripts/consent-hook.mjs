// UserPromptSubmit: фиксирует согласие на пересказы по настоящему ответу ученика «да <код>» (см. consent-rules.mjs).
// Молча: любая ошибка не мешает сообщению дойти до Claude. Пишет только в конфиг ученика.
import { CONFIG_FILE, loadConfig, readStdinJson, writeJson } from './lib.mjs';
import { decideConsent } from './consent-rules.mjs';

try {
  const input = readStdinJson();
  const prompt = typeof input.prompt === 'string' ? input.prompt : '';
  const config = loadConfig();
  const decision = decideConsent({ config, prompt });
  if (decision?.patch) {
    const merged = { ...config };
    for (const [key, value] of Object.entries(decision.patch)) {
      if (value === null) delete merged[key]; else merged[key] = value;
    }
    writeJson(CONFIG_FILE, merged);
  }
  if (decision?.context) {
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: decision.context } }));
  }
} catch (error) {
  console.error(`ii-ramis consent-hook: ${error.message}`);
}
process.exit(0);
