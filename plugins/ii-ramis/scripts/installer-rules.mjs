// Установщик и его согласия (режим «без вопросов», сводки Рамису) должен запускать только живой человек, а не Claude.
// Здесь: (1) запрет запускать наши install.sh / install.ps1 / setup-settings.mjs из Claude в любой форме,
// (2) запрет обёрток с псевдотерминалом, которыми можно «сыграть человека» (script, expect, socat, python pty, /dev/tty),
// (3) запрет стирать переменные, по которым установщик понимает, что его запустил Claude.
// Главная защита всё равно в самих установщиках (agent-context.mjs): они сами отказываются включать согласия из-под Claude.
import { expandBraces } from './lib.mjs';
import { verbName, commandIndex } from './shell-parse.mjs';

const OWN_SCRIPT_NAMES = ['install.sh', 'install.ps1', 'setup-settings.mjs'];
const OUR_REPOSITORY_URL = /RamisGit-cyber[/\\]ii-ramis/i;
const INSTALLER_REASON = 'запуск установщика ИИ Рамис (install.sh, install.ps1, setup-settings.mjs) через Claude: режим «без вопросов» и согласие на сводки даёшь только ты сам, в обычном окне Терминала (или тумблером Settings -> Code в Claude Desktop)';

const READ_ONLY_VERBS = new Set([
  'cat', 'less', 'more', 'head', 'tail', 'grep', 'egrep', 'fgrep', 'rg', 'ls', 'dir', 'stat', 'wc', 'file', 'diff', 'test', '[', '[[',
  'echo', 'printf', 'type', 'get-content', 'gc', 'select-string', 'sls', 'test-path', 'get-childitem', 'gci', 'get-item', 'gi',
]);
const SHELL_LIKE = new Set([
  'sh', 'bash', 'zsh', 'dash', 'ksh', 'ash', 'fish', 'csh', 'tcsh', 'node', 'nodejs', 'bun', 'deno', 'pwsh', 'powershell',
  'iex', 'invoke-expression', 'eval', 'source', '.', 'xargs', 'env', 'exec', 'sudo', 'doas', 'nohup', 'setsid', 'command',
]);

function globToRegExp(pattern) {
  let body = '';
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i];
    if (ch === '*') body += '.*';
    else if (ch === '?') body += '.';
    else if (ch === '[' && pattern.indexOf(']', i + 2) !== -1) {
      const close = pattern.indexOf(']', i + 2);
      const set = pattern.slice(i + 1, close).replace(/^!/, '^').replace(/\\/g, '\\\\');
      body += `[${set}]`;
      i = close;
    } else body += ch.replace(/[.+^${}()|\\[\]]/g, '\\$&');
  }
  try {
    return new RegExp(`^${body}$`, 'i');
  } catch {
    return /^$/;
  }
}

function baseName(token) {
  return String(token).split(/[\\/]/).pop() || '';
}

// Токен указывает на наш установщик: точное имя, имя после раскрытия {a,b} или шаблон со звёздочкой, который его накрывает.
function tokenNamesOwnScript(token) {
  if (/:\/\//.test(token)) return OUR_REPOSITORY_URL.test(token) && OWN_SCRIPT_NAMES.some((n) => token.toLowerCase().includes(n.split('.')[0]));
  const variants = expandBraces(token);
  return variants.some((variant) => {
    const name = baseName(variant);
    if (!name) return false;
    if (OWN_SCRIPT_NAMES.some((own) => own === name.toLowerCase())) return true;
    const literalCount = name.replace(/[*?[\]]/g, '').length; // «*» и «*.sh» слишком общие, чтобы считать их именем установщика
    return literalCount >= 4 && /[*?[]/.test(name) && OWN_SCRIPT_NAMES.some((own) => globToRegExp(name).test(own));
  });
}

function mentionsOurRepository(commands) {
  return commands.some((cmd) => cmd.tokens.some((t) => /:\/\//.test(t) && OUR_REPOSITORY_URL.test(t)));
}

export function checkInstallerLaunch(commands) {
  const anyShell = commands.some((cmd) => cmd.tokens.some((t) => SHELL_LIKE.has(verbName(t))));
  // Любая ссылка на наш репозиторий в связке «скачать и исполнить» запрещена даже без имени файла (install.${x}).
  if (mentionsOurRepository(commands) && anyShell) return INSTALLER_REASON;
  for (const cmd of commands) {
    const mentioned = cmd.tokens.some((token, index) => !cmd.consumed.has(index) && tokenNamesOwnScript(token));
    if (!mentioned) continue;
    const first = commandIndex(cmd.tokens);
    const reading = first !== -1 && READ_ONLY_VERBS.has(verbName(cmd.tokens[first])) &&
      !cmd.inSubstitution && !cmd.pipedInto && !cmd.tokens.some((t) => /^\d*>/.test(t));
    if (!reading || anyShell) return INSTALLER_REASON;
  }
  return null;
}

// ---- Обёртки с псевдотерминалом и приёмы «выглядеть как человек» ----
const TERMINAL_DRIVER_VERBS = new Set([
  'script', 'scriptreplay', 'unbuffer', 'expect', 'autoexpect', 'socat', 'winpty', 'conhost', 'tmux', 'screen', 'osascript',
  'reptyr', 'faketty', 'su', 'login', 'launchctl', 'systemd-run', 'at', 'batch', 'runuser',
]);
const PTY_WORDS = /(^|[^A-Za-z])(pty|ptyprocess|pexpect|node-pty|conpty|winpty|forkpty|openpty|ptmx)([^A-Za-z]|$)/i;
const TTY_DEVICES = /\/dev\/(tty|pts|ptmx)/i;
const TERMINAL_REASON = 'обёртка с псевдотерминалом или запуск в отдельном окне терминала (script, expect, unbuffer, socat, tmux, osascript, python pty, /dev/tty): так можно выдать себя за человека, а согласия даёт только человек';

export function checkTerminalWrappers(commands) {
  for (const cmd of commands) {
    const { tokens } = cmd;
    const first = commandIndex(tokens);
    if (first !== -1 && TERMINAL_DRIVER_VERBS.has(verbName(tokens[first]))) return TERMINAL_REASON;
    const name = first === -1 ? '' : verbName(tokens[first]);
    const textOnly = (HARMLESS_MARKER_VERBS.has(name) && !cmd.inSubstitution) || name === 'git' || name === 'gh';
    const scanned = textOnly ? withoutMessageText(tokens) : tokens;
    if (!(HARMLESS_MARKER_VERBS.has(name) && !cmd.inSubstitution) && scanned.some((t) => TTY_DEVICES.test(t) || PTY_WORDS.test(t))) return TERMINAL_REASON;
    const sshAt = tokens.findIndex((t) => ['ssh', 'mosh'].includes(verbName(t)));
    if (sshAt !== -1 && tokens.slice(sshAt + 1).some((t) => /^-[A-Za-z]*t/.test(t) || /requesttty/i.test(t))) return TERMINAL_REASON;
    const openAt = tokens.findIndex((t) => verbName(t) === 'open');
    if (openAt !== -1 && tokens.slice(openAt + 1).some((t) => /terminal|iterm|warp|hyper|kitty|alacritty/i.test(t))) return TERMINAL_REASON;
    if (tokens.some((t) => /^(wt|cmd|start|conhost|windowsterminal)(\.exe)?$/i.test(t)) && tokens.some((t) => /^\/k$/i.test(t) || /^new-tab$/i.test(t))) return TERMINAL_REASON;
  }
  return null;
}

// ---- Стирание признаков «меня запустил Claude» ----
const MARKER_MENTION = /CLAUDECODE|CLAUDE_CODE_|AI_AGENT|\$\{?!\s*(CLAUDE|AI_)|\bCLAUDE\*|\bAI_\*/i;
const HARMLESS_MARKER_VERBS = new Set(['echo', 'printf', 'test', '[', '[[', 'write-output', 'write-host']);
const ENV_CLEARING_FLAG = /^-([A-Za-z]*[iuS0]|)$|^--(ignore-environment|unset|split-string|null)(=|$)/;
const MARKER_REASON = 'попытка стереть переменные, по которым установщик понимает, что его запустил Claude (CLAUDECODE, CLAUDE_CODE_*, AI_AGENT, env -i, env -u)';

export function checkAgentMarkerTampering(commands) {
  for (const cmd of commands) {
    const { tokens } = cmd;
    const first = commandIndex(tokens);
    const name = first === -1 ? '' : verbName(tokens[first]);
    if (!HARMLESS_MARKER_VERBS.has(name)) {
      const scanned = name === 'git' || name === 'gh' ? withoutMessageText(tokens) : tokens;
      if (scanned.some((t, i) => !cmd.consumed.has(i) && MARKER_MENTION.test(t))) return MARKER_REASON;
    }
    for (let i = 0; i < tokens.length; i += 1) {
      const verb = verbName(tokens[i]);
      if (verb === 'exec' && tokens.slice(i + 1, i + 3).includes('-c')) return MARKER_REASON;
      if (verb !== 'env' && verb !== 'sudo') continue;
      for (let j = i + 1; j < tokens.length; j += 1) {
        const token = tokens[j];
        if (!token.startsWith('-') && !/^[A-Za-z_]\w*=/.test(token)) break;
        if (verb === 'env' && ENV_CLEARING_FLAG.test(token)) return MARKER_REASON;
        if (verb === 'sudo' && /^(-i|--login|-s|--shell)$/.test(token)) return MARKER_REASON; // login-оболочка собирает окружение заново
      }
    }
  }
  return null;
}

function withoutMessageText(tokens) {
  const kept = [];
  for (let i = 0; i < tokens.length; i += 1) {
    if (['-m', '-am', '--message', '--body', '-b', '--title', '-t'].includes(tokens[i])) { i += 1; continue; }
    if (/^--(message|body|title)=/.test(tokens[i])) continue;
    kept.push(tokens[i]);
  }
  return kept;
}
