// SessionStart: автосохранение (git checkpoint) + короткая проверка инструментов. Без спама: тихо, если всё в порядке.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  STATE_FILE, RECAP_FILE, RECAP_MAX_CHARS, LEGACY_APPROVALS_FILE, loadConfig, readJson, writeJson, readStdinJson, mentionsSecretPath,
} from './lib.mjs';

const CONFIG_SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'config.mjs');
const MAX_CHANGED_FILES = 300;
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const PROJECT_MARKERS = ['package.json', 'index.html', 'pyproject.toml', 'requirements.txt', 'CLAUDE.md', 'next.config.js', 'vite.config.js'];

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 8000, windowsHide: true, maxBuffer: 64 * 1024 * 1024, ...options });
  return { ok: result.status === 0, out: (result.stdout || '').trim(), raw: result.stdout || '', err: (result.stderr || '').trim() };
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

// Формат `XY путь\0`; для переименований и копий следом идёт ещё одна запись со старым путём.
function parsePorcelainZ(raw) {
  const entries = raw.split('\0').filter(Boolean);
  const files = [];
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i];
    files.push(entry.slice(3));
    if (/^[RC]/.test(entry) || /^.[RC]/.test(entry)) {
      i += 1;
      if (entries[i]) files.push(entries[i]);
    }
  }
  return files;
}

function gitCheckpoint(cwd, config) {
  if (config.autosave === false) return null;
  if (!run('git', ['rev-parse', '--git-dir'], { cwd }).ok) return null;
  const top = run('git', ['rev-parse', '--show-toplevel'], { cwd }).out;
  if (!top || isHomeLike(path.resolve(top))) return null;
  const gitDir = run('git', ['rev-parse', '--git-dir'], { cwd }).out;
  const absGitDir = path.resolve(cwd, gitDir);
  if (['MERGE_HEAD', 'REBASE_HEAD', 'rebase-merge', 'rebase-apply', 'CHERRY_PICK_HEAD'].some((name) => fs.existsSync(path.join(absGitDir, name)))) return null;

  // -z: пути приходят как есть (без кавычек и экранирования), --untracked-files=all: файлы внутри новых папок тоже видны.
  const status = run('git', ['status', '--porcelain', '--untracked-files=all', '-z'], { cwd });
  if (!status.ok) return `Автосохранение пропущено: не смог получить список изменений (${status.err.slice(0, 100)}).`;
  const changed = parsePorcelainZ(status.raw);
  if (changed.length === 0) return null;
  if (changed.some((file) => mentionsSecretPath('/' + file))) {
    return 'Автосохранение пропущено: среди изменённых файлов есть файл с ключами, и он не в .gitignore. Добавь его в .gitignore сам (без чтения содержимого), потом сохрани.';
  }
  if (changed.length > MAX_CHANGED_FILES) {
    return `Автосохранение пропущено: изменилось ${changed.length} файлов. Скорее всего нет .gitignore для node_modules. Проверь и добавь его.`;
  }
  const identity = ['-c', 'user.name=Ученик ИИнутого', '-c', 'user.email=student@ii-ramis.local'];
  const hasName = run('git', ['config', 'user.name'], { cwd }).out;
  const hasEmail = run('git', ['config', 'user.email'], { cwd }).out;
  const prefix = hasName && hasEmail ? [] : identity;
  const added = run('git', ['add', '-A'], { cwd });
  const committed = run('git', [...prefix, 'commit', '-q', '--no-verify', '-m', 'checkpoint перед сессией'], { cwd });
  if (!added.ok || !committed.ok) return `Автосохранение не удалось: ${committed.err || added.err}`.slice(0, 200);
  return `Автосохранение: сделан коммит «checkpoint перед сессией» (${changed.length} изменённых файлов), в облако не отправлялся.`;
}

// Служебная уборка: старый файл одобрений больше не используется. Сбой здесь не должен ломать запуск.
function removeLegacyApprovals() {
  try {
    fs.rmSync(LEGACY_APPROVALS_FILE, { force: true });
  } catch (error) {
    console.error(`ii-ramis session-start: не удалил старый файл одобрений: ${error.message}`);
  }
}

// Пересказ каждой сессии начинается с чистого листа: старый текст не должен уйти под новой сессией.
function clearRecap() {
  try {
    fs.rmSync(RECAP_FILE, { force: true });
  } catch (error) {
    console.error(`ii-ramis session-start: не удалил старый пересказ: ${error.message}`);
  }
}

function consentNotes(config) {
  const notes = [];
  if (config.share_asked !== true) {
    notes.push('Согласие на пересказы: вопрос с одноразовым кодом тебе выдаст защитный хук, в служебной заметке к одному из ближайших сообщений ученика. Задай его слово в слово, когда получишь (после вопроса про урок), и не придумывай свой текст. ' +
      'Отправку включаешь не ты: её включит хук, когда ученик ответит «да <код>»; команда set share true для тебя закрыта. «Нет» хук запишет сам. На любой другой ответ отправка остаётся выключенной, не уговаривай. ' +
      'Когда отправка включится (проверь: node "' + CONFIG_SCRIPT + '" get share), спроси, как подписывать пересказ (имя или ник), и запиши: set student_name "Имя".');
  }
  if (config.share === true) {
    notes.push(`Ученик согласился на пересказы. Ведёшь пересказ сессии: файл ${RECAP_FILE} (создай инструментом Write, перезаписывай целиком). Текст: 2–3 предложения по-русски, до ${RECAP_MAX_CHARS} символов, что делал ученик, где застрял, о чём спрашивал. ` +
      'Без дословных сообщений, кода, путей, ключей, паролей, почт и телефонов. Обновляй после каждого заметного этапа и обязательно перед прощанием: хук отправит файл сам в конце сессии.');
  }
  return notes;
}

function main() {
  const input = readStdinJson();
  const cwd = input.cwd || process.cwd();
  const config = loadConfig();
  removeLegacyApprovals();
  clearRecap();
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

  notes.push(...consentNotes(config));

  const now = Date.now();
  if (!state.lastCheck || now - state.lastCheck > CHECK_INTERVAL_MS) {
    const missing = toolsMissing();
    if (missing.length > 0) {
      notes.push(`Не хватает: ${missing.join(', ')}. Поставь сам (brew/winget, объясни по-человечески зачем), потом проверь /ii-ramis:proverka.`);
    }
    writeJson(STATE_FILE, { ...state, lastCheck: now, lastMissing: missing });
  }

  const needsCheck = config.checked !== true;
  const checkTail = needsCheck
    ? ' Потом, в этой же сессии, САМ запусти проверку компьютера: навык /ii-ramis:proverka (ученика просить не надо, это часть знакомства). Проверка уже была и нашла проблемы, либо её ещё не было.'
    : '';
  if (config.lesson === null || config.lesson === undefined) {
    notes.push('Это первая сессия с ИИ Рамисом: коротко представься, честно скажи, что ты ИИ-помощник Рамиса, и спроси, какой урок курса ученик уже прошёл. Ответ запиши: node "' + CONFIG_SCRIPT + '" set lesson N.' + checkTail);
  } else if (needsCheck) {
    notes.push('Проверка компьютера ещё не проходила чисто (первый раз или прошлая нашла проблемы). В начале сессии, сразу после приветствия, САМ запусти навык /ii-ramis:proverka без просьбы ученика. Когда проверка пройдёт без пунктов [нет], она запишет checked=true, и больше в каждой сессии её навязывать не надо.');
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
