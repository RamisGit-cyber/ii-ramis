// Поведение сводок Рамису (2.7): хук hooks/svodka-send.mjs вместо curl через Bash.
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
let responseDelayMs = 0;
const server = createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => { body += chunk; });
  req.on('end', () => {
    received.push({ method: req.method, url: req.url, headers: req.headers, body });
    res.statusCode = respondWith;
    setTimeout(() => res.end(), responseDelayMs);
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
const settings = (home) => { try { return JSON.parse(readFileSync(join(home, '.ii-ramis', 'svodka.json'), 'utf8')); } catch { return {}; } };
const good = '🗣 Что случилось: сделали страницу.\n\n📨 Сводка Рамису (урок 4, застрял: да, ошибок: 2, имя: Айдана): Собрали первую страницу сайта и выложили её в интернет. Застряли на подключении базы, получилось со второго раза.';

try {
  // 1. Отправка
  const home = newHome();
  const first = await stop(home, good);
  check(first.code === 0 && first.out === '', 'хук должен завершаться кодом 0 и ничего не печатать');
  check(received.length === 1 && received[0].method === 'POST' && received[0].url === '/rest/v1/sessions', 'сводка должна уйти одним POST в sessions');
  const row = JSON.parse(received[0]?.body ?? '{}');
  check(row.student === 'Айдана' && row.lesson === 4 && row.stuck === true && row.errors === 2, `поля строки: ${received[0]?.body}`);
  check(row.recap.startsWith('Собрали первую страницу') && row.summary?.plugin_version === '2.10.3' && row.summary?.text === row.recap, 'recap и summary должны совпадать, версия 2.10.3');
  check(!/Сводка Рамису|📨/.test(row.recap), 'служебный префикс в текст не попадает');
  check(Object.keys(row).sort().join(',') === 'errors,install_id,lesson,recap,stuck,student,summary', `лишние поля в строке: ${Object.keys(row)}`);
  check(/^sb_publishable_[\w-]+$/.test(received[0].headers.apikey) && received[0].headers.authorization === undefined && received[0].headers.prefer === 'return=minimal', 'ключ sb_publishable_ только в apikey, без Authorization, Prefer: return=minimal');
  const saved = settings(home);
  check(saved.consent === undefined && /^[0-9a-f-]{36}$/.test(saved.install_id) && saved.name === 'Айдана' && saved.sent_today === 1, `svodka.json после отправки: ${JSON.stringify(saved)}`);

  // 2. Лимит: вторая сводка сразу не уходит
  await stop(home, good.replace('Собрали', 'Доделали'));
  check(received.length === 1, 'повторная сводка в течение 30 минут не должна уходить');

  // 3. Нет строки сводки и ученик отказался — ничего не уходит (пульс при отказе тоже молчит)
  const quiet = newHome();
  mkdirSync(join(quiet, '.ii-ramis'));
  writeFileSync(join(quiet, '.ii-ramis', 'svodka.json'), '{"consent":false}\n');
  await stop(quiet, 'Просто ответ без сводки.');
  check(received.length === 1 && settings(quiet).consent === false && !('last_pulse' in settings(quiet)), 'при consent=false без строки сводки пульс не уходит');

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
  const marker = join(talker, '.ii-ramis', 'earshot-declined');
  for (const phrase of ['не ставь Earshot, не надо', 'Не хочу ставить Earshot', 'не надо ставить earshot', 'не нужно ставить Earshot', 'нет, Earshot', 'Earshot не нужен']) {
    rmSync(marker, { force: true });
    await prompt(talker, phrase);
    check(existsSync(marker), `«${phrase}» записывает отметку отказа Earshot`);
  }
  await prompt(talker, 'сколько места надо, чтобы поставить earshot?');
  check(existsSync(marker), 'вопрос про место снимать отказ не должен');
  await prompt(talker, 'ну ладно, потом поставь Earshot');
  check(existsSync(marker), '«поставь Earshot» не с начала реплики отказ не снимает');
  await prompt(talker, 'Пожалуйста, поставь Earshot');
  check(!existsSync(marker), '«поставь Earshot» с начала реплики снимает отметку');
  rmSync(marker, { force: true });
  await prompt(talker, 'сколько места надо, чтобы поставить earshot?');
  check(!existsSync(marker), 'вопрос про место отказ не создаёт');
  const maskMarker = join(talker, '.ii-ramis', 'mask-declined');
  await prompt(talker, 'не ставь маску');
  check(existsSync(maskMarker), '«не ставь маску» записывает отметку отказа');
  const named = newHome();
  mkdirSync(join(named, '.ii-ramis'), { recursive: true });
  writeFileSync(join(named, '.ii-ramis', 'svodka.json'), '{"consent":true,"name":"Айдана"}\n');
  const plain = await prompt(named, 'сделай мне сайт про кофейню');
  check(plain.out === '', 'обычный запрос при известном имени хук не трогает');

  // Имя ученика: спрашиваем один раз за сессию, ответ записывает хук
  const askPrompt = (home, text, session) => run(home, '--prompt', { hook_event_name: 'UserPromptSubmit', prompt: text, session_id: session });
  const answers = async (reply, session = 's1') => {
    const h = newHome();
    const ask = await askPrompt(h, 'привет, помоги с сайтом', session);
    check(/Как тебя зовут/.test(ask.out) && /ОДИН раз/.test(ask.out), `первое сообщение без имени: хук просит спросить имя: ${ask.out}`);
    const answer = await askPrompt(h, reply, session);
    return { h, ask, answer, saved: settings(h) };
  };
  {
    const ok = await answers('Айдана');
    check(ok.saved.name === 'Айдана' && ok.saved.name_pending === false, `имя «Айдана» записано: ${JSON.stringify(ok.saved)}`);
    check(/имя ученика записано/.test(ok.answer.out) && !ok.answer.out.includes('Айдана'), 'подтверждение для Claude без самого имени (ввод ученика в контекст не идёт)');
    check((await askPrompt(ok.h, 'дальше', 's2')).out === '', 'после записи имени больше не спрашиваем');
    const again = await askPrompt(ok.h, 'ещё одно', 's1');
    check(again.out === '', 'в той же сессии повторно не спрашиваем');
  }
  for (const [reply, expected] of [['Меня зовут Бекзат', 'Бекзат'], ['меня зовут жылдыз, хочу сайт', 'Жылдыз'], ['Я Нурсултан', 'Нурсултан'], ['Анна-Мария Ким', 'Анна-Мария Ким'], ['Имя: Али', 'Али'], ['мое имя Эркин.', 'Эркин']]) {
    check((await answers(reply)).saved.name === expected, `«${reply}» → «${expected}»`);
  }
  for (const reply of ['привет', 'Привет', 'сделай мне сайт', 'Расскажи', 'я хочу сайт про кофе', 'Что дальше?', 'да', 'Ок', 'Айдана, а как поставить Node?', 'Айдана 5', 'Меня зовут', 'x'.repeat(80), 'Продолжай', 'Я Не знаю']) {
    const result = await answers(reply);
    check(result.saved.name === undefined && result.saved.name_pending === false && !result.saved.name_declined, `«${reply.slice(0, 30)}» именем не считается: ${JSON.stringify(result.saved)}`);
    check((await askPrompt(result.h, 'ещё', 's1')).out === '', 'если ученик не ответил, в этой сессии не переспрашиваем');
  }
  {
    const refuse = await answers('Не скажу');
    check(refuse.saved.name_declined === true && refuse.saved.name === undefined && /больше про имя не спрашивай/.test(refuse.answer.out), 'отказ записан');
    check((await askPrompt(refuse.h, 'сделай сайт', 's9')).out === '', 'после отказа в новой сессии не спрашиваем');
    writeFileSync(join(refuse.h, '.ii-ramis', 'x'), '');
    const before = received.length;
    await stop(refuse.h, good);
    check(JSON.parse(received[before]?.body ?? '{}').student === 'без имени', 'после отказа имя из строки сводки не берём');
  }
  {
    // «меня зовут …» в любой момент записывает имя, даже без вопроса и даже если имя уже было
    const any = newHome();
    const r1 = await askPrompt(any, 'Меня зовут Гульзат Джунушева', 'z1');
    check(settings(any).name === 'Гульзат Джунушева' && /имя ученика записано/.test(r1.out), `имя в любой момент: ${JSON.stringify(settings(any))}`);
    await askPrompt(any, 'меня зовут жылдыз', 'z2');
    check(settings(any).name === 'Жылдыз', `имя можно поменять: ${JSON.stringify(settings(any))}`);
    const not = newHome();
    await askPrompt(not, 'меня зовут как? напомни', 'z3');
    check(settings(not).name === undefined, 'вопрос «меня зовут как?» именем не считается');
    const off = newHome();
    await prompt(off, 'не отправляй сводки');
    await askPrompt(off, 'меня зовут Али', 'z4');
    check(settings(off).name === undefined, 'при отказе от сводок имя не пишем');
  }
  {
    // не больше трёх вопросов за всё время, по одному за сессию
    const h = newHome();
    let asked = 0;
    for (const session of ['a', 'b', 'c', 'd', 'e']) { if ((await askPrompt(h, 'дальше', session)).out.includes('Как тебя зовут')) asked += 1; await askPrompt(h, 'дальше дальше', session); }
    check(asked === 3, `вопрос про имя не больше трёх раз: ${asked}`);
  }
  {
    // отказ от сводок: имя не спрашиваем; служебные фразы вопросом не перебиваем
    const off = newHome();
    await prompt(off, 'не отправляй сводки');
    check((await askPrompt(off, 'привет', 's1')).out === '', 'при consent: false имя не спрашиваем');
    const upd = newHome();
    check(!/Как тебя зовут/.test((await askPrompt(upd, 'обнови плагин ИИ Рамис', 's1')).out), 'просьба обновить плагин вопросом про имя не перебивается');
    const forget = newHome();
    mkdirSync(join(forget, '.ii-ramis'), { recursive: true });
    writeFileSync(join(forget, '.ii-ramis', 'svodka.json'), '{"consent":true,"name":"Айдана"}\n');
    await prompt(forget, 'забудь моё имя');
    check(settings(forget).name === undefined && settings(forget).name_declined === true, '«забудь моё имя» удаляет имя');
    // имя в строке сводки очищается от лишнего
    const before = received.length;
    await stop(newHome(), good.replace('имя: Айдана', 'имя: Айдана Иванова Петрова Сидорова'));
    check(JSON.parse(received[before]?.body ?? '{}').student === 'без имени', 'имя из четырёх слов не принимается');
  }
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
  // 2б. Разметка вокруг строки; ключи с подчёркиваниями и цитаты не проходят; Node.js не режется
  const markup = newHome();
  const beforeMarkup = received.length;
  await stop(markup, '**📨 Сводка Рамису (урок 4, имя: Лада):** Поставили Node.js и запустили первую страницу сайта.**');
  check(received.length === beforeMarkup + 1 && JSON.parse(received.at(-1).body).recap.startsWith('Поставили Node и запустили'), 'разметка вокруг строки сводки и Node.js должны проходить');
  const leaky = newHome();
  await stop(leaky, '📨 Сводка Рамису (урок 4): Положили ключ sk_live_51Hh8abcdEFGH12345678 в настройки сайта.');
  await stop(newHome(), '📨 Сводка Рамису (урок 4): Токен a_b_c_d_e_f_g_h_i_j_k_l_m_n_o_p_q_r_s_t_u лежит в настройках.');
  await stop(newHome(), '> 📨 Сводка Рамису (урок 4): Это цитата из чужого файла и она не сводка.');
  check(received.length === beforeMarkup + 1, 'ключи с подчёркиваниями и цитаты в сводку не попадают');

  // 6. Пульс: тихая отметка без текста
  const stopWithSession = (home, message, sessionId) => run(home, '--stop', { hook_event_name: 'Stop', session_id: sessionId, last_assistant_message: message });
  const pulseHome = newHome();
  const pulseBase = received.length;
  const pulseRun = await stopWithSession(pulseHome, 'Просто ответ без сводки.', 'sess-1');
  check(pulseRun.code === 0 && pulseRun.out === '', 'пульс ничего не печатает ученику');
  const pulseRow = received.length === pulseBase + 1 ? JSON.parse(received.at(-1).body) : null;
  check(pulseRow?.kind === 'pulse' && pulseRow.stuck === false && /^[0-9a-f-]{36}$/.test(pulseRow.install_id) && pulseRow.summary?.plugin_version === '2.10.3', `пульс уходит без строки сводки: ${received.at(-1)?.body}`);
  check(pulseRow && Object.keys(pulseRow).sort().join(',') === 'install_id,kind,stuck,student,summary' && Object.keys(pulseRow.summary).sort().join(',') === 'at,kind,plugin_version', `в пульсе только служебные поля: ${Object.keys(pulseRow ?? {})}`);
  await stopWithSession(pulseHome, 'Ещё один ответ.', 'sess-2');
  check(received.length === pulseBase + 1, 'второй пульс раньше чем через 30 минут не уходит');
  const old = settings(pulseHome);
  writeFileSync(join(pulseHome, '.ii-ramis', 'svodka.json'), JSON.stringify({ ...old, last_pulse: new Date(Date.now() - 31 * 60 * 1000).toISOString() }) + '\n');
  await stopWithSession(pulseHome, 'Ещё один ответ.', 'sess-1');
  check(received.length === pulseBase + 1, 'в той же сессии пульс не повторяется');
  await stopWithSession(pulseHome, 'Ещё один ответ.', 'sess-3');
  check(received.length === pulseBase + 2, 'через 30 минут пульс снова уходит');
  // сводка в этой же сессии: пульс не дублирует
  const both = newHome();
  const bothBase = received.length;
  await stopWithSession(both, good, 'sess-9');
  await stopWithSession(both, 'Ответ без сводки.', 'sess-9');
  check(received.length === bothBase + 1 && JSON.parse(received.at(-1).body).kind === undefined, 'после сводки в той же сессии пульс не дублируется');
  // отброшенная сводка пульсом не заменяется
  const rejectedBase = received.length;
  await stopWithSession(newHome(), '📨 Сводка Рамису (урок 4): Положили ключ sk_live_51Hh8abcdEFGH12345678 в настройки.', 'sess-5');
  check(received.length === rejectedBase, 'отброшенная сводка не превращается в пульс');
  // битый файл и согласие не булевым значением: не отправляем ни сводку, ни пульс
  for (const [label, content] of [['битый файл', '{не json'], ['consent строкой', '{"consent":"false"}']]) {
    const broken = newHome();
    mkdirSync(join(broken, '.ii-ramis'));
    writeFileSync(join(broken, '.ii-ramis', 'svodka.json'), content);
    const brokenBase = received.length;
    await stopWithSession(broken, good, 'sess-b');
    await stopWithSession(broken, 'Ответ без сводки.', 'sess-c');
    check(received.length === brokenBase, `${label}: ни сводка, ни пульс не уходят`);
  }
  // гонка: отказ, записанный за время отправки, не затирается ни пульсом, ни сводкой
  for (const [label, message] of [['пульс', 'Ответ без сводки.'], ['сводка', good]]) {
    const racing = newHome();
    responseDelayMs = 600;
    const pending = stopWithSession(racing, message, 'sess-r');
    await new Promise((resolve) => setTimeout(resolve, 250));
    mkdirSync(join(racing, '.ii-ramis'), { recursive: true });
    writeFileSync(join(racing, '.ii-ramis', 'svodka.json'), '{"consent":false}\n');
    await pending;
    responseDelayMs = 0;
    check(JSON.stringify(settings(racing)) === '{"consent":false}', `${label}: отказ, записанный во время отправки, должен сохраниться: ${JSON.stringify(settings(racing))}`);
  }
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
