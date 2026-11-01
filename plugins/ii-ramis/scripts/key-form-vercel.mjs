// Отправка переменных в Vercel через `npx vercel env add`. Значение уходит через stdin, в аргументах его нет;
// вывод vercel наружу не печатаем (вдруг там эхо), сообщаем только короткий итог.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const STEP_TIMEOUT_MS = 90_000;
const SAFE_ARGUMENT = /^([A-Z][A-Z0-9_]{0,63}|env|add|rm|production|--yes)$/;
// Свою папку для npx не берём: в папке проекта (её выбирает Claude) мог лежать подложенный node_modules/.bin/vercel или .npmrc.

function runVercel(project, args, stdinText) {
  return new Promise((resolve) => {
    if (!args.every((argument) => SAFE_ARGUMENT.test(argument))) { resolve({ ok: false, output: '', reason: 'bad-args' }); return; }
    const neutralDir = fs.mkdtempSync(path.join(os.tmpdir(), 'iiramis-vercel-'));
    const launcher = npxLauncher();
    if (!launcher) { fs.rmSync(neutralDir, { recursive: true, force: true }); resolve({ ok: false, output: '', reason: 'spawn' }); return; }
    const child = spawn(launcher.command, [...launcher.prefix, '--yes', 'vercel', ...args, '--cwd', project], { cwd: neutralDir, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const cleanup = () => fs.rmSync(neutralDir, { recursive: true, force: true });
    let output = '';
    const timer = setTimeout(() => { child.kill(); resolve({ ok: false, output, reason: 'timeout' }); }, STEP_TIMEOUT_MS);
    const collect = (chunk) => { output = (output + chunk).slice(-4000); };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.on('error', () => { clearTimeout(timer); cleanup(); resolve({ ok: false, output, reason: 'spawn' }); });
    child.on('close', (code) => { clearTimeout(timer); cleanup(); resolve({ ok: code === 0, output, reason: code === 0 ? '' : 'exit' }); });
    child.stdin.on('error', () => {}); // vercel мог закрыть ввод раньше: итог всё равно узнаем по коду выхода
    child.stdin.end(stdinText === undefined ? '' : `${stdinText}\n`);
  });
}

// На Windows npx — это npx.cmd, который без shell не запустить, а с shell cmd.exe ищет его сначала в текущей папке.
// Поэтому запускаем npx-cli.js из папки установленного Node прямо через node, без shell.
function npxLauncher() {
  if (process.platform !== 'win32') return { command: 'npx', prefix: [] };
  const cli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npx-cli.js');
  return fs.existsSync(cli) ? { command: process.execPath, prefix: [cli] } : null;
}

export function isLinkedToVercel(project) {
  return fs.existsSync(path.join(project, '.vercel', 'project.json'));
}

function explain(result) {
  if (result.reason === 'timeout') return 'Vercel не ответил за 90 секунд';
  if (result.reason === 'spawn') return 'не удалось запустить npx (проверь, что Node.js установлен)';
  if (/not logged in|no existing credentials|log in|login|token/i.test(result.output)) return 'ты не вошёл в Vercel (один раз выполни вход: npx vercel login)';
  return 'Vercel вернул ошибку';
}

// values: { ИМЯ: значение }. Возвращает { sent: [имена], failed: [{name, why}], notLinked: boolean }.
export async function sendToVercel(project, values) {
  if (!isLinkedToVercel(project)) return { sent: [], failed: [], notLinked: true };
  const sent = [];
  const failed = [];
  for (const [name, value] of Object.entries(values)) {
    let result = await runVercel(project, ['env', 'add', name, 'production'], value);
    if (!result.ok && /already exists/i.test(result.output)) {
      const removed = await runVercel(project, ['env', 'rm', name, 'production', '--yes']);
      if (removed.ok) {
        result = await runVercel(project, ['env', 'add', name, 'production'], value);
        if (!result.ok) { failed.push({ name, why: 'старое значение в Vercel удалено, а новое добавить не вышло: запусти форму ещё раз' }); continue; }
      }
    }
    if (result.ok) sent.push(name);
    else failed.push({ name, why: explain(result) });
  }
  return { sent, failed, notLinked: false };
}
