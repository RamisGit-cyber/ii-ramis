// Тесты отправки сводок на локальном фейковом сервере (сеть и реальная база не трогаются).
// Печатает строки "ok ..." / "FAIL ..."; их считает tests/test-hooks.sh.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ANON_KEY } from '../plugins/ii-ramis/scripts/report-config.mjs';

const SCRIPTS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'plugins', 'ii-ramis', 'scripts');
let failed = 0;
const check = (name, condition) => {
  if (!condition) failed += 1;
  console.log(`  ${condition ? 'ok  ' : 'FAIL'} ${name}`);
};

function startServer(handler) {
  const received = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      received.push({ headers: req.headers, method: req.method, body: Buffer.concat(chunks).toString('utf8') });
      handler(req, res, received.length);
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    resolve({ server, received, url: `http://127.0.0.1:${server.address().port}/rest/v1/sessions` });
  }));
}
const ok = (_req, res) => { res.statusCode = 201; res.end(); };

function writeTranscript(dir, marker = 'A') {
  const file = path.join(dir, `t-${marker}-${Math.random().toString(16).slice(2)}.jsonl`);
  const ts = (m) => new Date(Date.UTC(2026, 10, 2, 19, m)).toISOString();
  const lines = [
    { type: 'user', timestamp: ts(0), message: { role: 'user', content: 'сделай сайт, мой секрет sk-abcdefghijklmnop123456' } },
    { type: 'assistant', timestamp: ts(1), message: { role: 'assistant', content: [{ type: 'tool_use', id: 't0', name: 'Write', input: { file_path: '/Users/x/site/index.html', content: 'SECRET_CODE_BODY' } }] } },
  ];
  for (let i = 1; i <= 3; i += 1) {
    lines.push({ type: 'assistant', timestamp: ts(2 + i), message: { role: 'assistant', content: [{ type: 'tool_use', id: `b${i}`, name: 'Bash', input: { command: 'npm run build --token=SECRETTOKEN' } }] } });
    lines.push({ type: 'user', timestamp: ts(2 + i), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `b${i}`, is_error: true, content: `Error: Cannot find module /Users/x/site/node_modules/foo at line ${10 + i}` }] } });
  }
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return file;
}

function runSessionEnd(home, url, transcript) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = execFile('node', [path.join(SCRIPTS, 'session-end.mjs')], {
      env: { ...process.env, IIRAMIS_HOME: home, IIRAMIS_REPORT_URL: url },
    }, (error) => resolve({ code: error ? error.code : 0, ms: Date.now() - started }));
    child.stdin.end(JSON.stringify({ session_id: 's1', transcript_path: transcript, cwd: '/Users/x/site', reason: 'other' }));
  });
}

const setConfig = (home, patch) => {
  const file = path.join(home, 'config.json');
  const config = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ student_id: 'sid-1', install_id: 'test-plugin-0001', lesson: 3, ...config, ...patch }));
};
const tempHome = () => fs.mkdtempSync(path.join(os.tmpdir(), 'iir-home-'));
const progressLines = (home) => fs.readFileSync(path.join(home, 'progress.jsonl'), 'utf8').split('\n').filter(Boolean);
const sentLines = (home) => JSON.parse(fs.readFileSync(path.join(home, 'state.json'), 'utf8')).sentLines;

// 1. без согласия ничего не уходит
{
  const { server, received, url } = await startServer(ok);
  const home = tempHome(); setConfig(home, { share: false });
  await runSessionEnd(home, url, writeTranscript(home));
  check('без согласия: запрос не отправлен', received.length === 0);
  check('без согласия: запись осталась в progress.jsonl', progressLines(home).length === 1);
  server.close();
}

// 2. с согласием: один запрос, нужные заголовки и поля, без утечек
{
  const { server, received, url } = await startServer(ok);
  const home = tempHome(); setConfig(home, { share: true, student_name: 'Тест Ученик' });
  await runSessionEnd(home, url, writeTranscript(home));
  check('с согласием: ровно один POST', received.length === 1 && received[0].method === 'POST');
  const request = received[0];
  const row = JSON.parse(request.body);
  check('заголовок apikey = anon-ключ', request.headers.apikey === ANON_KEY);
  check('Authorization: Bearer <тот же ключ>', request.headers.authorization === `Bearer ${ANON_KEY}`);
  check('Content-Type: application/json', request.headers['content-type'] === 'application/json');
  check('Prefer: return=minimal', request.headers.prefer === 'return=minimal');
  check('student 1–80 символов', typeof row.student === 'string' && row.student.length >= 1 && row.student.length <= 80);
  check('install_id по маске', /^[A-Za-z0-9_-]{8,64}$/.test(row.install_id));
  check('lesson 0–20', Number.isInteger(row.lesson) && row.lesson >= 0 && row.lesson <= 20);
  check('os ≤ 20 символов', typeof row.os === 'string' && row.os.length <= 20);
  check('stuck — булево и true после 3 одинаковых ошибок', row.stuck === true);
  check('errors 0–1000', Number.isInteger(row.errors) && row.errors >= 3 && row.errors <= 1000);
  check('summary — объект ≤ 8 КБ', typeof row.summary === 'object' && Buffer.byteLength(JSON.stringify(row.summary)) <= 8192);
  check('нет лишних полей', Object.keys(row).sort().join() === 'errors,install_id,lesson,os,stuck,student,summary');
  for (const leak of ['SECRET_CODE_BODY', 'SECRETTOKEN', 'sk-abcdef', '/Users/x/site', 'node_modules/foo', 'sid-1']) {
    check(`в отправленном нет «${leak}»`, !request.body.includes(leak));
  }
  check('state.json: отправлена 1 строка', sentLines(home) === 1);
  server.close();
}

// 3. сервера нет: тихо, запись остаётся, потом уходит вместе с новой
{
  const home = tempHome(); setConfig(home, { share: true, student_name: 'Тест' });
  const dead = await startServer(ok); const deadUrl = dead.url; await new Promise((r) => dead.server.close(r));
  const first = await runSessionEnd(home, deadUrl, writeTranscript(home));
  check('сервер недоступен: хук завершился с кодом 0', first.code === 0);
  check('сервер недоступен: запись осталась в очереди', progressLines(home).length === 1 && !sentLines(home));
  const { server, received, url } = await startServer(ok);
  await runSessionEnd(home, url, writeTranscript(home));
  check('при следующей сессии уходят обе записи', received.length === 2 && sentLines(home) === 2);
  server.close();
}

// 4. 500 — повтор позже; 400 — запись выбрасывается
{
  const home = tempHome(); setConfig(home, { share: true, student_name: 'Тест' });
  const failing = await startServer((_q, res) => { res.statusCode = 500; res.end(); });
  await runSessionEnd(home, failing.url, writeTranscript(home));
  check('ответ 500: запись остаётся в очереди', failing.received.length === 1 && !sentLines(home));
  failing.server.close();
  const bad = await startServer((_q, res) => { res.statusCode = 400; res.end(); });
  await runSessionEnd(home, bad.url, writeTranscript(home));
  check('ответ 400: строка отброшена, очередь не застряла', sentLines(home) === 2);
  bad.server.close();
}

// 4а. лимит на сервере (429) и 503: сессия не ломается, запись остаётся в очереди и уходит позже
for (const status of [429, 503]) {
  const home = tempHome(); setConfig(home, { share: true, student_name: 'Тест' });
  const limited = await startServer((_q, res) => { res.statusCode = status; res.end(); });
  const result = await runSessionEnd(home, limited.url, writeTranscript(home));
  check(`ответ ${status}: хук завершился с кодом 0`, result.code === 0);
  check(`ответ ${status}: запись осталась в очереди`, progressLines(home).length === 1 && !sentLines(home));
  limited.server.close();
  const healthy = await startServer(ok);
  await runSessionEnd(home, healthy.url, writeTranscript(home));
  check(`после ${status} следующая сессия отправляет обе записи`, healthy.received.length === 2 && sentLines(home) === 2);
  healthy.server.close();
}

// 5. не больше 20 за раз
{
  const home = tempHome(); setConfig(home, { share: true, student_name: 'Тест' });
  const template = JSON.stringify({ v: 1, consent: true, os: 'linux', lesson: 2, prompts: 1, tools: {}, categories: [], errors: [], stuck: false, file_types: {} });
  fs.writeFileSync(path.join(home, 'progress.jsonl'), Array(25).fill(template).join('\n') + '\n');
  const { server, received, url } = await startServer(ok);
  await runSessionEnd(home, url, writeTranscript(home));
  check('за один запуск уходит не больше 20 записей', received.length === 20 && sentLines(home) === 20);
  await runSessionEnd(home, url, writeTranscript(home));
  check('остальные уходят в следующий раз', received.length === 20 + 7 && sentLines(home) === 27);
  server.close();
}

// 6. записи без согласия не уходят, даже если согласие дали позже
{
  const { server, received, url } = await startServer(ok);
  const home = tempHome(); setConfig(home, { share: false });
  await runSessionEnd(home, url, writeTranscript(home));
  setConfig(home, { share: true, student_name: 'Тест' });
  await runSessionEnd(home, url, writeTranscript(home));
  check('старая запись без согласия не отправлена, новая отправлена', received.length === 1 && sentLines(home) === 2);
  server.close();
}

// 7. сервер завис: хук укладывается в таймаут
{
  const hang = await startServer(() => {});
  const home = tempHome(); setConfig(home, { share: true, student_name: 'Тест' });
  const result = await runSessionEnd(home, hang.url, writeTranscript(home));
  check('сервер завис: хук завершился за ≤ 8 с с кодом 0', result.code === 0 && result.ms < 8000);
  check('сервер завис: запись осталась в очереди', !sentLines(home));
  hang.server.closeAllConnections?.();
  hang.server.close();
}

// 7а. пересказ сессии (recap): чистится redact, ≤ 400 символов, только по согласию, файл удаляется
{
  const dirty = 'Ученик делал лендинг, урок 4. Писал на aibek@example.com, звонил +996 555 123 456, ключ sk-abcdefghijklmnop123456, папка /Users/aibek/site/src. Застрял на деплое. ' + 'Долгий хвост. '.repeat(60);
  const { server, received, url } = await startServer(ok);
  const home = tempHome(); setConfig(home, { share: true, student_name: 'Тест' });
  fs.writeFileSync(path.join(home, 'recap.txt'), dirty);
  await runSessionEnd(home, url, writeTranscript(home));
  const row = JSON.parse(received[0].body);
  check('recap уходит строкой ≤ 400 символов', typeof row.recap === 'string' && row.recap.length > 20 && row.recap.length <= 400);
  check('recap сохраняет смысл и короткие числа («урок 4»)', row.recap.includes('лендинг') && row.recap.includes('урок 4'));
  for (const leak of ['aibek@example.com', '555 123 456', '996', 'sk-abcdef', '/Users/aibek']) {
    check(`в recap нет «${leak}»`, !row.recap.includes(leak));
  }
  check('файл recap.txt удалён после сессии', !fs.existsSync(path.join(home, 'recap.txt')));
  check('с recap добавлено только поле recap', Object.keys(row).sort().join() === 'errors,install_id,lesson,os,recap,stuck,student,summary');
  server.close();
}
{
  const { server, received, url } = await startServer(ok);
  const home = tempHome(); setConfig(home, { share: false });
  fs.writeFileSync(path.join(home, 'recap.txt'), 'Ученик делал сайт');
  await runSessionEnd(home, url, writeTranscript(home));
  check('без согласия recap не сохраняется даже локально', !progressLines(home)[0].includes('Ученик делал сайт') && received.length === 0);
  check('без согласия файл recap.txt всё равно удалён', !fs.existsSync(path.join(home, 'recap.txt')));
  server.close();
}
{
  // в базе ещё нет колонки recap (миграция не применена): сервер отвечает 400, запись не теряется
  const picky = await startServer((req, res) => { res.statusCode = JSON.parse(picky.received.at(-1).body).recap !== undefined ? 400 : 201; res.end(); });
  const home = tempHome(); setConfig(home, { share: true, student_name: 'Тест' });
  fs.writeFileSync(path.join(home, 'recap.txt'), 'Ученик делал сайт');
  await runSessionEnd(home, picky.url, writeTranscript(home));
  check('400 из-за recap: повтор без recap, запись дошла', picky.received.length === 2 && !('recap' in JSON.parse(picky.received[1].body)) && sentLines(home) === 1);
  picky.server.close();
}

// 7б. recap: симлинк и огромный файл не читаются; правка progress.jsonl после session-end не обходит очистку; чужой адрес из окружения игнорируется
{
  const { server, received, url } = await startServer(ok);
  const home = tempHome(); setConfig(home, { share: true, student_name: 'Тест' });
  const outside = path.join(home, 'outside.txt'); fs.writeFileSync(outside, 'ЧУЖОЙ_ФАЙЛ_МАРКЕР');
  fs.symlinkSync(outside, path.join(home, 'recap.txt'));
  await runSessionEnd(home, url, writeTranscript(home));
  check('recap.txt — симлинк: содержимое чужого файла не уходит', received.length === 1 && !received[0].body.includes('ЧУЖОЙ_ФАЙЛ_МАРКЕР') && !('recap' in JSON.parse(received[0].body)));
  fs.rmSync(path.join(home, 'recap.txt'), { force: true });
  fs.writeFileSync(path.join(home, 'recap.txt'), 'Ученик делал сайт. '.repeat(2000));
  await runSessionEnd(home, url, writeTranscript(home));
  check('recap.txt больше 8 КБ не читается', !('recap' in JSON.parse(received[1].body)));
  server.close();
}
{
  const { server, received, url } = await startServer(ok);
  const home = tempHome(); setConfig(home, { share: true, student_name: 'Тест' });
  const tampered = JSON.stringify({ v: 1, consent: true, os: 'linux', lesson: 2, prompts: 1, tools: {}, categories: [], errors: [], stuck: false, file_types: {}, recap: 'Написал boss@example.com и +996 555 123 456 ' + '😀'.repeat(300) });
  fs.writeFileSync(path.join(home, 'progress.jsonl'), tampered + '\n');
  await runSessionEnd(home, url, writeTranscript(home));
  const row = JSON.parse(received[0].body);
  check('recap из подправленного progress.jsonl чистится при отправке', !row.recap.includes('boss@example.com') && !row.recap.includes('555 123 456'));
  check('recap режется по символам, суррогатные пары целы', Array.from(row.recap).length <= 400 && !/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(row.recap));
  server.close();
}
{
  // чужой (не локальный) адрес из окружения не принимается: берётся настоящий REPORT_URL (в тесте сеть не трогаем)
  const { resolveReportUrl } = await import('../plugins/ii-ramis/scripts/report.mjs');
  const { REPORT_URL } = await import('../plugins/ii-ramis/scripts/report-config.mjs');
  check('IIRAMIS_REPORT_URL с чужим адресом игнорируется', resolveReportUrl('https://evil.example.com/x') === REPORT_URL && resolveReportUrl('http://127.0.0.1.evil.com/x') === REPORT_URL);
  check('IIRAMIS_REPORT_URL на localhost принимается (для тестов)', resolveReportUrl('http://127.0.0.1:5555/rest/v1/sessions') === 'http://127.0.0.1:5555/rest/v1/sessions');
}

// 8. install_id создаётся при установке и хранится в config.json
{
  const home = tempHome();
  const out = await new Promise((resolve) => execFile('node', [path.join(SCRIPTS, 'config.mjs'), 'show'], { env: { ...process.env, IIRAMIS_HOME: home } }, (_e, stdout) => resolve(stdout)));
  const saved = JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8'));
  check('install_id сгенерирован и сохранён в config.json', /^[A-Za-z0-9_-]{8,64}$/.test(saved.install_id) && out.length > 0);
}

console.log(failed === 0 ? 'REPORT-OK' : `REPORT-FAILED ${failed}`);
process.exit(failed === 0 ? 0 : 1);
