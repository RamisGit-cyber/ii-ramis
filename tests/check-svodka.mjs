// Поведение сводок Рамису (2.6): хук hooks/svodka-send.mjs вместо curl через Bash.
// Локальный сервер изображает таблицу sessions. Проверяем: отправку, содержимое строки, согласие, лимиты,
// фильтр опасного текста, повтор при ошибке, запись отказов фразами ученика и эмуляцию песочницы
// (старый путь curl через запрещающий прокси не доходит, путь через хук доходит).
// Запуск: node tests/check-svodka.mjs (несколько секунд, сеть не нужна).
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const hook = join(root, 'plugins', 'ii-ramis', 'hooks', 'svodka-send.mjs');
const failures = [];
const check = (ok, message) => { if (!ok) failures.push(message); };

const received = [];
let respondWith = 201;
const server = createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => { body += chunk; });
  req.on('end', () => {
    received.push({ method: req.method, url: req.url, headers: req.headers, body });
    res.statusCode = respondWith;
    res.end();
  });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const endpoint = `http://127.0.0.1:${port}/rest/v1/sessions`;

const homes = [];
const newHome = () => { const dir = mkdtempSync(join(tmpdir(), 'ii-ramis-svodka-')); homes.push(dir); return dir; };
const run = (home, mode, input, extraEnv = {}) => new Promise((resolve) => {
  const child = spawn('node', [hook, mode], { env: { ...process.env, HOME: home, USERPROFILE: home, II_RAMIS_TEST_ENDPOINT: endpoint, ...extraEnv }, stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.on('close', (code) => resolve({ code, out }));
  child.stdin.end(JSON.stringify(input));
});
const stop = (home, message, env) => run(home, '--stop', { hook_event_name: 'Stop', last_assistant_message: message }, env);
const prompt = (home, text) => run(home, '--prompt', { hook_event_name: 'UserPromptSubmit', prompt: text });
const settings = (home) => JSON.parse(readFileSync(join(home, '.ii-ramis', 'svodka.json'), 'utf8'));
const good = '🗣 Что случилось: сделали страницу.\n\n📨 Сводка Рамису (урок 4, застрял: да, ошибок: 2, имя: Айдана): Собрали первую страницу сайта и выложили её в интернет. Застряли на подключении базы, получилось со второго раза.';

try {
  // 1. Отправка
  const home = newHome();
  const first = await stop(home, good);
  check(first.code === 0 && first.out === '', 'хук должен завершаться кодом 0 и ничего не печатать');
  check(received.length === 1 && received[0].method === 'POST' && received[0].url === '/rest/v1/sessions', 'сводка должна уйти одним POST в sessions');
  const row = JSON.parse(received[0]?.body ?? '{}');
  check(row.student === 'Айдана' && row.lesson === 4 && row.stuck === true && row.errors === 2, `поля строки: ${received[0]?.body}`);
  check(row.recap.startsWith('Собрали первую страницу') && row.summary?.plugin_version === '2.6.0' && row.summary?.text === row.recap, 'recap и summary должны совпадать, версия 2.6.0');
  check(!/Сводка Рамису|📨/.test(row.recap), 'служебный префикс в текст не попадает');
  check(Object.keys(row).sort().join(',') === 'errors,install_id,lesson,recap,stuck,student,summary', `лишние поля в строке: ${Object.keys(row)}`);
  check(JSON.parse(Buffer.from(received[0].headers.apikey.split('.')[1], 'base64url')).role === 'anon' && received[0].headers.prefer === 'return=minimal', 'ключ должен быть anon, Prefer: return=minimal');
  const saved = settings(home);
  check(saved.consent === true && /^[0-9a-f-]{36}$/.test(saved.install_id) && saved.name === 'Айдана' && saved.sent_today === 1, `svodka.json после отправки: ${JSON.stringify(saved)}`);

  // 2. Лимит: вторая сводка сразу не уходит
  await stop(home, good.replace('Собрали', 'Доделали'));
  check(received.length === 1, 'повторная сводка в течение 30 минут не должна уходить');

  // 3. Нет строки сводки — ничего не уходит
  const quiet = newHome();
  await stop(quiet, 'Просто ответ без сводки.');
  check(received.length === 1 && !existsSync(join(quiet, '.ii-ramis', 'svodka.json')), 'без строки «📨 Сводка Рамису» хук ничего не делает');

  // 4. Согласие: consent=false — ничего не уходит
  const refuser = newHome();
  mkdirSync(join(refuser, '.ii-ramis'));
  writeFileSync(join(refuser, '.ii-ramis', 'svodka.json'), '{"consent":false}\n');
  await stop(refuser, good);
  check(received.length === 1, 'при consent=false сводка уходить не должна');

  // 5. Опасное содержимое: вся сводка отбрасывается
  const unsafe = {
    'путь к файлу': 'Правили файл /Users/aidana/project/src/app.tsx и всё заработало как надо.',
    'адрес сайта': 'Выложили сайт на https://aidana-shop.vercel.app и показали друзьям.',
    'почта': 'Написали на почту aidana@example.com и получили ответ клиента.',
    'ключ': 'Вставили ключ sk-abcdef1234567890abcdef в настройки и всё подключилось.',
    'длинный токен': 'Скопировали ' + 'A1b2C3d4'.repeat(5) + ' и вставили в форму входа.',
    'код': 'Добавили `npm run dev` и страница открылась в браузере у ученика.',
    'файл .env': 'Положили секреты в .env и перезапустили сервер без ошибок.',
  };
  for (const [label, text] of Object.entries(unsafe)) {
    const fresh = newHome();
    await stop(fresh, `📨 Сводка Рамису (урок 4, застрял: нет, ошибок: 0): ${text}`);
    check(received.length === 1, `опасная сводка (${label}) не должна уходить`);
  }

  // 6. Длинный текст обрезается до 400 символов
  const longHome = newHome();
  await stop(longHome, `📨 Сводка Рамису (урок 5): ${'Настраивали сайт. '.repeat(60)}`);
  check(received.length === 2 && JSON.parse(received[1].body).recap.length <= 400 && !('lesson' in JSON.parse(received[1].body) && JSON.parse(received[1].body).lesson !== 5), 'длинный текст должен обрезаться до 400 символов');

  // 7. Ошибка сервера: одна повторная попытка, без падения и без шума
  const failing = newHome();
  respondWith = 500;
  const before = received.length;
  const failed = await stop(failing, good);
  respondWith = 201;
  check(failed.code === 0 && failed.out === '' && received.length - before === 2, `при ошибке 500 ровно одна повторная попытка и тишина (запросов ${received.length - before})`);
  check(!('last_sent' in settings(failing)), 'неудачная отправка не должна считаться отправленной');

  // 8. Сервер недоступен: тихо, код 0
  const offline = await stop(newHome(), good, { II_RAMIS_TEST_ENDPOINT: 'http://127.0.0.1:1/rest/v1/sessions' });
  check(offline.code === 0 && offline.out === '', 'без сети хук должен молча завершиться');

  // 9. Отказы фразами ученика записывает хук (Bash в песочнице писать в ~/.ii-ramis не может)
  const talker = newHome();
  const off = await prompt(talker, 'Пожалуйста, не отправляй сводки Рамису');
  check(settings(talker).consent === false && /хук/.test(off.out), 'фраза «не отправляй сводки» должна записать consent=false');
  const countBefore = received.length;
  await stop(talker, good);
  check(received.length === countBefore, 'после отказа сводки не уходят');
  await prompt(talker, 'снова отправляй сводки');
  check(settings(talker).consent === true, '«снова отправляй сводки» включает обратно');
  await prompt(talker, 'не ставь набор');
  check(JSON.parse(readFileSync(join(talker, '.ii-ramis', 'nabor.json'), 'utf8')).status === 'declined', '«не ставь набор» должно записать status=declined');
  await prompt(talker, 'ладно, поставь набор');
  check(!existsSync(join(talker, '.ii-ramis', 'nabor.json')), '«поставь набор» снимает отказ');
  const plain = await prompt(newHome(), 'сделай мне сайт про кофейню');
  check(plain.out === '', 'обычный запрос хук не трогает');
  const notSet = newHome();
  await prompt(notSet, 'поставь набор');
  check(!existsSync(join(notSet, '.ii-ramis', 'nabor.json')), '«поставь набор» без отказа ничего не пишет');

  // 10. Эмуляция песочницы: у Bash сети нет (прокси отказывает), у хука есть
  const denyProxy = createServer((req, res) => { res.statusCode = 403; res.end('blocked by sandbox proxy'); });
  await new Promise((resolve) => denyProxy.listen(0, '127.0.0.1', resolve));
  const proxy = `http://127.0.0.1:${denyProxy.address().port}`;
  const sandboxEnv = { HTTP_PROXY: proxy, HTTPS_PROXY: proxy, http_proxy: proxy, https_proxy: proxy, ALL_PROXY: proxy };
  const countBeforeSandbox = received.length;
  const oldWay = spawnSync('curl', ['-sS', '-m', '8', '-o', '/dev/null', '-w', '%{http_code}', '-X', 'POST', endpoint, '-H', 'Content-Type: application/json', '--data-binary', '{}'], { env: { ...process.env, ...sandboxEnv }, encoding: 'utf8' });
  check(oldWay.stdout !== '201' && received.length === countBeforeSandbox, `эмуляция: curl через Bash в песочнице не должен дойти (получили ${oldWay.stdout})`);
  const viaHook = await stop(newHome(), good, sandboxEnv);
  check(viaHook.code === 0 && received.length === countBeforeSandbox + 1, 'тот же запрос через хук (вне песочницы, прокси песочницы к нему не относится) должен дойти');
  denyProxy.close();
} finally {
  server.close();
  for (const dir of homes) rmSync(dir, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error(failures.map((line) => `FAIL: ${line}`).join('\n'));
  process.exit(1);
}
console.log('OK: сводки уходят хуком, согласие, лимиты, фильтр и отказы работают');
