// Защита самой защиты: настройки Claude Code, папка плагина и конфиг ИИ Рамис не должны меняться через Claude.
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verbName, commandIndex } from './shell-parse.mjs';

export const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STUDENT_ONLY = 'выключить защиту может только ученик сам в настройках';
const PROTECTED_PATTERNS = [
  /\.claude[/\\]settings/i,
  /\.claude[/\\]plugins(?=$|[/\\\s'"*])/i,
  /\.ii-ramis[/\\]config\.json/i,
  /CLAUDE_PLUGIN_ROOT/,
];
const READ_VERBS = new Set([
  'cat', 'less', 'more', 'head', 'tail', 'grep', 'egrep', 'rg', 'ls', 'dir', 'stat', 'test', '[', '[[', 'wc', 'file', 'diff',
  'jq', 'type', 'get-content', 'gc', 'select-string', 'sls', 'test-path', 'get-childitem', 'gci', 'get-item', 'gi',
]);
const READ_ONLY_GIT = new Set(['status', 'diff', 'log', 'show', 'ls-files', 'check-ignore', 'add', 'commit']);
const RUNNERS = new Set(['bash', 'sh', 'node', 'pwsh', 'powershell']);
const ALLOWED_SCRIPTS = new Set(['install.sh', 'install.ps1', 'setup-settings.mjs', 'diagnose.sh', 'diagnose.ps1']);
const REDIRECT = /^\d*>>?\|?/;

function expand(token) {
  return token
    .replace(/\$\{?CLAUDE_PLUGIN_ROOT\}?/g, PLUGIN_ROOT)
    .replace(/^(\$\{?HOME\}?|~)(?=$|[/\\])/, os.homedir());
}

function stripRedirect(token) {
  const match = token.match(REDIRECT);
  return match && match[0].length < token.length ? token.slice(match[0].length) : token;
}

export function isProtectedPath(raw, cwd) {
  const text = expand(String(raw));
  if (PROTECTED_PATTERNS.some((pattern) => pattern.test(text))) return true;
  if (text.startsWith('-')) return false;
  if (/[$`]/.test(text) || text.includes('*') && !text.includes('/')) return false;
  const resolved = path.resolve(cwd, text);
  const relative = path.relative(PLUGIN_ROOT, resolved);
  return !relative.startsWith('..') && !path.isAbsolute(relative);
}

function resolvesToPluginScript(token, names, cwd) {
  const expanded = expand(token);
  if (!path.isAbsolute(expanded)) return false;
  const resolved = path.resolve(cwd, expanded);
  return path.dirname(resolved) === path.join(PLUGIN_ROOT, 'scripts') && names.has(path.basename(resolved));
}

function isConfigSet(args) {
  return (args.length === 3 && args[0] === 'set' && args[1] === 'lesson' && /^\d{1,2}$/.test(args[2])) ||
    (args.length === 3 && args[0] === 'set' && args[1] === 'autosave' && /^(true|false)$/.test(args[2]));
}

function isPluginCommand(tokens) {
  const claude = tokens.findIndex((t) => verbName(t) === 'claude');
  const slash = tokens.some((t) => /^\/plugins?$/.test(t));
  const mentionsUs = tokens.some((t) => /ii-ramis/i.test(t));
  if (slash) return true;
  if (claude === -1 || !tokens.slice(claude + 1).some((t) => /^plugins?$/.test(t))) return false;
  return mentionsUs && tokens.some((t) => /^(disable|uninstall|remove|delete)$/.test(t));
}

// Разрешённые вызовы наших собственных скриптов: единственное упоминание защищённого пути — абсолютный путь к скрипту.
function isOwnScriptCall(tokens, mentioned, first, cwd) {
  if (mentioned.length !== 1) return false;
  const token = tokens[mentioned[0]];
  const name = verbName(tokens[first]);
  const args = tokens.slice(mentioned[0] + 1);
  if (resolvesToPluginScript(token, new Set(['config.mjs']), cwd)) return name === 'node' && mentioned[0] === first + 1 && isConfigSet(args);
  if (!resolvesToPluginScript(token, ALLOWED_SCRIPTS, cwd)) return false;
  return mentioned[0] === first || (RUNNERS.has(name) && tokens.slice(first + 1, mentioned[0]).every((t) => t.startsWith('-')));
}

function readOnlyUse(tokens, first) {
  const name = verbName(tokens[first]);
  if (READ_VERBS.has(name)) return true;
  if (name === 'git') {
    const sub = tokens.slice(first + 1).find((t) => !t.startsWith('-'));
    return READ_ONLY_GIT.has(sub);
  }
  return false;
}

export function checkProtectedShell(commands, cwd) {
  for (const cmd of commands) {
    const { tokens } = cmd;
    if (isPluginCommand(tokens)) return `управление плагином через команду: ${STUDENT_ONLY}`;
    const mentioned = tokens
      .map((token, index) => (!cmd.consumed.has(index) && isProtectedPath(stripRedirect(token), cwd) ? index : -1))
      .filter((index) => index !== -1);
    if (mentioned.length === 0) continue;
    const first = commandIndex(tokens);
    const redirected = mentioned.some((i) => REDIRECT.test(tokens[i]) && tokens[i].length > tokens[i].match(REDIRECT)[0].length ||
      (i > 0 && /^\d*>>?\|?$/.test(tokens[i - 1])));
    if (first !== -1 && !redirected && isOwnScriptCall(tokens, mentioned, first, cwd)) continue;
    if (first !== -1 && !redirected && !cmd.pipedInto && readOnlyUse(tokens, first)) continue;
    return `изменение настроек Claude Code, папки плагина или конфига ИИ Рамис: ${STUDENT_ONLY}`;
  }
  return null;
}

export function checkProtectedFileWrite(rawPath, cwd) {
  return isProtectedPath(rawPath, cwd)
    ? `изменение настроек Claude Code, папки плагина или конфига ИИ Рамис: ${STUDENT_ONLY}`
    : null;
}
