// SessionStart: автосохранение (git checkpoint) + короткая проверка инструментов. Без спама: тихо, если всё в порядке.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { STATE_FILE, loadConfig, readJson, writeJson, readStdinJson } from './lib.mjs';

const CONFIG_SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'config.mjs');
const MAX_CHANGED_FILES = 300;
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const PROJECT_MARKERS = ['package.json', 'index.html', 'pyproject.toml', 'requirements.txt', 'CLAUDE.md', 'next.config.js', 'vite.config.js'];
const SECRET_FILE = /(^|\/)(\.env(\.(?!example|sample|template)[\w-]+)?|[^/]+\.(pem|key|p12|pfx)|id_(rsa|ed25519|ecdsa|dsa))$/i;

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 8000, windowsHide: true, ...options });
  return { ok: result.status === 0, out: (result.stdout || '').trim(), err: (result.stderr || '').trim() };
}

function isHomeLike(dir) {
  const home = os.homedir();
  if (dir === home || dir === path.parse(dir).root) return true;
  return ['Desktop', 'Documents', 'Downloads', 'Рабочий стол', 'Документы'].some((name) => dir === path.join(home, name));
}

function looksLikeProject(dir) {
  return PROJECT_MARKERS.some((marker) => fs.existsSync(path.join(dir, marker)));
}

function toolsMissing() {
  const missing = [];
  const isMac = process.platform === 'darwin';
  // На маке без средств разработчика команда git открывает окно установки, поэтому сначала xcode-select.
  const gitAvailable = isMac ? run('xcode-select', ['-p']).ok && run('git', ['--version']).ok : run('git', ['--version']).ok;
  if (!gitAvailable) missing.push(isMac ? 'Git (инструменты разработчика Apple)' : 'Git');
  if (!run('gh', ['--version']).ok) missing.push('GitHub CLI (gh)');
  const python = run(process.platform === 'win32' ? 'python' : 'python3', ['--version']);
  if (!python.ok) missing.push('Python');
  return missing;
}

function gitCheckpoint(cwd, config) {
  if (config.autosave === false) return null;
  if (!run('git', ['rev-parse', '--git-dir'], { cwd }).ok) return null;
  const top = run('git', ['rev-parse', '--show-toplevel'], { cwd }).out;
  if (!top || isHomeLike(path.resolve(top))) return null;
  const gitDir = run('git', ['rev-parse', '--git-dir'], { cwd }).out;
  const absGitDir = path.resolve(cwd, gitDir);
  if (['MERGE_HEAD', 'REBASE_HEAD', 'rebase-merge', 'rebase-apply', 'CHERRY_PICK_HEAD'].some((name) => fs.existsSync(path.join(absGitDir, name)))) return null;

  const status = run('git', ['status', '--porcelain'], { cwd });
  if (!status.ok || !status.out) return null;
  const lines = status.out.split('\n');
  const secretLines = lines.filter((line) => SECRET_FILE.test(line.slice(3).replace(/"/g, '')));
  if (secretLines.length > 0) {
    return 'Автосохранение пропущено: файл с ключами не в .gitignore. Добавь его в .gitignore сам (без чтения содержимого), потом сохрани.';
  }
  if (lines.length > MAX_CHANGED_FILES) {
    return `Автосохранение пропущено: изменилось ${lines.length} файлов. Скорее всего нет .gitignore для node_modules. Проверь и добавь его.`;
  }
  const identity = ['-c', 'user.name=Ученик ИИнутого', '-c', 'user.email=student@ii-ramis.local'];
  const hasName = run('git', ['config', 'user.name'], { cwd }).out;
  const hasEmail = run('git', ['config', 'user.email'], { cwd }).out;
  const prefix = hasName && hasEmail ? [] : identity;
  const added = run('git', ['add', '-A'], { cwd });
  const committed = run('git', [...prefix, 'commit', '-q', '--no-verify', '-m', 'checkpoint перед сессией'], { cwd });
  if (!added.ok || !committed.ok) return `Автосохранение не удалось: ${committed.err || added.err}`.slice(0, 200);
  return `Автосохранение: сделан коммит «checkpoint перед сессией» (${lines.length} изменённых файлов), в облако не отправлялся.`;
}

function main() {
  const input = readStdinJson();
  const cwd = input.cwd || process.cwd();
  const config = loadConfig();
  const state = readJson(STATE_FILE, {});
  const notes = [];

  const checkpoint = gitCheckpoint(cwd, config);
  if (checkpoint) notes.push(checkpoint);

  const insideRepo = run('git', ['rev-parse', '--git-dir'], { cwd }).ok;
  if (!insideRepo && !isHomeLike(cwd) && looksLikeProject(cwd)) {
    const gitReady = process.platform !== 'darwin' || run('xcode-select', ['-p']).ok;
    notes.push(gitReady
      ? 'Папка выглядит как проект, но это не git-репозиторий (нет «сохранений как в игре»). Предложи ученику одной фразой: «сделать сохранения? скажи да», после «да» выполни git init и первый коммит.'
      : 'Папка выглядит как проект, но Git на этом маке ещё не установлен (нужны инструменты разработчика Apple). Объясни ученику простыми словами, зачем это, и помоги поставить.');
  }

  const now = Date.now();
  if (!state.lastCheck || now - state.lastCheck > CHECK_INTERVAL_MS) {
    const missing = toolsMissing();
    if (missing.length > 0) {
      notes.push(`Не хватает: ${missing.join(', ')}. Поставь сам (brew/winget, объясни по-человечески зачем), потом проверь /ii-ramis:proverka.`);
    }
    writeJson(STATE_FILE, { ...state, lastCheck: now, lastMissing: missing });
  }

  if (config.lesson === null || config.lesson === undefined) {
    notes.push('Это первая сессия с ИИ Рамисом: коротко представься, честно скажи, что ты ИИ-помощник Рамиса, и спроси, какой урок курса ученик уже прошёл. Ответ запиши: node "' + CONFIG_SCRIPT + '" set lesson N.');
  }

  if (notes.length === 0) return;
  const additionalContext = 'ИИ Рамис, служебное по запуску (скажи ученику коротко, без списков, только если это важно):\n- ' + notes.join('\n- ');
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext } }));
}

try {
  main();
} catch (error) {
  console.error(`ii-ramis session-start: ${error.message}`);
}
process.exit(0);
