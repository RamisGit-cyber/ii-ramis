// Небольшой разборщик shell-команд для охранника: режет строку на простые команды с учётом кавычек,
// подстановок $(...), heredoc и вложенных `bash -c`. Это не полноценный shell: что не смогли понять, помечается как проблема.
import { Buffer } from 'node:buffer';

const MAX_DEPTH = 6;
const SHELL_NAMES = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'ash', 'fish', 'csh', 'tcsh']);
const PS_SHELLS = new Set(['powershell', 'pwsh']);
const EVAL_NAMES = new Set(['eval', 'iex', 'invoke-expression']);
export const FETCH_NAMES = new Set(['curl', 'wget', 'iwr', 'irm', 'invoke-webrequest', 'invoke-restmethod']);
const ECHO_NAMES = new Set(['echo', 'printf', 'write-output', 'write-host']);
export const KEYWORDS = new Set(['if', 'then', 'else', 'elif', 'fi', 'do', 'done', 'while', 'until', 'for', 'in', 'case', 'esac', 'function', 'time', '!', '{', '}', 'select']);
const WRAPPERS = new Set(['sudo', 'doas', 'env', 'command', 'builtin', 'exec', 'nohup', 'nice', 'timeout', 'stdbuf', 'setsid', 'ionice']);
const WRAPPER_FLAG_WITH_VALUE = new Set(['-u', '-g', '-h', '-p', '-C', '-D', '-R', '-T', '-U', '-r', '-t', '-n', '-s', '-k']);

// Имя команды без пути, расширения .exe и регистра: /bin/rm, \rm, RM.EXE -> rm
export function verbName(token) {
  const last = String(token).split(/[\\/]/).pop() || '';
  return last.replace(/\.(exe|cmd|bat|com)$/i, '').toLowerCase();
}

export function isAssignment(token) {
  return /^[A-Za-z_]\w*\+?=/.test(token);
}

// Индекс настоящей команды: пропускаем VAR=x, if/then, sudo/env/nohup и их флаги.
export function commandIndex(tokens) {
  let i = 0;
  while (i < tokens.length) {
    const token = tokens[i];
    const name = verbName(token);
    // `select` в PowerShell (Select-Object) это команда; ключевое слово только в цикле bash «select имя in …»
    const isKeyword = KEYWORDS.has(name) && (name !== 'select' || tokens[i + 2] === 'in');
    if (isAssignment(token) || isKeyword) { i += 1; continue; }
    if (WRAPPERS.has(name)) {
      i += 1;
      while (i < tokens.length) {
        const next = tokens[i];
        if (WRAPPER_FLAG_WITH_VALUE.has(next) && name !== 'env') i += 2;
        else if (next.startsWith('-') || isAssignment(next) || /^\d+[smhd]?$/.test(next)) i += 1;
        else break;
      }
      continue;
    }
    return i;
  }
  return -1;
}

function decodeAnsiC(body) {
  return body
    .replace(/\\x([0-9a-f]{1,2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\\u([0-9a-f]{1,4})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\\([0-7]{1,3})/g, (_, oct) => String.fromCharCode(parseInt(oct, 8)))
    .replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\(['"\\])/g, '$1');
}

function findClosingParen(src, start) {
  let depth = 1;
  for (let i = start; i < src.length; i += 1) {
    const ch = src[i];
    if (ch === '\\') { i += 1; continue; }
    if (ch === "'" || ch === '"') {
      const close = src.indexOf(ch, i + 1);
      if (close === -1) return -1;
      i = close;
      continue;
    }
    if (ch === '(') depth += 1;
    if (ch === ')') { depth -= 1; if (depth === 0) return i; }
  }
  return -1;
}

function containsShellVerb(cmd) {
  return cmd.tokens.some((token) => {
    const name = verbName(token);
    return SHELL_NAMES.has(name) || PS_SHELLS.has(name) || EVAL_NAMES.has(name);
  });
}

function parseInto(src, mode, depth, out) {
  if (depth > MAX_DEPTH) {
    out.problems.push('слишком глубокая вложенность команд: не смог проверить');
    return;
  }
  const ps = mode === 'ps';
  let tokens = [];
  let current = '';
  let started = false;
  let lineStart = out.commands.length;
  let carry = null; // предыдущая команда, если с ней соединён конвейер
  const pendingHeredocs = [];
  let pendingSubs = []; // команды из $(...) внутри текущей команды: нужны, чтобы увидеть `bash <(curl ...)`

  const flushToken = () => {
    if (started) tokens.push(current);
    current = '';
    started = false;
  };
  const endCommand = (pipedInto) => {
    flushToken();
    if (tokens.length === 0) { if (!pipedInto) carry = null; return; }
    const cmd = {
      tokens, pipedInto, mode, prev: carry, consumed: new Set(), subs: pendingSubs, heredoc: pendingHeredocs.length > 0,
    };
    pendingSubs = [];
    out.commands.push(cmd);
    carry = pipedInto ? cmd : null;
    tokens = [];
  };
  const substitute = (inner) => {
    const firstNew = out.commands.length;
    parseInto(inner, mode, depth + 1, out);
    const added = out.commands.slice(firstNew);
    added.forEach((cmd) => { cmd.inSubstitution = true; });
    pendingSubs.push(...added);
    current += '$()';
    started = true;
  };

  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    const next = src[i + 1];

    if (ch === '\n') {
      endCommand(false);
      i += 1;
      if (pendingHeredocs.length > 0) {
        const lineCommands = out.commands.slice(lineStart);
        const runsAsCode = lineCommands.some(containsShellVerb);
        for (const delimiter of pendingHeredocs.splice(0)) {
          const lines = [];
          while (i < src.length) {
            let end = src.indexOf('\n', i);
            if (end === -1) end = src.length;
            const line = src.slice(i, end);
            i = Math.min(end + 1, src.length);
            if (line.trim() === delimiter) break;
            lines.push(line);
          }
          lineCommands.forEach((lineCommand) => { (lineCommand.heredocBodies ||= []).push(lines.join('\n')); });
          if (runsAsCode) parseInto(lines.join('\n'), mode, depth + 1, out);
        }
      }
      lineStart = out.commands.length;
      continue;
    }
    if (/\s/.test(ch)) { flushToken(); i += 1; continue; }

    if (ch === '#' && !started) {
      while (i < src.length && src[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '&' && next === '&' || ch === '|' && next === '|') { endCommand(false); i += 2; continue; }
    if (ch === '|') { endCommand(true); i += next === '&' ? 2 : 1; continue; }
    if (ch === ';') { endCommand(false); i += 1; continue; }
    if (ch === '&') {
      const prev = src[i - 1];
      if (prev === '>' || prev === '<' || next === '>') { current += ch; started = true; i += 1; continue; }
      endCommand(false);
      i += 1;
      continue;
    }
    if (ch === '(' && ps) { // в PowerShell (...) — подвыражение, как $(...)
      const close = findClosingParen(src, i + 1);
      if (close === -1) { out.problems.push('не закрыта скобка в команде'); i = src.length; continue; }
      substitute(src.slice(i + 1, close));
      i = close + 1;
      continue;
    }
    if (ch === '(' || ch === ')') { endCommand(false); i += 1; continue; }

    if ((ch === '<' || ch === '>') && next === '(') {
      const close = findClosingParen(src, i + 2);
      if (close === -1) { out.problems.push('не закрыта скобка в команде'); i = src.length; continue; }
      substitute(src.slice(i + 2, close));
      i = close + 1;
      continue;
    }
    if (ch === '<' && next === '<' && src[i + 2] === '<') {
      flushToken();
      tokens.push('<<<');
      i += 3;
      continue;
    }
    if (ch === '<' && next === '<' && !ps) {
      const match = src.slice(i + 2).match(/^-?\s*(?:'([^']*)'|"([^"]*)"|([^\s;&|<>()]+))/);
      if (match) {
        pendingHeredocs.push(match[1] ?? match[2] ?? match[3]);
        i += 2 + match[0].length;
        continue;
      }
    }

    if (ch === '$' && next === '(') {
      const close = findClosingParen(src, i + 2);
      if (close === -1) { out.problems.push('не закрыта скобка в команде'); i = src.length; continue; }
      substitute(src.slice(i + 2, close));
      i = close + 1;
      continue;
    }
    if (ch === '$' && next === '{') {
      const close = src.indexOf('}', i);
      const end = close === -1 ? src.length : close + 1;
      current += src.slice(i, end);
      started = true;
      i = end;
      continue;
    }
    if (ch === '`' && !ps) {
      const close = src.indexOf('`', i + 1);
      if (close === -1) { out.problems.push('не закрыта обратная кавычка'); i = src.length; continue; }
      substitute(src.slice(i + 1, close));
      i = close + 1;
      continue;
    }
    if (ch === '$' && next === "'" && !ps) {
      const close = src.indexOf("'", i + 2);
      const end = close === -1 ? src.length : close;
      current += decodeAnsiC(src.slice(i + 2, end));
      started = true;
      i = end + 1;
      continue;
    }
    if (ch === "'") {
      const close = src.indexOf("'", i + 1);
      const end = close === -1 ? src.length : close;
      current += src.slice(i + 1, end);
      started = true;
      i = end + 1;
      continue;
    }
    if (ch === '"') {
      i += 1;
      started = true;
      while (i < src.length && src[i] !== '"') {
        const inner = src[i];
        if (inner === '\\' && !ps && '$"`\\\n'.includes(src[i + 1] ?? '')) { current += src[i + 1]; i += 2; continue; }
        if (inner === '`' && ps) { current += src[i + 1] ?? ''; i += 2; continue; }
        if (inner === '$' && src[i + 1] === '(') {
          const close = findClosingParen(src, i + 2);
          if (close === -1) { out.problems.push('не закрыта скобка в команде'); i = src.length; break; }
          substitute(src.slice(i + 2, close));
          i = close + 1;
          continue;
        }
        if (inner === '`' && !ps) {
          const close = src.indexOf('`', i + 1);
          if (close === -1) { out.problems.push('не закрыта обратная кавычка'); i = src.length; break; }
          substitute(src.slice(i + 1, close));
          i = close + 1;
          continue;
        }
        current += inner;
        i += 1;
      }
      i += 1;
      continue;
    }
    if (ch === '\\' && !ps) {
      if (next === '\n') { i += 2; continue; }
      current += next ?? '';
      started = true;
      i += 2;
      continue;
    }
    if (ch === '`' && ps) {
      current += next ?? '';
      started = true;
      i += 2;
      continue;
    }
    current += ch;
    started = true;
    i += 1;
  }
  endCommand(false);
}

// Скрипты, которые команда запускает внутри себя: bash -c "...", eval, powershell -Command / -EncodedCommand, cmd /c, echo ... | sh.
function nestedScripts(cmd, out) {
  const scripts = [];
  const { tokens } = cmd;
  const add = (index, script, mode) => { cmd.consumed.add(index); scripts.push({ script, mode }); };
  tokens.forEach((token, index) => {
    const name = verbName(token);
    const rest = tokens.slice(index + 1);
    if (SHELL_NAMES.has(name)) {
      const flagAt = rest.findIndex((t) => /^-[a-zA-Z]*c[a-zA-Z]*$/.test(t));
      if (flagAt !== -1 && rest[flagAt + 1] !== undefined) add(index + 1 + flagAt + 1, rest[flagAt + 1], 'bash');
      else if (index === commandIndex(tokens) && !rest.some((t) => !t.startsWith('-') && !t.startsWith('<'))) {
        feedShell(cmd, out, scripts, 'bash', rest);
      }
    } else if (PS_SHELLS.has(name)) {
      const flagAt = rest.findIndex((t) => /^-c(o(m(m(a(n(d)?)?)?)?)?)?$/i.test(t));
      const encodedAt = rest.findIndex((t) => /^-e(c|nc(o(d(e(d(c(o(m(m(a(n(d)?)?)?)?)?)?)?)?)?)?)?)?$/i.test(t));
      if (flagAt !== -1 && rest[flagAt + 1] !== undefined) add(index + 1 + flagAt + 1, rest.slice(flagAt + 1).join(' '), 'ps');
      else if (encodedAt !== -1 && rest[encodedAt + 1] !== undefined) {
        add(index + 1 + encodedAt + 1, Buffer.from(rest[encodedAt + 1], 'base64').toString('utf16le'), 'ps');
      }
    } else if (name === 'cmd') {
      const flagAt = rest.findIndex((t) => /^\/[ck]$/i.test(t));
      if (flagAt !== -1) add(index + 1 + flagAt + 1, rest.slice(flagAt + 1).join(' '), 'ps');
    } else if (EVAL_NAMES.has(name)) {
      if (rest.length > 0) add(index + 1, rest.join(' '), name === 'eval' ? cmd.mode : 'ps');
      else if (index === commandIndex(tokens)) feedShell(cmd, out, scripts, name === 'eval' ? cmd.mode : 'ps', rest);
    }
  });
  // bash <<< "rm -rf ~"
  const hereString = tokens.findIndex((t) => t === '<<<');
  if (hereString !== -1 && tokens[hereString + 1] !== undefined && tokens.some((t) => SHELL_NAMES.has(verbName(t)))) {
    add(hereString + 1, tokens[hereString + 1], cmd.mode);
  }
  return scripts;
}

// Оболочка читает команды из конвейера: если вход — echo/printf, разбираем его текст, иначе не знаем, что запустится.
function feedShell(cmd, out, scripts, mode, rest) {
  if (rest.some((t) => t === '<<<')) return;
  const upstream = cmd.prev;
  if (!upstream) return;
  const upstreamIndex = commandIndex(upstream.tokens);
  const upstreamName = upstreamIndex === -1 ? '' : verbName(upstream.tokens[upstreamIndex]);
  if (FETCH_NAMES.has(upstreamName)) return; // скачанное проверяет правило про доверенные адреса
  if (ECHO_NAMES.has(upstreamName)) {
    scripts.push({ script: upstream.tokens.slice(upstreamIndex + 1).join(' '), mode });
    return;
  }
  out.problems.push('оболочка запускает команды из конвейера, а откуда они, неизвестно');
}

// Разбирает команду целиком, включая вложенные скрипты. Возвращает плоский список простых команд и найденные проблемы.
export function parseShell(command, mode = 'bash') {
  const out = { commands: [], problems: [] };
  parseInto(String(command), mode, 0, out);
  const queue = [...out.commands];
  let rounds = 0;
  while (queue.length > 0) {
    const cmd = queue.shift();
    if (rounds > 200) { out.problems.push('слишком много вложенных команд: не смог проверить'); break; }
    rounds += 1;
    for (const { script, mode: nestedMode } of nestedScripts(cmd, out)) {
      const nested = { commands: [], problems: out.problems };
      parseInto(script, nestedMode, 1, nested);
      out.commands.push(...nested.commands);
      queue.push(...nested.commands);
    }
  }
  return out;
}
