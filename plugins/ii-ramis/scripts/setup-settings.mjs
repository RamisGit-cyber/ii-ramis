// Правит настройки Claude для установщика пакета «ИИ Рамис». Идемпотентно: повторный запуск ничего не ломает.
// Работает и без команды `claude` (ученик в приложении Claude Desktop): тогда плагины включаются через настройки,
// а Claude Code скачает их сам при следующем запуске сессии.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Тег релиза: с него качается сам установщик (фраза ученика не меняется от каждого пуша).
export const RELEASE_TAG = 'v1.0.3';
// Маркетплейс плагина следит за веткой stable: туда владелец кладёт только проверенные релизы, main это рабочая ветка.
export const CHANNEL_REF = 'stable';

const KNOWN_MARKETPLACES = {
  'claude-plugins-official': { source: 'github', repo: 'anthropics/claude-plugins-official' },
  thedotmack: { source: 'github', repo: 'thedotmack/claude-mem' },
  ecc: { source: 'github', repo: 'affaan-m/ECC' },
  'ii-ramis': { source: 'github', repo: 'RamisGit-cyber/ii-ramis', ref: CHANNEL_REF },
};

const KNOWN_MCP = {
  context7: ['npx', '-y', '@upstash/context7-mcp'],
  playwright: ['npx', '@playwright/mcp@latest'],
};

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const values = (flag) => args.flatMap((a, i) => (a === flag && args[i + 1] ? [args[i + 1]] : []));
const log = [];

const claudeDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const settingsFile = path.join(claudeDir, 'settings.json');
const mcpFile = process.env.CLAUDE_CONFIG_DIR ? path.join(claudeDir, '.claude.json') : path.join(os.homedir(), '.claude.json');

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
      : (() => {
          const [repo, ref] = custom.split('#');
          return ref ? { source: 'github', repo, ref } : { source: 'github', repo };
        })();
  }
  return KNOWN_MARKETPLACES[name];
}

// Режим «без вопросов» (bypass) НИКАКОЙ наш скрипт не включает: только сам ученик (тумблер Settings -> Code ->
// «Allow bypass permissions mode» в Claude Desktop или правка settings.json руками, см. README).
// Согласие на пересказы сессий этот скрипт тоже не трогает: его спрашивает ИИ Рамис в чате (см. навык ii-ramis).

function updateSettings() {
  const before = readJson(settingsFile);
  const settings = structuredClone(before);

  settings.extraKnownMarketplaces = { ...(settings.extraKnownMarketplaces || {}) };
  for (const name of values('--marketplace')) {
    const source = marketplaceSource(name);
    if (!source) throw new Error(`Неизвестный маркетплейс: ${name}`);
    const existing = settings.extraKnownMarketplaces[name];
    if (!existing) {
      settings.extraKnownMarketplaces[name] = { source };
      log.push(`маркетплейс ${name} добавлен в настройки`);
    } else if (name === 'ii-ramis' && JSON.stringify(existing.source) !== JSON.stringify(source)) {
      // Ученик с v1.0.2 сидит на теге. Источник переводим на stable, остальные поля записи (autoUpdate и т.п.) сохраняем.
      // Без этого `claude plugin marketplace add` с другим ref отказывает: источник не совпадает с записью в настройках.
      settings.extraKnownMarketplaces[name] = { ...existing, source };
      log.push(`маркетплейс ${name}: источник переведён на ${source.ref || source.path || source.repo}`);
    }
  }
  for (const name of values('--auto-update')) {
    const entry = settings.extraKnownMarketplaces[name];
    if (!entry) throw new Error(`Нельзя включить автообновление: маркетплейса ${name} нет в настройках`);
    if (entry.autoUpdate === false) {
      log.push(`автообновление для ${name} выключено учеником, не трогаю`);
    } else if (entry.autoUpdate !== true) {
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

try {
  if (args.includes('--ask-bypass') || args.includes('--bypass')) log.push('режим «без вопросов» скрипты не включают. Включи сам: Claude Desktop -> Settings -> Code -> «Allow bypass permissions mode» (инструкция в README)');
  updateSettings();
  updateMcp();
  const prefix = dryRun ? '[проба, ничего не записано] ' : '';
  console.log(log.length > 0 ? log.map((line) => `${prefix}${line}`).join('\n') : 'настройки уже в порядке, менять нечего');
} catch (error) {
  console.error(`ОШИБКА настроек: ${error.message}`);
  process.exit(1);
}
