// PreToolUse: страховка для новичков. Exit 2 = действие заблокировано, текст из stderr читает Claude.
// Подтверждения «да» через модель больше нет: любое «опасно» = отказ. Ученик, если ему правда нужно,
// выполняет действие сам (в обычном терминале, не через Claude) или показывает Рамису.
// Закрываемся при любой ошибке (fail closed), в том числе при сломанном импорте: поэтому модули грузим внутри try.
import fs from 'node:fs';

function refuse(reason) {
  process.stderr.write(
    `ИИ Рамис остановил действие: ${reason}.\n` +
    'Это действие никто не подтверждает через чат, и обойти блок нельзя: не переписывай команду другим способом и не ищи обходной путь. ' +
    'Объясни ученику простыми словами, что ты хотел сделать и чем это опасно. ' +
    'Если действие правда нужно, ученик может выполнить его сам в обычном окне терминала (не через Claude) или показать Рамису на уроке. ' +
    'Если речь про ключи: проверить, что файл на месте, можно без чтения (`ls -la` / `Test-Path`); ' +
    'ключи ученик вставляет сам, скрытым вводом. Файл .env с ключами создаёт и правит ученик руками, а ты работаешь с .env.example.\n',
  );
  process.exit(2);
}

function failClosed(error) {
  process.stderr.write(
    `ИИ Рамис остановил действие: защита дала сбой (${error.message}), а в сомнительном случае безопаснее не выполнять. ` +
    'Скажи ученику, что произошла техническая ошибка защиты, и попроси написать об этом Рамису. Команду не повторяй.\n',
  );
  process.exit(2);
}

process.on('uncaughtException', failClosed);

try {
  const raw = fs.readFileSync(0, 'utf8');
  if (!raw.trim()) throw new Error('пустой ввод хука');
  const input = JSON.parse(raw);
  if (!input || typeof input !== 'object') throw new Error('ввод хука не объект');
  const { decide, Denied } = await import('./guard-core.mjs');
  let reason = null;
  try {
    reason = decide(input);
  } catch (error) {
    if (!(error instanceof Denied)) throw error;
    reason = error.message;
  }
  if (reason) refuse(reason);
} catch (error) {
  failClosed(error);
}
process.exit(0);
