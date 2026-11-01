// Проверка redact(): из текста ошибок должны исчезать пути (в том числе с кириллицей и пробелами), ключи и почты.
import { redact } from '../plugins/ii-ramis/scripts/lib.mjs';

let failed = 0;
function check(title, input, mustVanish, mustStay = []) {
  const out = redact(input, 300);
  const leaked = mustVanish.filter((piece) => out.includes(piece));
  const lost = mustStay.filter((piece) => !out.includes(piece));
  if (leaked.length === 0 && lost.length === 0) {
    console.log(`  ok   redact: ${title}`);
  } else {
    failed += 1;
    console.log(`  FAIL redact: ${title} -> «${out}» (просочилось: ${leaked.join(', ') || '-'}; потеряно: ${lost.join(', ') || '-'})`);
  }
}

check('путь Mac с кириллицей', '/Users/айбек/Проекты/сайт/app.js', ['айбек', 'Проекты', 'сайт', 'app.js']);
check('путь Mac в сообщении Node', "ENOENT: no such file or directory, open '/Users/айбек/Проекты/сайт/app.js'", ['айбек', 'Проекты', 'сайт'], ['ENOENT']);
check('путь Windows с пробелом и кириллицей', 'C:\\Users\\Айбек Сапаров\\Проекты\\app.js', ['Айбек', 'Сапаров', 'Проекты', 'app.js']);
check('путь Windows в сообщении', 'Cannot find C:\\Users\\Айбек Сапаров\\Мои проекты\\a.js: нет доступа', ['Айбек', 'Сапаров', 'проекты'], ['нет доступа']);
check('путь Mac с пробелом в имени', "open '/Users/Айбек Сапаров/Мои проекты/a.js'", ['Айбек', 'Сапаров', 'проекты']);
check('путь через ~ с кириллицей', 'cannot open ~/Документы/мой файл.txt', ['Документы', 'файл']);
check('относительный путь', 'Error in src/components/Кнопка.tsx', ['components', 'Кнопка'], ['Error']);
check('пароль после password=', 'login failed password=hunter2', ['hunter2']);
check('значение в кавычках после key', 'API_KEY="my secret value" rejected', ['my secret value', 'secret value']);
check('токен после token:', 'bad token: abc123xyz456', ['abc123xyz456']);
check('русское «пароль:»', 'пароль: qwerty123 не подошёл', ['qwerty123']);
check('Bearer', 'Authorization: Bearer abcdef123456', ['abcdef123456']);
check('«secret is …»', 'the secret is s3cr3tvalue', ['s3cr3tvalue']);
check('почта', 'письмо для ivan.petrov@example.com не ушло', ['ivan.petrov', 'example.com']);
check('кириллическая почта', 'айбек@почта.рф недоступна', ['айбек', 'почта.рф']);
check('длинный ключ', 'sk-abcdefghijklmnop12345 отклонён', ['abcdefghijklmnop12345']);
check('обычная ошибка остаётся читаемой', 'TypeError: Cannot read properties of undefined', [], ['TypeError', 'Cannot read properties of undefined']);

console.log(failed === 0 ? 'REDACT-OK' : `REDACT-FAILED ${failed}`);
process.exit(failed === 0 ? 0 : 1);
