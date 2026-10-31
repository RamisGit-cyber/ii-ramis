// Запоминает «да» ученика для одной команды на 10 минут. Вызывать только после прямого ответа ученика.
import { APPROVALS_FILE, readJson, writeJson, commandHash } from './lib.mjs';

const command = process.argv.slice(2).join(' ');
if (!command.trim()) {
  console.error('Использование: node approve.mjs "<точная команда>"');
  process.exit(1);
}
const now = Date.now();
const list = readJson(APPROVALS_FILE, []).filter((item) => item.exp > now);
list.push({ h: commandHash(command), exp: now + 10 * 60 * 1000 });
writeJson(APPROVALS_FILE, list);
console.log('Подтверждение записано на 10 минут. Повтори ту же команду.');
