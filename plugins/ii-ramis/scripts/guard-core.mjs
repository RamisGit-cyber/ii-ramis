// Решение охранника: вернуть причину отказа или null. Отдельный модуль, чтобы поломка импорта не обходила защиту (см. guard.mjs).
import { tokenMentionsSecret, tokenMentionsShellStartup } from './lib.mjs';
import { parseShell } from './shell-parse.mjs';
import { checkDeletion } from './delete-rules.mjs';
import {
  checkSecrets, checkEnvironmentDump, checkGit, checkDatabase, checkPipeToShell, checkSelfApproval,
  checkInterpreters, checkUnverifiableReads, checkUpload,
} from './guard-rules.mjs';
import { checkProtectedShell, checkProtectedFileWrite } from './protect-rules.mjs';
import { checkWebFetch } from './web-rules.mjs';
import { checkConsentCommand, nameMayBeSet } from './consent-rules.mjs';
import { checkInstallerLaunch, checkTerminalWrappers, checkAgentMarkerTampering } from './installer-rules.mjs';

const WRITE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

const FILE_TOOLS = new Set(['Read', 'NotebookRead', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);
const PATH_KEY = /path|file|dir|folder|uri|glob|pattern|source|destination|target/i;

export class Denied extends Error {}

function stringsUnder(value, keyMatches, key = '', depth = 0, found = []) {
  if (depth > 6 || value === null || value === undefined) return found;
  if (typeof value === 'string') {
    if (keyMatches(key)) found.push(value);
  } else if (Array.isArray(value)) {
    value.forEach((item) => stringsUnder(item, keyMatches, key, depth + 1, found));
  } else if (typeof value === 'object') {
    Object.entries(value).forEach(([k, v]) => stringsUnder(v, keyMatches, k, depth + 1, found));
  }
  return found;
}

function pathValuesFor(toolName, toolInput) {
  if (toolName === 'Grep') return stringsUnder(toolInput, (k) => k === 'path' || k === 'glob');
  if (toolName === 'Glob') return stringsUnder(toolInput, (k) => k === 'path' || k === 'pattern');
  if (FILE_TOOLS.has(toolName)) return stringsUnder(toolInput, (k) => k === 'file_path' || k === 'notebook_path' || k === 'path');
  return stringsUnder(toolInput, (k) => PATH_KEY.test(k)); // mcp__*: любые поля, похожие на пути
}

function shellReason(toolName, toolInput, cwd) {
  const command = toolInput.command;
  if (command === undefined || command === '') return null;
  if (typeof command !== 'string') throw new Denied('команда в непонятном формате');
  const selfApproval = checkSelfApproval(command);
  if (selfApproval) return selfApproval;

  const parsed = parseShell(command, toolName === 'PowerShell' ? 'ps' : 'bash');
  const reason =
    checkInstallerLaunch(parsed.commands) ||
    checkTerminalWrappers(parsed.commands) ||
    checkAgentMarkerTampering(parsed.commands) ||
    checkConsentCommand(parsed.commands, command) ||
    checkProtectedShell(parsed.commands, cwd, { nameAllowed: nameMayBeSet }) ||
    checkSecrets(parsed.commands) ||
    checkEnvironmentDump(parsed.commands) ||
    checkDeletion(parsed.commands, cwd) ||
    checkGit(parsed.commands) ||
    checkUpload(parsed.commands) ||
    checkPipeToShell(parsed.commands) ||
    checkInterpreters(parsed.commands, cwd) ||
    checkUnverifiableReads(parsed.commands) ||
    checkDatabase(command);
  if (reason) return reason;
  if (parsed.problems.length > 0) return `не смог разобрать команду (${parsed.problems[0]})`;
  return null;
}

export function decide(input) {
  const toolName = String(input.tool_name || '');
  const toolInput = input.tool_input && typeof input.tool_input === 'object' ? input.tool_input : {};
  const cwd = typeof input.cwd === 'string' && input.cwd ? input.cwd : process.cwd();
  if (!toolName) throw new Denied('не понял, какой инструмент вызван');

  if (SHELL_TOOLS.has(toolName)) return shellReason(toolName, toolInput, cwd);
  if (toolName === 'WebFetch') return checkWebFetch(toolInput);

  for (const value of pathValuesFor(toolName, toolInput)) {
    const selfApproval = checkSelfApproval(value);
    if (selfApproval) return selfApproval;
    if ((WRITE_TOOLS.has(toolName) || toolName.startsWith('mcp__')) && checkProtectedFileWrite(value, cwd)) {
      return checkProtectedFileWrite(value, cwd);
    }
    if (tokenMentionsSecret(value)) return 'обращение к файлу с ключами или паролями (.env, .pem, id_rsa и т.п.)';
    if (tokenMentionsShellStartup(value)) return 'файл запуска оболочки или история команд (~/.zshrc, ~/.bashrc, ~/.zsh_history и т.п.): через Claude их не читают и не правят';
  }
  return null;
}
