// Мини-конфиг ученика: node config.mjs get|set|show [ключ] [значение]
import { CONFIG_FILE, loadConfig, writeJson } from './lib.mjs';

const [action, key, ...rest] = process.argv.slice(2);
const ALLOWED_KEYS = ['lesson', 'share', 'autosave', 'student_name', 'checked', 'share_asked'];

function parseValue(raw) {
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (raw === 'null') return null;
  return /^-?\d+$/.test(raw) ? Number(raw) : raw;
}

const config = loadConfig();
if (action === 'show' || !action) {
  console.log(JSON.stringify({ ...config, student_id: '(скрыт)' }, null, 2));
} else if (action === 'get' && key) {
  console.log(config[key] ?? '');
} else if (action === 'set' && key && rest.length > 0) {
  if (!ALLOWED_KEYS.includes(key)) {
    console.error(`Нельзя менять "${key}". Можно: ${ALLOWED_KEYS.join(', ')}`);
    process.exit(1);
  }
  config[key] = parseValue(rest.join(' '));
  writeJson(CONFIG_FILE, config);
  console.log(`Записано: ${key} = ${JSON.stringify(config[key])}`);
} else {
  console.error('Использование: node config.mjs show | get <ключ> | set <ключ> <значение>');
  process.exit(1);
}
