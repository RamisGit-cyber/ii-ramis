// Определяет, запущен ли скрипт изнутри Claude (агентом), а не живым человеком в обычном терминале.
// Два независимых признака: (1) переменные, которые Claude Code выставляет всем дочерним процессам
// (CLAUDECODE, CLAUDE_CODE_*, AI_AGENT); (2) среди предков процесса есть программа claude / Claude.app.
// Второй признак нужен потому, что переменные можно стереть (env -i), а цепочку предков стереть сложнее.
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const ENV_MARKER = /^(CLAUDECODE|CLAUDE_CODE_[A-Z0-9_]*|AI_AGENT)$/;
const MAX_ANCESTORS = 20;

export function agentEnvMarker(env = process.env) {
  const found = Object.keys(env).find((name) => ENV_MARKER.test(name) && env[name] !== '');
  return found ? `переменная окружения ${found}` : null;
}

export function isAgentProcessName(commandPath) {
  const text = String(commandPath || '').trim();
  const base = path.basename(text.replace(/\\/g, '/')).replace(/\.exe$/i, '').toLowerCase();
  if (base === 'claude' || base === 'claude-code' || base.startsWith('claude helper')) return true;
  return /[/\\]claude\.app[/\\]/i.test(text) || /[/\\]claude-code[/\\][^/\\]*[/\\]claude(\.exe)?$/i.test(text);
}

export function agentAncestor(getAncestors = readAncestors) {
  let names;
  try {
    names = getAncestors();
  } catch {
    return null;
  }
  const hit = names.find(isAgentProcessName);
  return hit ? `процесс-родитель ${path.basename(String(hit).replace(/\\/g, '/'))}` : null;
}

function readAncestors() {
  return process.platform === 'win32' ? readWindowsAncestors() : readUnixAncestors();
}

function readUnixAncestors() {
  const names = [];
  let pid = process.ppid;
  for (let step = 0; step < MAX_ANCESTORS && pid > 1; step += 1) {
    const run = (field) => execFileSync('/bin/ps', ['-o', `${field}=`, '-p', String(pid)], { encoding: 'utf8', timeout: 3000 }).trim();
    const name = run('comm');
    if (!name) break;
    names.push(name);
    pid = Number(run('ppid'));
    if (!Number.isInteger(pid)) break;
  }
  return names;
}

function readWindowsAncestors() {
  const script = `$p=${process.ppid};for($i=0;$i -lt ${MAX_ANCESTORS} -and $p -gt 0;$i++){$o=Get-CimInstance Win32_Process -Filter "ProcessId=$p";if(-not $o){break};$o.Name;$p=$o.ParentProcessId}`;
  const out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', timeout: 8000 });
  return out.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

// Возвращает причину («запущено из Claude: ...») или null, если похоже на живого человека.
export function agentContext(env = process.env, getAncestors = readAncestors) {
  return agentEnvMarker(env) || agentAncestor(getAncestors);
}
