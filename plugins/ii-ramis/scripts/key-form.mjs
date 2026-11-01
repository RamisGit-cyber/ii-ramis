// Локальная форма для ввода ключей: ученик вставляет их в браузере, Claude значений не видит.
// Использование:
//   node key-form.mjs --project <папка> --vars ИМЯ1,ИМЯ2 [--secret ИМЯ3] [--vercel] [--title "Название"]
// Значения ключей через аргументы НЕ принимаются (только имена). Сервер слушает 127.0.0.1, живёт до первого успешного сохранения
// или 10 минут. В stdout попадают только имена и места сохранения, значений там нет никогда.
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import {
  FormError, checkNames, checkValue, resolveProject, writeEnvFile, ENV_FILE_NAME, ensureGitignore, ensureEnvExample,
} from './key-form-lib.mjs';
import { renderPage } from './key-form-page.mjs';
import { sendToVercel } from './key-form-vercel.mjs';

const LIFETIME_MS = 10 * 60 * 1000;
const MAX_BODY_BYTES = 16 * 1024;
const FLAGS_WITH_VALUE = new Set(['--project', '--vars', '--secret', '--title']);
const FLAGS_WITHOUT_VALUE = new Set(['--vercel']);

function parseArguments(argv) {
  const options = { project: '', vars: [], secret: [], vercel: false, title: 'Ключи проекта' };
  const seen = new Set();
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (seen.has(flag)) throw new FormError('один и тот же параметр указан дважды');
    if (FLAGS_WITHOUT_VALUE.has(flag)) { options.vercel = true; seen.add(flag); continue; }
    if (!FLAGS_WITH_VALUE.has(flag)) throw new FormError('неизвестный параметр; допустимы --project, --vars, --secret, --vercel, --title (значения ключей в команду не передаются)');
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) throw new FormError(`у параметра ${flag} нет значения`);
    i += 1;
    seen.add(flag);
    if (flag === '--project') options.project = value;
    if (flag === '--title') options.title = value;
    if (flag === '--vars') options.vars = value.split(',').filter(Boolean);
    if (flag === '--secret') options.secret = value.split(',').filter(Boolean);
  }
  if (!/^[\p{L}\p{N} ._,:()«»-]{1,60}$/u.test(options.title)) throw new FormError('--title: до 60 букв, цифр и простых знаков');
  checkNames(options.vars, options.secret);
  options.project = resolveProject(options.project);
  return options;
}

function sameToken(given, expected) {
  const digest = (text) => crypto.createHash('sha256').update(String(text)).digest();
  return crypto.timingSafeEqual(digest(given), digest(expected));
}

function openInBrowser(url, onFailure) {
  const commands = {
    darwin: ['open', [url]],
    win32: [path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe'), ['/c', 'start', '', url]], // url наш: http://127.0.0.1:порт/?t=токен, без символов, значимых для cmd
  };
  const [command, args] = commands[process.platform] || ['xdg-open', [url]];
  try {
    const child = spawn(command, args, { stdio: 'ignore', detached: true, windowsHide: true, cwd: os.tmpdir() });
    child.on('error', onFailure);
    child.on('close', (code) => { if (code !== 0) onFailure(); });
    child.unref();
  } catch {
    onFailure();
  }
}

function summarize({ project, names, gitignoreChanged, exampleChanged, vercel }) {
  const lines = [`Сохранено в ${ENV_FILE_NAME}: ${names.join(', ')}`, `Папка проекта: ${project}`];
  lines.push(gitignoreChanged ? '.gitignore: добавлена защита файлов с ключами' : '.gitignore: защита файлов с ключами уже была');
  lines.push(exampleChanged ? '.env.example: добавлены имена без значений' : '.env.example: уже в порядке');
  if (vercel) {
    if (vercel.notLinked) lines.push('Vercel: проект не привязан (нет .vercel/project.json), в Vercel ничего не отправлено. Сначала выполни npx vercel link');
    if (vercel.sent.length > 0) lines.push(`Vercel (production): отправлено ${vercel.sent.join(', ')}`);
    for (const { name, why } of vercel.failed) lines.push(`Vercel: ${name} не отправлена, ${why}`);
  }
  return lines;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const names = [...options.vars, ...options.secret];
  const secretNames = new Set(options.secret);
  const fields = names.map((name) => ({ name, secret: secretNames.has(name) }));
  const token = crypto.randomBytes(24).toString('base64url');
  let port = 0;
  let busy = false;
  let finished = false;

  const hostOk = (host) => host === `127.0.0.1:${port}` || host === `localhost:${port}`;
  const originOk = (origin) => origin === `http://127.0.0.1:${port}` || origin === `http://localhost:${port}`;
  const tokenOk = (url) => sameToken(url.searchParams.get('t') || '', token);

  function reply(res, status, body, type = 'text/plain; charset=utf-8', extra = {}) {
    res.writeHead(status, {
      'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
      'Cross-Origin-Resource-Policy': 'same-origin', ...extra,
    });
    res.end(body);
  }
  function replyTooLarge(req, res) {
    if (res.headersSent) return;
    reply(res, 413, 'too large', 'text/plain; charset=utf-8', { Connection: 'close' });
    res.on('finish', () => req.destroy());
  }
  const replyJson = (res, status, payload) => reply(res, status, JSON.stringify(payload), 'application/json; charset=utf-8');

  async function handleSave(body, res) {
    let values;
    try { values = JSON.parse(body).values; } catch { replyJson(res, 400, { ok: false, message: 'Не разобрал данные формы.' }); return; }
    if (!values || typeof values !== 'object' || Array.isArray(values)) { replyJson(res, 400, { ok: false, message: 'Не разобрал данные формы.' }); return; }
    const errors = {};
    const clean = {};
    for (const name of names) {
      const problem = checkValue(name, values[name]);
      if (problem) errors[name] = problem;
      else clean[name] = values[name].trim();
    }
    if (Object.keys(errors).length > 0) { replyJson(res, 422, { ok: false, errors }); return; }

    let result;
    try {
      writeEnvFile(options.project, clean);
      result = {
        project: options.project,
        names,
        gitignoreChanged: ensureGitignore(options.project),
        exampleChanged: ensureEnvExample(options.project, names),
        vercel: options.vercel ? await sendToVercel(options.project, clean) : null,
      };
    } catch (error) {
      const message = error instanceof FormError ? error.message : `не удалось записать файлы (${error.code || 'ошибка'})`;
      process.stderr.write(`Ошибка записи: ${message}\n`);
      replyJson(res, 500, { ok: false, message: `Не получилось сохранить: ${message}` });
      return;
    }
    const vercelFailed = Boolean(result.vercel && (result.vercel.notLinked || result.vercel.failed.length > 0));
    const message = vercelFailed
      ? 'Ключи сохранены на компьютере, но в Vercel отправить не вышло. Вернись в Claude: он подскажет, что делать.'
      : 'Готово, ключи сохранены. Можно закрыть вкладку и вернуться в Claude.';
    replyJson(res, 200, { ok: true, message });
    finish(vercelFailed ? 3 : 0, summarize(result));
  }

  const server = http.createServer((req, res) => {
    if (finished) { reply(res, 404, 'not found'); return; }
    let url;
    try { url = new URL(req.url, `http://127.0.0.1:${port}`); } catch { reply(res, 400, 'bad request'); return; }
    if (!hostOk(req.headers.host)) { reply(res, 403, 'forbidden'); return; } // защита от DNS rebinding
    if (!tokenOk(url)) { reply(res, 404, 'not found'); return; }
    if (req.method === 'GET' && url.pathname === '/') {
      const nonce = crypto.randomBytes(16).toString('base64');
      const csp = `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; connect-src 'self'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'`;
      reply(res, 200, renderPage({ title: options.title, fields, project: options.project, vercel: options.vercel, nonce }), 'text/html; charset=utf-8', { 'Content-Security-Policy': csp, 'X-Frame-Options': 'DENY' });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/save') {
      if (!originOk(req.headers.origin)) { reply(res, 403, 'forbidden'); return; }
      if (!String(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) { reply(res, 415, 'unsupported'); return; }
      if (Number(req.headers['content-length'] || 0) > MAX_BODY_BYTES) { replyTooLarge(req, res); return; }
      const chunks = [];
      let size = 0;
      req.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) { replyTooLarge(req, res); return; }
        chunks.push(chunk);
      });
      req.on('end', () => {
        if (size > MAX_BODY_BYTES || res.writableEnded) return;
        if (busy) { replyJson(res, 409, { ok: false, message: 'Сохранение уже идёт.' }); return; }
        busy = true;
        handleSave(Buffer.concat(chunks).toString('utf8'), res).finally(() => { busy = false; });
      });
      return;
    }
    reply(res, 404, 'not found');
  });

  function finish(code, lines) {
    if (finished) return;
    finished = true;
    if (lines.length > 0) process.stdout.write(`${lines.join('\n')}\n`);
    server.close();
    server.closeAllConnections?.();
    setTimeout(() => process.exit(code), 100);
  }

  const timer = setTimeout(() => finish(4, ['Время вышло (10 минут): форма закрыта, ничего не сохранено. Запусти форму заново.']), LIFETIME_MS);
  timer.unref();
  process.on('SIGINT', () => finish(130, ['Форма закрыта, ничего не сохранено.']));
  process.on('SIGTERM', () => finish(130, ['Форма закрыта, ничего не сохранено.']));

  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  port = server.address().port;
  const address = `http://127.0.0.1:${port}/?t=${token}`;
  process.stderr.write('Форма ключей открывается в браузере. Жду, пока ученик вставит значения и нажмёт «Сохранить» (до 10 минут).\n');
  // Адрес с токеном показываем только если браузер не открылся сам.
  openInBrowser(address, () => {
    // Сначала пробуем показать адрес прямо в окне терминала ученика (Claude его не видит); если окна нет, выводим в stderr.
    try {
      const terminal = fs.openSync(process.platform === 'win32' ? 'CON' : '/dev/tty', 'w');
      fs.writeSync(terminal, `Браузер не открылся сам. Открой этот адрес вручную: ${address}\n`);
      fs.closeSync(terminal);
      process.stderr.write('Браузер не открылся сам; адрес показан в окне терминала ученика.\n');
    } catch {
      // Адрес с токеном в вывод не печатаем: его прочитал бы Claude и смог бы сам отправить форму.
      process.stderr.write('Форма ключей не открылась: браузер не запустился, а окна терминала нет. Подключи коннектор (Настройки → Коннекторы) или попроси Рамиса помочь.\n');
      server.close();
      process.exitCode = 1;
    }
  });
}

main().catch((error) => {
  const message = error instanceof FormError ? error.message : `непредвиденная ошибка (${error.code || error.name})`;
  process.stderr.write(`Форма ключей не запущена: ${message}\n`);
  process.exit(2);
});
