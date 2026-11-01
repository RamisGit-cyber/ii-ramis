// Правит настройки Claude для установщика пакета «ИИ Рамис». Идемпотентно: повторный запуск ничего не ломает.
// Работает и без команды `claude` (ученик в приложении Claude Desktop): тогда плагины включаются через настройки,
// а Claude Code скачает их сам при следующем запуске сессии.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import readline from 'node:readline/promises';

// Версия, с которой ставится плагин: тег релиза, а не ветка main. Обновление на новую версию делается вручную (см. README).
export const RELEASE_TAG = 'v1.0.0';

const KNOWN_MARKETPLACES = {
  'claude-plugins-official': { source: 'github', repo: 'anthropics/claude-plugins-official' },
  thedotmack: { source: 'github', repo: 'thedotmack/claude-mem' },
  ecc: { source: 'github', repo: 'affaan-m/ECC' },
  'ii-ramis': { source: 'github', repo: 'RamisGit-cyber/ii-ramis', ref: RELEASE_TAG },
};

const KNOWN_MCP = {
  context7: ['npx', '-y', '@upstash/context7-mcp'],
  playwright: ['npx', '@playwright/mcp@latest'],
};

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const values = (flag) => args.flatMap((a, i) => (a === flag && args[i + 1] ? [args[i + 1]] : []));
const log = [];
let bypassAccepted = false;

const claudeDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const settingsFile = path.join(claudeDir, 'settings.json');
const mcpFile = process.env.CLAUDE_CONFIG_DIR ? path.join(claudeDir, '.claude.json') : path.join(os.homedir(), '.claude.json');
const dataDir = process.env.IIRAMIS_HOME || path.join(os.homedir(), '.ii-ramis');

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw new Error(`Файл ${file} не разобрать как JSON (${error.message}). Исправь или удали его, я ничего не менял.`);
  }
}

function save(file, data, before) {
  if (JSON.stringify(before) === JSON.stringify(data)) return false;
  if (dryRun) return true;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.ii-ramis-bak`);
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
  return true;
}

function marketplaceSource(name) {
  if (name === 'ii-ramis' && process.env.IIRAMIS_MARKETPLACE_SOURCE) {
    const custom = process.env.IIRAMIS_MARKETPLACE_SOURCE;
    return /^([/.~]|[A-Za-z]:[\\/])/.test(custom)
      ? { source: 'directory', path: path.resolve(custom) }
      : { source: 'github', repo: custom };
  }
  return KNOWN_MARKETPLACES[name];
}

const BYPASS_WARNING = `
Режим «без вопросов» (bypass)

Сейчас Claude перед действиями спрашивает у тебя разрешение. В режиме «без вопросов» он будет САМ
выполнять команды на твоём компьютере: создавать, менять и удалять файлы, ставить программы, ходить
в интернет. Заранее он тебя не спросит.

Чем ты рискуешь: если Claude ошибётся или прочитает вредную инструкцию, спрятанную на чужом сайте
или в чужом файле, он может испортить или стереть твои файлы или отправить что-то в интернет.

Плагин ИИ Рамис ловит самое опасное (удаление вне проекта, ключи и пароли, выгрузку файлов, скрипты
из интернета). Но это СТРАХОВОЧНАЯ СЕТКА, а не стена: часть обходных путей она пропускает
(что именно, написано в README, раздел «Чего страховка не ловит»). Если на компьютере есть важные
личные файлы без копии, не включай этот режим или сначала сделай копию.

Как выключить потом: открой файл ${path.join(claudeDirDisplay(), 'settings.json')}
и в разделе "permissions" поменяй "defaultMode" на "default" (или удали эту строку).
Через чат с Claude это не делается: защита нарочно блокирует правку настроек.
`;

function claudeDirDisplay() {
  return process.platform === 'win32' ? '%USERPROFILE%\\.claude' : '~/.claude';
}

const BYPASS_MANUAL_STEPS = `Режим «без вопросов» НЕ включён: установщик запущен не из обычного окна терминала, а согласие должен дать ты сам.
Чтобы включить, открой ${process.platform === 'win32' ? 'PowerShell' : 'приложение Терминал'} и вставь:
  node ${process.platform === 'win32' ? '$env:USERPROFILE\\.ii-ramis' : '~/.ii-ramis'}${process.platform === 'win32' ? '\\' : '/'}setup-settings.mjs --ask-bypass
Либо вручную: в ${path.join(claudeDirDisplay(), 'settings.json')} добавь "permissions": { "defaultMode": "bypassPermissions" }.
Можно и не включать: Claude будет спрашивать разрешения, всё остальное работает.`;

// Вопрос задаём только живому человеку в терминале (и ввод, и вывод — терминал). По умолчанию «нет».
async function askBypass() {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    log.push(BYPASS_MANUAL_STEPS);
    return;
  }
  console.log(BYPASS_WARNING);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question('Включить режим «без вопросов»? Напиши «да», чтобы включить. Любой другой ответ или пустая строка = нет: ')).trim().toLowerCase();
    bypassAccepted = ['да', 'д', 'yes', 'y'].includes(answer);
    if (!bypassAccepted) log.push('режим «без вопросов» не включён (ответ «нет»): Claude будет спрашивать разрешения');
  } finally {
    rl.close();
  }
}

function updateSettings() {
  const before = readJson(settingsFile);
  const settings = structuredClone(before);

  if (bypassAccepted) {
    settings.permissions = { ...(settings.permissions || {}) };
    if (settings.permissions.defaultMode !== 'bypassPermissions') {
      settings.permissions.defaultMode = 'bypassPermissions';
      log.push('режим bypassPermissions («без вопросов») включён по твоему «да»');
    }
    // skipDangerousModePermissionPrompt намеренно не ставим: Claude сам один раз покажет свой экран подтверждения.
  }

  settings.extraKnownMarketplaces = { ...(settings.extraKnownMarketplaces || {}) };
  for (const name of values('--marketplace')) {
    const source = marketplaceSource(name);
    if (!source) throw new Error(`Неизвестный маркетплейс: ${name}`);
    const existing = settings.extraKnownMarketplaces[name];
    if (!existing) {
      settings.extraKnownMarketplaces[name] = { source };
      log.push(`маркетплейс ${name} добавлен в настройки`);
    }
  }
  for (const name of values('--auto-update')) {
    const entry = settings.extraKnownMarketplaces[name];
    if (!entry) throw new Error(`Нельзя включить автообновление: маркетплейса ${name} нет в настройках`);
    if (entry.autoUpdate !== true) {
      entry.autoUpdate = true;
      log.push(`автообновление для ${name} включено`);
    }
  }
  if (Object.keys(settings.extraKnownMarketplaces).length === 0) delete settings.extraKnownMarketplaces;

  settings.enabledPlugins = { ...(settings.enabledPlugins || {}) };
  for (const id of values('--enable')) {
    if (settings.enabledPlugins[id] === false) {
      log.push(`${id} выключен учеником, не трогаю`);
    } else if (settings.enabledPlugins[id] !== true) {
      settings.enabledPlugins[id] = true;
      log.push(`плагин ${id} включён в настройках`);
    }
  }
  if (Object.keys(settings.enabledPlugins).length === 0) delete settings.enabledPlugins;

  if (save(settingsFile, settings, before)) log.push(`записано: ${settingsFile}`);
}

function updateMcp() {
  const names = values('--mcp');
  if (names.length === 0) return;
  const before = readJson(mcpFile);
  const data = structuredClone(before);
  data.mcpServers = { ...(data.mcpServers || {}) };
  for (const name of names) {
    const command = KNOWN_MCP[name];
    if (!command) throw new Error(`Неизвестный MCP: ${name}`);
    if (data.mcpServers[name]) continue;
    const isWindows = process.platform === 'win32';
    data.mcpServers[name] = isWindows
      ? { type: 'stdio', command: 'cmd', args: ['/c', ...command], env: {} }
      : { type: 'stdio', command: command[0], args: command.slice(1), env: {} };
    log.push(`MCP ${name} добавлен в ${mcpFile}`);
  }
  save(mcpFile, data, before);
}

function updateConfig() {
  const share = values('--share')[0];
  const studentName = values('--student-name')[0];
  if (share === undefined && studentName === undefined) return;
  const file = path.join(dataDir, 'config.json');
  const before = readJson(file);
  const config = { student_id: crypto.randomUUID(), lesson: null, autosave: true, ...before };
  if (share !== undefined) config.share = share === 'yes';
  if (studentName !== undefined) config.student_name = studentName;
  if (save(file, config, before)) log.push(`отправка Рамису: ${config.share ? 'разрешена' : 'выключена'}`);
}

try {
  if (args.includes('--ask-bypass') && !dryRun) await askBypass();
  else if (args.includes('--ask-bypass')) log.push('режим «без вопросов»: в пробе вопрос не задаётся');
  updateSettings();
  updateMcp();
  updateConfig();
  const prefix = dryRun ? '[проба, ничего не записано] ' : '';
  console.log(log.length > 0 ? log.map((line) => `${prefix}${line}`).join('\n') : 'настройки уже в порядке, менять нечего');
} catch (error) {
  console.error(`ОШИБКА настроек: ${error.message}`);
  process.exit(1);
}
