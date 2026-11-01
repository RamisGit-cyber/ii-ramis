// Проверка формы ключей (key-form.mjs): запись файлов, защита адреса, отказы и то, что значение ключа не попадает в вывод.
// Браузер и npx подменяются заглушками в PATH, настоящий браузер и настоящий Vercel не нужны.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const FORM = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'plugins', 'ii-ramis', 'scripts', 'key-form.mjs');
const ENV_FILE = '.env' + '.local';
const SECRET_VALUE = 'sb_secret_TESTVALUE123456789';
const PUBLIC_VALUE = 'sb_publishable_TESTVALUE987654321';
let failed = 0;

function check(title, condition, detail = '') {
  if (condition) console.log(`  ok   key-form: ${title}`);
  else { failed += 1; console.log(`  FAIL key-form: ${title} ${detail}`); }
}

if (process.platform === 'win32') {
  console.log('  --   key-form: тесты с заглушками браузера рассчитаны на Mac/Linux, на Windows пропущены');
  process.exit(0);
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keyform-'));
const fakeBin = path.join(root, 'bin');
fs.mkdirSync(fakeBin);
for (const name of ['open', 'xdg-open']) {
  fs.writeFileSync(path.join(fakeBin, name), '#!/bin/sh\nprintf %s "$1" > "$KEYFORM_URL_FILE"\n', { mode: 0o755 });
}
fs.writeFileSync(path.join(fakeBin, 'npx'), [
  '#!/bin/sh',
  'echo "$@" >> "$KEYFORM_NPX_LOG"',
  'cat >> "$KEYFORM_NPX_STDIN"',
  'exit 0', '',
].join('\n'), { mode: 0o755 });

function newProject(name) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir);
  if (!name.startsWith('nomarker')) fs.writeFileSync(path.join(dir, 'package.json'), '{}');
  return dir;
}

function startForm(args, tag) {
  const urlFile = path.join(root, `${tag}.url`);
  const npxLog = path.join(root, `${tag}.npx.log`);
  const npxStdin = path.join(root, `${tag}.npx.stdin`);
  const child = spawn(process.execPath, [FORM, ...args], {
    env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH}`, KEYFORM_URL_FILE: urlFile, KEYFORM_NPX_LOG: npxLog, KEYFORM_NPX_STDIN: npxStdin },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const run = { child, out: '', err: '', urlFile, npxLog, npxStdin };
  child.stdout.on('data', (d) => { run.out += d; });
  child.stderr.on('data', (d) => { run.err += d; });
  run.exit = new Promise((resolve) => child.on('close', (code) => resolve(code)));
  run.url = new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (fs.existsSync(urlFile) && fs.readFileSync(urlFile, 'utf8').includes('?t=')) { clearInterval(timer); resolve(new URL(fs.readFileSync(urlFile, 'utf8'))); }
      else if (Date.now() - started > 8000) { clearInterval(timer); reject(new Error('форма не открылась за 8 секунд')); }
    }, 50);
    run.exit.then(() => { clearInterval(timer); reject(new Error('форма завершилась до открытия')); });
  });
  run.url.catch(() => {});
  return run;
}

function request(url, { method = 'GET', headers = {}, body, pathAndQuery } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: url.port, path: pathAndQuery ?? `${url.pathname}${url.search}`, method, headers }, (res) => {
      let text = '';
      res.on('data', (d) => { text += d; });
      res.on('end', () => resolve({ status: res.statusCode, text, headers: res.headers }));
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

const origin = (url) => `http://127.0.0.1:${url.port}`;
const post = (url, values, extra = {}) => request(url, {
  method: 'POST', pathAndQuery: extra.pathAndQuery ?? `/save?t=${url.searchParams.get('t')}`,
  headers: { 'Content-Type': 'application/json', Origin: origin(url), ...(extra.headers || {}) },
  body: extra.rawBody ?? JSON.stringify({ values }),
});
const cleanup = (run) => { run.child.kill('SIGKILL'); };

// ---- 1. Обычное сохранение, чужие переменные и .gitignore сохраняются ----
{
  const project = newProject('happy');
  fs.writeFileSync(path.join(project, ENV_FILE), '# мой файл\nOTHER_VAR=keep-me\r\nNEXT_PUBLIC_SUPABASE_URL=https://old.example.com\n'.replace(/\r\n/g, '\n'));
  fs.writeFileSync(path.join(project, '.gitignore'), 'node_modules');
  const run = startForm(['--project', project, '--vars', 'NEXT_PUBLIC_SUPABASE_URL,NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY', '--secret', 'SUPABASE_SECRET_KEY', '--title', 'Ключи Supabase'], 'happy');
  const url = await run.url;
  check('адрес слушает только 127.0.0.1', url.hostname === '127.0.0.1');
  check('токен в адресе длинный', (url.searchParams.get('t') || '').length >= 24);

  const page = await request(url);
  check('страница открывается с токеном', page.status === 200 && page.text.includes('NEXT_PUBLIC_SUPABASE_URL') && page.text.includes('SUPABASE_SECRET_KEY'));
  check('поля скрытые (password) и есть кнопка «показать»', page.text.includes('type="password"') && page.text.includes('показать'));
  check('подсказка про Supabase: Project Settings → API Keys', page.text.includes('Project Settings') && page.text.includes('API Keys'));
  check('страница с защитными заголовками', /script-src 'nonce-/.test(page.headers['content-security-policy'] || '') && page.headers['cache-control'] === 'no-store');
  check('секретная переменная помечена', page.text.includes('секретный'));

  const noToken = await request(url, { pathAndQuery: '/' });
  check('без токена: 404', noToken.status === 404);
  const badToken = await request(url, { pathAndQuery: '/?t=wrong' });
  check('с неверным токеном: 404', badToken.status === 404);
  const evilHost = await request(url, { headers: { Host: 'evil.example.com' } });
  check('чужой Host: 403 (защита от DNS rebinding)', evilHost.status === 403);
  const evilHostPort = await request(url, { headers: { Host: `evil.example.com:${url.port}` } });
  check('чужой Host с тем же портом: 403', evilHostPort.status === 403);

  const values = { NEXT_PUBLIC_SUPABASE_URL: 'https://abcd.supabase.co', NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: PUBLIC_VALUE, SUPABASE_SECRET_KEY: SECRET_VALUE };
  const wrongToken = await post(url, values, { pathAndQuery: '/save?t=nope' });
  check('POST с неверным токеном: 404', wrongToken.status === 404);
  const noOrigin = await request(url, { method: 'POST', pathAndQuery: `/save?t=${url.searchParams.get('t')}`, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ values }) });
  check('POST без Origin: 403', noOrigin.status === 403);
  const evilOrigin = await post(url, values, { headers: { Origin: 'http://evil.example.com' } });
  check('POST с чужим Origin: 403', evilOrigin.status === 403);
  const evilPostHost = await post(url, values, { headers: { Host: 'evil.example.com' } });
  check('POST с чужим Host: 403', evilPostHost.status === 403);
  const textPlain = await post(url, values, { headers: { 'Content-Type': 'text/plain' } });
  check('POST не JSON: 415', textPlain.status === 415);
  const huge = await post(url, {}, { rawBody: JSON.stringify({ values: { A: 'x'.repeat(20000) } }) }).catch(() => ({ status: 413 }));
  check('тело больше 16 КБ: 413 или обрыв', huge.status === 413);
  check('после отказов ничего не записано', !fs.existsSync(path.join(project, '.env.example')) && fs.readFileSync(path.join(project, ENV_FILE), 'utf8').includes('old.example.com'));

  const badValues = await post(url, { NEXT_PUBLIC_SUPABASE_URL: 'http://abcd.supabase.co', NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'a\nb', SUPABASE_SECRET_KEY: 'has"quote' });
  const badBody = JSON.parse(badValues.text);
  check('плохие значения: 422 с ошибками по полям', badValues.status === 422 && Object.keys(badBody.errors).length === 3);
  check('ответ с ошибками не возвращает значения', !badValues.text.includes('has"quote') && !badValues.text.includes('abcd.supabase'));
  check('плохие значения ничего не записали', fs.readFileSync(path.join(project, ENV_FILE), 'utf8').includes('old.example.com'));

  const saved = await post(url, values);
  check('сохранение: 200 ok', saved.status === 200 && JSON.parse(saved.text).ok === true);
  check('ответ сохранения не содержит значений', !saved.text.includes(SECRET_VALUE) && !saved.text.includes(PUBLIC_VALUE));
  const code = await run.exit;
  check('после сохранения процесс завершился с кодом 0', code === 0, `код ${code}`);

  const envText = fs.readFileSync(path.join(project, ENV_FILE), 'utf8');
  check('файл ключей: новые значения записаны', envText.includes(`SUPABASE_SECRET_KEY=${SECRET_VALUE}`) && envText.includes(`NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=${PUBLIC_VALUE}`));
  check('файл ключей: URL заменён, а не продублирован', envText.includes('NEXT_PUBLIC_SUPABASE_URL=https://abcd.supabase.co') && !envText.includes('old.example.com') && envText.split('NEXT_PUBLIC_SUPABASE_URL=').length === 2);
  check('файл ключей: чужая переменная и комментарий сохранены', envText.includes('OTHER_VAR=keep-me') && envText.includes('# мой файл'));
  check('файл ключей: права 600', (fs.statSync(path.join(project, ENV_FILE)).mode & 0o777) === 0o600);
  const gitignore = fs.readFileSync(path.join(project, '.gitignore'), 'utf8').split('\n');
  check('.gitignore: старое осталось, добавлены .env* и !.env.example', gitignore.includes('node_modules') && gitignore.includes('.env*') && gitignore.includes('!.env.example') && gitignore.indexOf('!.env.example') > gitignore.indexOf('.env*'));
  const example = fs.readFileSync(path.join(project, '.env.example'), 'utf8');
  check('.env.example: только имена без значений', example.includes('SUPABASE_SECRET_KEY=\n') && !example.includes(SECRET_VALUE) && !example.includes('supabase.co'));
  check('stdout: есть имена, нет значений', run.out.includes('SUPABASE_SECRET_KEY') && !run.out.includes(SECRET_VALUE) && !run.out.includes(PUBLIC_VALUE) && !run.out.includes('abcd.supabase.co'));
  check('stderr: нет значений и нет адреса с токеном (браузер открылся)', !run.err.includes(SECRET_VALUE) && !run.err.includes(url.searchParams.get('t')));
  check('после сохранения сервер закрыт', await request(url).then(() => false, () => true));
}

// ---- 2. Повторный запуск: .gitignore уже в порядке не дублируется, .env.example не затирается ----
{
  const project = newProject('again');
  fs.writeFileSync(path.join(project, '.gitignore'), '.env*\n!.env.example\n');
  fs.writeFileSync(path.join(project, '.env.example'), 'MY_NAME=\n');
  const run = startForm(['--project', project, '--vars', 'MY_NAME,MY_OTHER'], 'again');
  const url = await run.url;
  const result = await post(url, { MY_NAME: 'abc', MY_OTHER: 'def' });
  await run.exit;
  check('повторный запуск: 200', result.status === 200);
  check('.gitignore не дублируется', fs.readFileSync(path.join(project, '.gitignore'), 'utf8') === '.env*\n!.env.example\n');
  check('.env.example дополнен, старое цело', fs.readFileSync(path.join(project, '.env.example'), 'utf8') === 'MY_NAME=\nMY_OTHER=\n');
}

// ---- 3. Отказы при запуске: секрет с публичным префиксом, значения в аргументах, чужие папки ----
async function expectRefusal(title, args, secretsToHide = []) {
  const project = newProject(`refuse-${Math.random().toString(36).slice(2, 8)}`);
  const run = startForm(args.map((a) => (a === '<project>' ? project : a)), `r${Math.random().toString(36).slice(2, 8)}`);
  const code = await run.exit;
  const combined = run.out + run.err;
  check(`${title}: код 2`, code === 2, `код ${code}`);
  check(`${title}: сервер не поднялся, файлов нет`, !fs.existsSync(run.urlFile) && !fs.existsSync(path.join(project, ENV_FILE)));
  check(`${title}: значение не эхом в вывод`, secretsToHide.every((s) => !combined.includes(s)));
  return run;
}
await expectRefusal('секретная NEXT_PUBLIC_ отказ', ['--project', '<project>', '--secret', 'NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY']);
await expectRefusal('секретная VITE_ отказ', ['--project', '<project>', '--secret', 'VITE_SECRET_TOKEN']);
await expectRefusal('значение в --vars', ['--project', '<project>', '--vars', `API_KEY=${SECRET_VALUE}`], [SECRET_VALUE]);
await expectRefusal('значение флагом --value', ['--project', '<project>', '--vars', 'API_KEY', '--value', SECRET_VALUE], [SECRET_VALUE]);
await expectRefusal('значение позиционным аргументом', ['--project', '<project>', '--vars', 'API_KEY', SECRET_VALUE], [SECRET_VALUE]);
await expectRefusal('опасное имя PATH', ['--project', '<project>', '--vars', 'PATH']);
await expectRefusal('NODE_OPTIONS', ['--project', '<project>', '--vars', 'NODE_OPTIONS']);
await expectRefusal('одно имя в --vars и --secret', ['--project', '<project>', '--vars', 'API_KEY', '--secret', 'API_KEY']);
await expectRefusal('публичное имя с TOKEN в --vars', ['--project', '<project>', '--vars', 'NEXT_PUBLIC_API_TOKEN']);
await expectRefusal('публичное имя SERVICE_ROLE в --vars', ['--project', '<project>', '--vars', 'NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY']);
await expectRefusal('BROWSER', ['--project', '<project>', '--vars', 'BROWSER']);
await expectRefusal('HTTPS_PROXY', ['--project', '<project>', '--vars', 'HTTPS_PROXY']);
await expectRefusal('папка без признаков проекта', ['--project', newProject('nomarker-x'), '--vars', 'API_KEY']);
await expectRefusal('нет проекта', ['--vars', 'API_KEY']);
await expectRefusal('папка Claude Code', ['--project', path.join(os.homedir(), '.claude'), '--vars', 'API_KEY']);
await expectRefusal('папка самого плагина', ['--project', path.dirname(FORM), '--vars', 'API_KEY']);
await expectRefusal('домашняя папка', ['--project', os.homedir(), '--vars', 'API_KEY']);

// ---- 3б. Значения с # ; & и т.п. не принимаются (dotenv обрежет по #, shell выполнил бы) ----
{
  const project = newProject('chars');
  const run = startForm(['--project', project, '--vars', 'AAA,BBB,CCC'], 'chars');
  const url = await run.url;
  const result = await post(url, { AAA: 'abc#def', BBB: 'a;b', CCC: 'a&b' });
  check('значения с #, ; и & отклонены (422)', result.status === 422 && Object.keys(JSON.parse(result.text).errors).length === 3);
  check('ничего не записано', !fs.existsSync(path.join(project, ENV_FILE)));
  cleanup(run);
}

// ---- 4. Vercel: значение идёт через stdin, не через аргументы; без привязки не падаем ----
{
  const project = newProject('vercel');
  fs.mkdirSync(path.join(project, '.vercel'));
  fs.writeFileSync(path.join(project, '.vercel', 'project.json'), '{}');
  const run = startForm(['--project', project, '--vars', 'APP_URL', '--secret', 'APP_SECRET', '--vercel'], 'vercel');
  const url = await run.url;
  const result = await post(url, { APP_URL: 'https://example.com', APP_SECRET: SECRET_VALUE });
  const code = await run.exit;
  check('vercel: 200 и код 0', result.status === 200 && code === 0, `код ${code}`);
  const log = fs.existsSync(run.npxLog) ? fs.readFileSync(run.npxLog, 'utf8') : '';
  const stdin = fs.existsSync(run.npxStdin) ? fs.readFileSync(run.npxStdin, 'utf8') : '';
  check('vercel: вызваны env add для каждой переменной (production)', log.includes('vercel env add APP_URL production') && log.includes('vercel env add APP_SECRET production') && log.includes('--cwd'));
  check('vercel: значение пришло через stdin', stdin.includes(SECRET_VALUE) && stdin.includes('https://example.com'));
  check('vercel: в аргументах значений нет', !log.includes(SECRET_VALUE) && !log.includes('example.com'));
  check('vercel: stdout без значений, но с именами', run.out.includes('APP_SECRET') && !run.out.includes(SECRET_VALUE));
}
{
  const project = newProject('vercel-unlinked');
  const run = startForm(['--project', project, '--secret', 'APP_SECRET', '--vercel'], 'unlinked');
  const url = await run.url;
  const result = await post(url, { APP_SECRET: SECRET_VALUE });
  const code = await run.exit;
  check('vercel без привязки: файл записан, код 3, понятное сообщение', result.status === 200 && code === 3 && run.out.includes('не привязан') && fs.readFileSync(path.join(project, ENV_FILE), 'utf8').includes(SECRET_VALUE));
  check('vercel без привязки: npx не вызывался', !fs.existsSync(run.npxLog));
  check('vercel без привязки: значение не в выводе', !(run.out + run.err).includes(SECRET_VALUE));
}

fs.rmSync(root, { recursive: true, force: true });
if (failed > 0) { console.log(`key-form: провалено ${failed}`); process.exit(1); }
console.log('key-form: всё ок');
