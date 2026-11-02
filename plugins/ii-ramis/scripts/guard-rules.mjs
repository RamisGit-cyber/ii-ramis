// Правила охранника: ключи и пароли, git, скрипты из интернета, базы данных, переменные окружения.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tokenMentionsSecret, tokenMentionsShellStartup, realpathNearest } from './lib.mjs';
import os from 'node:os';
import { verbName, commandIndex, isAssignment, FETCH_NAMES } from './shell-parse.mjs';
import { directoryAfter } from './cd-track.mjs';
import { isProtectedPath } from './protect-rules.mjs';

const TRUSTED_HOSTS = new Set([
  'claude.ai', 'bun.sh', 'astral.sh', 'brew.sh', 'deno.land', 'sh.rustup.rs', 'fnm.vercel.app', 'get.pnpm.io', 'pnpm.io', 'volta.sh',
  'install.python-poetry.org', 'get.docker.com', 'cli.github.com', 'vercel.com', 'supabase.com', 'sdk.cloudflare.com', 'ohmyz.sh', 'rustup.rs',
  'deb.nodesource.com', 'rpm.nodesource.com', 'bootstrap.pypa.io', 'cursor.com', 'ollama.com', 'tailscale.com', 'astral.sh',
]);
const RAW_GITHUB_HOST = 'raw.githubusercontent.com';
// Доверяем Homebrew и nvm целиком, а claude-mem только одному точному файлу. Репозиторий курса (RamisGit-cyber/ii-ramis)
// сюда НЕ входит: наш установщик из Claude не запускается (см. installer-rules.mjs), ученик ставит его сам в Терминале.
const RAW_GITHUB_PREFIXES = ['/Homebrew/', '/nvm-sh/', '/astral-sh/', '/oven-sh/', '/pnpm/', '/ohmyzsh/', '/supabase/', '/vercel/', '/cli/', '/nodesource/', '/python-poetry/', '/rust-lang/', '/denoland/', '/Schniz/', '/volta-cli/', '/docker/'];
const RAW_GITHUB_EXACT_PATHS = new Set(['/thedotmack/claude-mem/main/install/install.sh']);

// Команды, которым можно упоминать секретный путь: они не читают содержимое.
const METADATA_VERBS = new Set([
  'echo', 'printf', 'write-output', 'write-host', 'test', '[', '[[', 'ls', 'dir', 'stat', 'touch', 'mkdir',
  'test-path', 'get-childitem', 'gci', 'get-item', 'gi', 'resolve-path', 'new-item', 'ni',
]);
const KEY_GENERATOR_VERBS = new Set(['ssh-keygen']); // создаёт ключ, не читает чужие
const TEXT_WRITER_VERBS = new Set(['add-content', 'ac', 'set-content', 'sc']);
const COPY_VERBS = new Set(['cp', 'copy', 'copy-item', 'cpi', 'mv', 'move', 'move-item', 'mi']);
const PATTERN_FIRST_VERBS = new Set(['grep', 'egrep', 'fgrep', 'rg', 'ag', 'sed', 'awk', 'gawk']);
const GIT_SAFE_SUBCOMMANDS = new Set(['check-ignore', 'ls-files', 'status']);
const TEXT_FLAGS = new Set(['-m', '-am', '--message', '--body', '-b', '--title', '-t']);

function gitSubcommand(args) {
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '-C' || args[i] === '-c') { i += 1; continue; }
    if (!args[i].startsWith('-')) return { name: args[i], rest: args.slice(i + 1) };
  }
  return { name: '', rest: [] };
}

function withoutTextArguments(tokens) {
  const kept = [];
  for (let i = 0; i < tokens.length; i += 1) {
    if (TEXT_FLAGS.has(tokens[i])) { i += 1; continue; }
    if (/^--(message|body|title)=/.test(tokens[i])) continue;
    kept.push(tokens[i]);
  }
  return kept;
}

function secretAllowed(cmd, mentionIndexes) {
  const { tokens } = cmd;
  const first = commandIndex(tokens);
  if (first === -1) return false;
  const name = verbName(tokens[first]);
  const args = tokens.slice(first + 1);
  if (METADATA_VERBS.has(name)) return true;
  // vercel env pull .env.local: файл с ключами создаёт сам vercel, Claude его не читает (cat .env.local по-прежнему закрыт)
  if (/^(?:npx\s+)?vercel(?:@\S+)?\s+(?:--?\S+\s+)*env\s+pull\b/.test(cmd.tokens.slice(first).join(' '))) return true;
  if (KEY_GENERATOR_VERBS.has(name) && !args.some((a) => /^-[a-zA-Z]*[ypRFD]$/.test(a))) return true;
  if (TEXT_WRITER_VERBS.has(name)) {
    // Add-Content .gitignore ".env*": имя файла в ТЕКСТЕ (-Value или второй аргумент), а путь записи не секретный
    const valueIndexes = new Set();
    let pathGiven = false;
    let positional = 0;
    for (let i = 0; i < args.length; i += 1) {
      const arg = args[i];
      if (/^-value$/i.test(arg)) { valueIndexes.add(first + 1 + i + 1); i += 1; continue; }
      if (/^-(path|literalpath|filepath)$/i.test(arg)) { pathGiven = true; i += 1; continue; }
      if (/^-(encoding|stream)$/i.test(arg)) { i += 1; continue; }
      if (arg.startsWith('-')) continue;
      positional += 1;
      if (positional === (pathGiven ? 1 : 2)) valueIndexes.add(first + 1 + i);
    }
    return mentionIndexes.every((i) => valueIndexes.has(i));
  }
  if (COPY_VERBS.has(name)) {
    const operands = tokens.map((t, i) => ({ t, i })).filter(({ t, i }) => i > first && !t.startsWith('-'));
    const destination = operands.length > 0 ? operands[operands.length - 1].i : -1;
    return mentionIndexes.every((i) => i === destination);
  }
  if (PATTERN_FIRST_VERBS.has(name)) {
    // Упоминание допустимо только там, где команда ищет ТЕКСТ (шаблон/скрипт), а не читает файл.
    const patternIndexes = new Set();
    const usesPatternFile = args.some((a) => /^(--file(=.*)?|-[a-zA-Z]*[fe][a-zA-Z]*)$/.test(a));
    const usesFlagPattern = args.some((a) => /^(-e|--regexp)$/.test(a)) && !args.some((a) => /^(--file(=.*)?|-[a-zA-Z]*f[a-zA-Z]*)$/.test(a));
    if (usesFlagPattern) {
      args.forEach((a, i) => { if (a === '-e' || a === '--regexp') patternIndexes.add(first + 2 + i); });
    } else if (!usesPatternFile) {
      patternIndexes.add(tokens.findIndex((t, i) => i > first && !t.startsWith('-')));
    }
    return mentionIndexes.every((i) => patternIndexes.has(i));
  }
  if (name === 'git' || name === 'gh') {
    const visible = withoutTextArguments(args);
    const stillMentioned = visible.some(tokenMentionsSecret);
    if (!stillMentioned) return true;
    if (name !== 'git') return false;
    const { name: sub, rest } = gitSubcommand(visible);
    if (GIT_SAFE_SUBCOMMANDS.has(sub)) return true;
    if (sub === 'rm' && rest.includes('--cached')) return true;
    if ((sub === 'reset' || sub === 'restore') && !rest.includes('--hard') && (sub === 'reset' || rest.includes('--staged'))) return true;
  }
  return false;
}

// Файлы запуска оболочки (~/.zshrc, ~/.bashrc, ~/.profile) и истории команд: можно только посмотреть, что файл есть.
const STARTUP_METADATA_VERBS = new Set(['ls', 'dir', 'stat', 'test', '[', '[[', 'test-path', 'get-childitem', 'gci', 'get-item', 'gi', 'resolve-path']);
const STARTUP_REASON = 'файл запуска оболочки или история команд (~/.zshrc, ~/.bashrc, ~/.profile, ~/.zsh_history и т.п.): через Claude их не читают и не правят';

// Из установщиков (Homebrew, nvm, uv, bun, pnpm, cargo): только известные переменные, известные папки в PATH и точные файлы для source.
const PATH_ENTRY = /^(?:\$\{?PATH\}?|(?:\$\{?HOME\}?|~)\/(?:\.local\/bin|\.bun\/bin|\.cargo\/bin|\.npm-global\/bin|\.volta\/bin|\.deno\/bin|go\/bin|\.pyenv\/bin|\.rbenv\/bin|\.fnm)|\/opt\/homebrew\/s?bin|\/usr\/local\/s?bin|\/home\/linuxbrew\/\.linuxbrew\/s?bin|\$\{?PNPM_HOME\}?|\$\{?BUN_INSTALL\}?\/bin|\$\{?VOLTA_HOME\}?\/bin|\$\{?GOPATH\}?\/bin|\$\{?CARGO_HOME\}?\/bin)$/;
const HOME_VARIABLE_VALUE = /^(?:(?:\$\{?HOME\}?|~)\/[\w./-]+|\/(?:Users|home)\/[\w.-]+(?:\/[\w. -]+)*)$/;
function startupExportAllowed(line) {
  const match = line.match(/^export ([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (!match) return false;
  const [, name, rawValue] = match;
  const value = /^".*"$/.test(rawValue) || /^'.*'$/.test(rawValue) ? rawValue.slice(1, -1) : rawValue;
  if (/[`;&|<>()\\\n]|\$\(|\.\./.test(value)) return false;
  if (name === 'PATH') {
    const entries = value.split(':');
    return entries.includes('$PATH') || entries.includes('${PATH}') ? entries.every((entry) => PATH_ENTRY.test(entry)) : false;
  }
  if (['NVM_DIR', 'PNPM_HOME', 'BUN_INSTALL', 'GOPATH', 'VOLTA_HOME', 'UV_INSTALL_DIR', 'CARGO_HOME', 'RUSTUP_HOME'].includes(name)) return HOME_VARIABLE_VALUE.test(value);
  return false;
}
const STARTUP_LINE_FORMS = [
  startupExportAllowed,
  (line) => /^eval "\$\((?:\/[\w./-]+\/)?(?:brew shellenv|fnm env(?: --use-on-cd)?|pyenv init -|rbenv init -|zoxide init \w+|direnv hook \w+)\)"$/.test(line),
  (line) => /^(?:source|\.) "?(?:~|\$HOME|\$\{HOME\})\/(?:\.nvm\/nvm\.sh|\.nvm\/bash_completion|\.cargo\/env|\.local\/bin\/env|\.bun\/_bun)"?$/.test(line),
  (line) => /^\[ -s "\$NVM_DIR\/(?:nvm\.sh|bash_completion)" \] && \\?\. "\$NVM_DIR\/(?:nvm\.sh|bash_completion)"(?: # [\w .-]+)?$/.test(line),
  (line) => /^# [\w .:()-]*$/.test(line),
];
const STARTUP_LINE_FORBIDDEN = /CLAUDE|IIRAMIS|ANTHROPIC|\.claude|\.ii-ramis|\.ssh|\.aws|\.env\b|token|secret|password|PROMPT_COMMAND|BASH_ENV|(?:^|[\s;])ENV=|NODE_OPTIONS|LD_|DYLD_|PYTHON/i;
function appendsStartupLine(cmd, mentionIndexes, name) {
  if (!(name === 'echo' || name === 'printf') || cmd.pipedInto || cmd.inSubstitution) return false;
  const { tokens } = cmd;
  const attached = (i) => /^\d*>>.+/.test(tokens[i]);
  if (!mentionIndexes.every((i) => attached(i) || (i > 0 && /^\d*>>$/.test(tokens[i - 1])))) return false;
  const first = commandIndex(tokens);
  const textTokens = tokens.slice(first + 1).filter((t, i) => !/^\d*>>/.test(t) && !mentionIndexes.includes(first + 1 + i) && !/^-[ne]+$/.test(t));
  if (textTokens.length !== 1) return false;
  const line = textTokens[0].replace(/(?:\\n)+$/, '');
  return !STARTUP_LINE_FORBIDDEN.test(line) && STARTUP_LINE_FORMS.some((form) => form(line));
}

function checkShellStartup(commands) {
  for (const cmd of commands) {
    const mentionIndexes = cmd.tokens.map((token, index) => (!cmd.consumed.has(index) && tokenMentionsShellStartup(token) ? index : -1)).filter((i) => i !== -1);
    if (mentionIndexes.length === 0) continue;
    const first = commandIndex(cmd.tokens);
    const name = first === -1 ? '' : verbName(cmd.tokens[first]);
    // Дозапись (>>) безобидной строки из установщиков (export PATH=…, eval "$(brew shellenv)", source ~/.nvm/nvm.sh) разрешена; перезапись и чтение нет.
    if (appendsStartupLine(cmd, mentionIndexes, name)) continue;
    const redirects = cmd.tokens.some((token) => /^\d*>/.test(token));
    if (!STARTUP_METADATA_VERBS.has(name) || redirects || cmd.pipedInto || cmd.inSubstitution) return STARTUP_REASON;
  }
  return null;
}

export function checkSecrets(commands) {
  const startup = checkShellStartup(commands);
  if (startup) return startup;
  for (const cmd of commands) {
    const mentionIndexes = cmd.tokens
      .map((token, index) => (cmd.consumed.has(index) || /^--exclude(?:-dir)?=/.test(token) ? -1 : (tokenMentionsSecret(token) ? index : -1)))
      .filter((index) => index !== -1);
    if (mentionIndexes.length === 0) continue;
    const first = commandIndex(cmd.tokens);
    const isGit = first !== -1 && verbName(cmd.tokens[first]) === 'git';
    // Имя файла внутри $(...) — способ спрятать его от проверки, поэтому там не прощаем ничего.
    if (!secretAllowed(cmd, mentionIndexes) || cmd.pipedInto || cmd.inSubstitution) {
      return isGit && /\badd\b/.test(cmd.tokens.slice(first + 1).join(' '))
        ? 'попытка добавить файл с ключами в git'
        : 'команда трогает файл с ключами или паролями (.env, .pem, id_rsa и т.п.)';
    }
  }
  return null;
}

function isSecretVariable(name) {
  return /key|token|secret|pass|credential|auth/i.test(name);
}

// Вывод значений секретных переменных: echo $GITHUB_TOKEN, printenv $x, голый export, compgen -e, $env:GITHUB_TOKEN.
const SECRET_NAME = '[A-Za-z0-9_]*(?:TOKEN|KEY|SECRET|PASSWORD|PASSWD|PASS|AUTH|CREDENTIAL)[A-Za-z0-9_]*';
const SECRET_VARIABLE_REF = new RegExp(String.raw`\$\{?${SECRET_NAME}\}?`, 'i');
const SECRET_ENV_REF = new RegExp(String.raw`\$\{?env:${SECRET_NAME}\}?`, 'i');
const OUTPUT_VERBS = new Set([
  'echo', 'printf', 'print', 'write-output', 'write-host', 'out-host', 'out-file', 'set-content', 'add-content', 'set-clipboard', 'cat', 'tee',
  'base64', 'xxd', 'od', 'strings', 'nl', 'head', 'tail', 'pbcopy', 'clip', 'logger', 'say',
]);

const INTERPRETER_NAME = /^(python[\d.]*|node|nodejs|bun|deno|ruby|perl|php)$/;
const ENVIRONMENT_FROM_CODE = /process\.env\b|os\.environ|os\.getenv|\bENV\[|\bgetenv\(|Deno\.env|Bun\.env|\$ENV\{/;

// Код в командной строке или в heredoc интерпретатора (python3 -c, node -e, python3 <<EOF): обычная работа Claude, разрешён.
// Закрыто только то, что задевает три защищаемые вещи: защищённые пути, окружение целиком, рекурсивное удаление домашней папки или корня.
// Остаточный риск (решение Рамиса): список ловит прямые упоминания, обфускация ('.cl'+'aude', chr(), base64) его обходит.
const CODE_PROTECTED = new RegExp(
  String.raw`\.claude|\.ii-ramis|ii-ramis|managed-settings|ClaudeCode|claude-code[/\\]|\.ssh|\.aws|\.gnupg|\.netrc|\.npmrc|\.git-credentials|id_rsa|id_ed25519|keychain|security\s+find-|find-(?:generic|internet)-password|/proc/[\w/*]*environ|` +
  String.raw`os\.environ|process\.env\b|getenv|\bENV\[|\.env(?:\.local|\.production|\.development)?['"\s)]|credentials\.json|CLAUDE_CONFIG_DIR`,
  'i',
);
const CODE_RECURSIVE_DELETE = /rmtree|rmSync|rmdirSync|\bfs\.rm\b|fs\.promises\.rm|removedirs|rimraf|rm\s+-[a-z]*r|Remove-Item[^\n]*-Recurse|shutil\.rmtree|\bdel\s+\/s/i;
const CODE_HOME_OR_ROOT = /expanduser|Path\.home|homedir|os\.homedir|\$HOME|%USERPROFILE%|USERPROFILE|['"]~|['"]\/['"]|['"]\/(?:usr|etc|bin|System|Library|Users|home|var)['"/]|Desktop|Documents|Downloads/i;
const PLUGIN_FOLDER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..').toLowerCase();

export function checkInlineCode(commands) {
  for (const cmd of commands) {
    const at = commandIndex(cmd.tokens);
    if (at === -1 || !INTERPRETER_NAME.test(verbName(cmd.tokens[at]))) continue;
    const args = cmd.tokens.slice(at + 1);
    const inline = args.filter((t, i) => i > 0 && /^(?:-c|-e|-p|-r|-E|--eval|--print)$/.test(args[i - 1]));
    const code = [...inline, ...(cmd.heredocBodies || [])].join('\n');
    if (!code) continue;
    if (CODE_PROTECTED.test(code) || code.toLowerCase().includes(PLUGIN_FOLDER)) {
      return 'код в команде трогает защищённые места (.claude, .ssh, .aws, ключи, переменные окружения, папку плагина): настройки, ключи и защиту через код не читают и не меняют';
    }
    if (CODE_RECURSIVE_DELETE.test(code) && CODE_HOME_OR_ROOT.test(code)) {
      return 'код в команде рекурсивно удаляет домашнюю папку, Рабочий стол, Документы или корень диска';
    }
  }
  return null;
}

// Рекурсивный grep по всей папке (`grep -r KEY .`, `grep -r x ~`) прочитает и .env: ищи в src или добавь --exclude='.env*'. rg по умолчанию обходит файлы из .gitignore, а с -u/--no-ignore нет.
const WHOLE_TREE_TARGET = /^(?:\.\/?|\.\.\/?|~\/?|\$HOME\/?|\*|\.\/\*|\/)$/;
export function checkRecursiveSecretSearch(commands) {
  for (const { tokens } of commands) {
    const at = commandIndex(tokens);
    if (at === -1) continue;
    const name = verbName(tokens[at]);
    const args = tokens.slice(at + 1);
    const excludesEnv = args.some((a) => /^--exclude(?:-dir)?=.*\.env|^--exclude(?:-dir)?$/.test(a)) && args.some((a) => /\.env/.test(a));
    if (['grep', 'egrep', 'fgrep'].includes(name) && args.some((a) => /^-[a-zA-Z]*[rR][a-zA-Z]*$|^--(recursive|dereference-recursive)$/.test(a)) && args.some((a) => WHOLE_TREE_TARGET.test(a)) && !excludesEnv) {
      return 'рекурсивный grep по всей папке прочитает и файлы с ключами (.env): ищи в src или добавь --exclude=\'.env*\'';
    }
    if (['rg', 'ag', 'ack'].includes(name) && args.some((a) => /^-u+$|^--no-ignore|^--unrestricted$|^-[a-zA-Z]*u{1,3}[a-zA-Z]*$/.test(a)) && !excludesEnv) {
      return 'поиск без учёта .gitignore прочитает и файлы с ключами (.env)';
    }
  }
  return null;
}

export function checkEnvironmentDump(commands) {
  for (const { tokens } of commands) {
    const interpreterAt = commandIndex(tokens);
    if (interpreterAt !== -1 && INTERPRETER_NAME.test(verbName(tokens[interpreterAt])) && tokens.slice(interpreterAt + 1).some((t) => ENVIRONMENT_FROM_CODE.test(t) && /\s|\(|\)/.test(t))) {
      return 'код в командной строке читает переменные окружения (там бывают ключи): запиши код в файл и не печатай окружение';
    }
    const lead = commandIndex(tokens);
    if (lead !== -1) {
      const leadName = verbName(tokens[lead]);
      const leadArgs = tokens.slice(lead + 1);
      if (OUTPUT_VERBS.has(leadName) && leadArgs.some((a) => SECRET_VARIABLE_REF.test(a))) return 'вывод значения секретной переменной (токен, ключ, пароль)';
      if (leadName === 'printenv' && leadArgs.some((a) => /\$|`/.test(a))) return 'printenv с переменной в аргументе: не могу проверить, что он выведет';
      if (leadName === 'export' && leadArgs.length === 0) return 'вывод всех переменных окружения (там бывают ключи)';
      if (leadName === 'compgen' && leadArgs.some((a) => /^-[a-z]*[ev]/.test(a))) return 'список переменных окружения (там бывают ключи)';
    }
    if (tokens.some((t) => SECRET_ENV_REF.test(t))) return 'чтение секретной переменной окружения ($env:…TOKEN, KEY, SECRET)';
    if (tokens.some((t) => /^["']?env:.*\$/i.test(t))) return 'чтение переменной окружения по имени из переменной: не могу проверить, что выведется';

    const first = commandIndex(tokens);
    const rawFirst = tokens.findIndex((t) => !isAssignment(t));
    for (const index of new Set([first, rawFirst].filter((i) => i !== -1))) {
      const name = verbName(tokens[index]);
      const args = tokens.slice(index + 1).filter((a) => !a.startsWith('-') && !isAssignment(a));
      if (name === 'env' && args.length === 0) return 'вывод всех переменных окружения (там бывают ключи)';
      if (name === 'printenv' && (args.length === 0 || args.some(isSecretVariable))) return 'вывод переменных окружения (там бывают ключи)';
      if (name === 'set' && tokens.length === index + 1) return 'вывод всех переменных оболочки (там бывают ключи)';
      if ((name === 'export' || name === 'declare' || name === 'typeset') && tokens.slice(index + 1).some((a) => /^-[a-z]*[px]/.test(a)) && args.length === 0) {
        return 'вывод всех переменных окружения (там бывают ключи)';
      }
    }
    if (tokens.some((t) => /^env:\*?$/i.test(t) || /^env:.*(key|token|secret|pass)/i.test(t))) {
      return 'вывод переменных окружения (там бывают ключи)';
    }
    const gh = tokens.findIndex((t) => verbName(t) === 'gh');
    if (gh !== -1 && tokens[gh + 1] === 'auth' && tokens[gh + 2] === 'token') return 'вывод токена GitHub';
    if (tokens.some((t) => verbName(t) === 'security') && tokens.some((t) => /^(?:find-[\w-]+|dump-keychain|export|import|unlock-keychain|show-keychain-info|list-keychains|get-identity-preference)$/.test(t))) {
      return 'чтение паролей из связки ключей';
    }
  }
  return null;
}

// Настройки git, через которые запускается произвольная команда (fsmonitor, hooksPath, alias с «!», pager, editor, ssh, textconv…).
const DANGEROUS_GIT_KEY = /^(?:core\.(?:fsmonitor|hookspath|sshcommand|pager|editor|askpass|gitproxy|attributesfile|excludesfile|worktree)|alias\.|credential\.|sequence\.editor|diff\.[^=]*\.(?:textconv|command)|merge\.[^=]*\.driver|filter\.|http\.|url\.|protocol\.|safe\.|include|gpg\.|uploadpack\.|receive\.|pager\.|submodule\.|remote\.[^=]*\.(?:receivepack|uploadpack|vcs))/i;
function gitConfigReason(tokens, index) {
  const args = tokens.slice(index + 1);
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    const inline = arg === '-c' || arg === '--config-env' ? args[i + 1] : (/^-c./.test(arg) ? arg.slice(2) : (/^--config-env=/.test(arg) ? arg.split('=').slice(1).join('=') : null));
    if (inline !== null && inline !== undefined && (DANGEROUS_GIT_KEY.test(inline) || /^[^=]*=\s*!/.test(inline))) return 'git -c с настройкой, которая запускает произвольную команду (core.fsmonitor, alias, hooksPath…)';
  }
  const { name, rest } = gitSubcommand(args);
  if (name === 'config' && rest.some((a) => /^(?:-l|--list|--get-regexp|--get-urlmatch|--show-origin|--show-scope)$/.test(a))) {
    return 'git config --list показывает все настройки, включая токены в адресах (https://логин:токен@…): ученик может посмотреть сам в Терминале';
  }
  const positional = rest.filter((a) => !a.startsWith('-'));
  const safeHelper = positional.length === 2 && positional[0].toLowerCase() === 'credential.helper' && /^(?:osxkeychain|manager|manager-core|wincred|libsecret)$/.test(positional[1]);
  if (name === 'config' && safeHelper && rest.every((a) => !a.startsWith('-') || /^--(global|local|system)$/.test(a))) return null;
  if (name === 'config' && rest.some((a) => DANGEROUS_GIT_KEY.test(a) || a.startsWith('!'))) return 'git config с настройкой, которая запускает произвольную команду (alias с «!», core.fsmonitor, hooksPath…)';
  return null;
}

// Принудительная отправка и удаление веток разрешены для своих веток (feat/login). Закрыто: main/master, «всё сразу» и отправка без явного имени ветки.
const PROTECTED_BRANCH = /^(?:refs\/heads\/)?(?:main|master|HEAD|trunk)$/i;
function gitPushReason(rest) {
  const flags = rest.filter((a) => a.startsWith('-'));
  const operands = rest.filter((a) => !a.startsWith('-'));
  const forced = flags.some((a) => /^(--force|--force-with-lease|--force-if-includes)(=.*)?$/.test(a) || /^-[a-zA-Z]*f[a-zA-Z]*$/.test(a)) || operands.some((a) => a.startsWith('+'));
  const deleting = flags.some((a) => /^(--delete|-d)$/.test(a)) || operands.some((a) => a.startsWith(':'));
  const wholesale = flags.some((a) => /^(--mirror|--all|--tags|--prune)$/.test(a));
  if (wholesale && (forced || deleting || flags.includes('--mirror') || flags.includes('--prune'))) return 'принудительная отправка или удаление для всех веток сразу (--mirror, --all, --prune): перезапишет или удалит чужие сохранения';
  if (!forced && !deleting) return null;
  const branches = operands.slice(1); // первый операнд — имя удалённого репозитория
  if (branches.length === 0) return 'принудительная отправка без явного имени ветки: может перезаписать main в облаке. Укажи свою ветку явно: origin feat/имя';
  for (const branch of branches) {
    const target = branch.replace(/^\+/, '').split(':').pop();
    if (PROTECTED_BRANCH.test(target) || target === '') return 'принудительная отправка или удаление ветки main/master в облаке (перезапишет чужие сохранения)';
  }
  return null;
}

function checkGitCommand(tokens, index) {
  const configReason = gitConfigReason(tokens, index);
  if (configReason) return configReason;
  const { name, rest } = gitSubcommand(tokens.slice(index + 1));
  const has = (pattern) => rest.some((a) => pattern.test(a));
  if (name === 'push') {
    const reason = gitPushReason(rest);
    if (reason) return reason;
  }
  if (name === 'filter-branch' || name === 'filter-repo') return 'переписывание истории проекта';
  return null;
}

export function checkGit(commands) {
  for (const { tokens } of commands) {
    for (let index = 0; index < tokens.length; index += 1) {
      if (verbName(tokens[index]) !== 'git') continue;
      const reason = checkGitCommand(tokens, index);
      if (reason) return reason;
    }
  }
  return null;
}

// SQL-запросы опасны, только когда их отправляют в базу (psql, mysql, sqlite3…). Текст «DROP TABLE» в файле миграции или в сообщении коммита не трогаем.
const DB_CLIENTS = new Set(['psql', 'pgcli', 'mysql', 'mariadb', 'sqlite3', 'sqlcmd', 'mongosh', 'mongo', 'redis-cli', 'usql', 'turso']);
export function checkDatabase(command, commands = []) {
  const toClient = commands.some(({ tokens }) => {
    const at = commandIndex(tokens);
    return at !== -1 && DB_CLIENTS.has(verbName(tokens[at]));
  });
  const checks = [
    [/(^|[\s;&|])dropdb(\s|$)/i, 'dropdb: удаление базы'],
    [/supabase(?:@\S+)?\s+(?:--?\S+\s+)*projects\s+delete/i, 'удаление проекта Supabase в облаке'],
    [/supabase(?:@\S+)?\s+(?:--?\S+\s+)*db\s+reset\b[^|;&]*--linked/i, 'сброс боевой базы Supabase (db reset --linked)'],
    [/gh\s+repo\s+delete/i, 'удаление репозитория на GitHub'],
    [/vercel(?:@\S+)?\s+project\s+(rm|remove)\b/i, 'удаление проекта на Vercel'],
  ];
  const clientChecks = [
    [/\bdrop\s+(database|table|schema)\b/i, 'удаление базы или таблицы (DROP)'],
    [/\btruncate\s+(table\s+)?\w+/i, 'очистка таблицы (TRUNCATE)'],
    [/\bdelete\s+from\s+[\w."]+\s*(;|"|'|$)/i, 'DELETE без условия WHERE: сотрёт все строки'],
    [/dropdatabase|flushall|flushdb/i, 'удаление данных из базы'],
  ];
  for (const [pattern, reason] of [...checks, ...(toClient ? clientChecks : [])]) {
    if (pattern.test(command)) return reason;
  }
  return null;
}

// Доверенный адрес: https, имя хоста строго из списка, без логина-пароля и порта.
// Префиксы пути доверяем только у raw.githubusercontent.com (там путь = чей репозиторий).
export function isTrustedUrl(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return false;
  if (TRUSTED_HOSTS.has(url.hostname)) return true;
  if (url.hostname !== RAW_GITHUB_HOST) return false;
  return RAW_GITHUB_EXACT_PATHS.has(url.pathname) || RAW_GITHUB_PREFIXES.some((prefix) => url.pathname.startsWith(prefix));
}

// ---- Скрипты из интернета: запрет по умолчанию, смотрим на разобранные команды ----
// Любой конвейер «загрузчик -> интерпретатор» (и <(curl ...), и $(curl ...) внутри интерпретатора) разрешён
// только для доверенного https-адреса и безобидного набора флагов. Что читает интерпретатор, не угадываем.
const PIPE_TARGETS = new Set([
  'sh', 'bash', 'zsh', 'dash', 'ksh', 'ash', 'fish', 'csh', 'tcsh', 'node', 'nodejs', 'bun', 'deno', 'ruby', 'perl', 'php',
  'pwsh', 'powershell', 'iex', 'invoke-expression', 'eval', 'source', '.',
]);
const SAFE_FETCH_LONG_FLAGS = new Set(['--fail', '--silent', '--show-error', '--location', '--tlsv1.2', '-usebasicparsing']);
const SAFE_FETCH_SHORT_FLAGS = /^-[fsSLq]+$/;

function isInterpreterName(name) {
  return PIPE_TARGETS.has(name) || /^python[\d.]*$/.test(name);
}

// Загрузчик доверенный: все аргументы — безобидные флаги или https-адреса из списка, и хотя бы один адрес есть.
function fetchIsTrusted(tokens) {
  const start = tokens.findIndex((t) => FETCH_NAMES.has(verbName(t)));
  if (start === -1) return true;
  const args = tokens.slice(start + 1);
  let urls = 0;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '-O-' || arg === '-o-' || arg === '-qO-' || /^-uri$/i.test(arg)) continue;
    if ((arg === '-O' || arg === '-o') && args[i + 1] === '-') { i += 1; continue; }
    if (arg === '--proto' && args[i + 1] === '=https') { i += 1; continue; }
    if (SAFE_FETCH_SHORT_FLAGS.test(arg) || SAFE_FETCH_LONG_FLAGS.has(arg.toLowerCase())) continue;
    if (arg.startsWith('-')) return false;
    if (!isTrustedUrl(arg)) return false;
    urls += 1;
  }
  return urls > 0;
}

export function checkPipeToShell(commands) {
  for (const cmd of commands) {
    const start = commandIndex(cmd.tokens);
    if (start === -1 || !isInterpreterName(verbName(cmd.tokens[start]))) continue;
    const upstream = [];
    for (let prev = cmd.prev; prev; prev = prev.prev) upstream.push(prev);
    // $(...) или бэктики в любой предыдущей стадии конвейера: что уйдёт в интерпретатор, заранее не видно
    if (upstream.some((c) => c.subs.length > 0 || c.tokens.some((t) => /\$\(|`/.test(t)))) {
      return 'в интерпретатор подаётся результат подстановки $(...) или `...`: не могу проверить, что именно запустится';
    }
    const fetchers = [...upstream, ...cmd.subs].filter((c) => c.tokens.some((t) => FETCH_NAMES.has(verbName(t))));
    if (fetchers.some((c) => !fetchIsTrusted(c.tokens))) {
      return 'запуск скрипта, скачанного из интернета, с непроверенного адреса или с нестандартными флагами';
    }
  }
  return null;
}

// ---- Выгрузка файлов наружу: curl -d @файл, --data-binary @файл, -F файл=@..., -T, wget --post-file ----
// Это страховочная сетка: обычные запросы с коротким текстом (curl -d '{"a":1}') не трогаем.
// Другие способы отправить файл (scp, rsync, nc, свой скрипт на Node/Python) сетка не ловит, см. README.
const CURL_ARG_SHORT = new Set('AbcCdDeEFHKmoPQrTuUwXxyYz'.split(''));
const UPLOAD_REASON = 'отправка файла или вывода команды в интернет (curl -d @файл, --data-binary, -F, -T, wget --post-file): страховка не пропускает выгрузку данных';

function curlValueUploads(option, value) {
  if (value === undefined) return false;
  if (option === 'H' || option === 'header') return value.startsWith('@') || /\$\(|`/.test(value); // -H @файл: заголовки из файла; $(cat файл) внутри заголовка
  if (option === 'variable') return value.includes('@') || value.startsWith('%'); // --variable имя@файл читает файл, %ИМЯ тянет переменную окружения
  if (/[$`]/.test(value)) return true; // содержимое подставляется на лету: $(cat файл), $(< файл)
  if (option === 'T' || option === 'upload-file') return true; // любой -T: «загрузить файл», в том числе поток из tar
  if (option === 'data-urlencode' || option === 'url-query') return /^[^=]*@/.test(value);
  if (option === 'F' || option === 'form') return /(^|=)[@<]/.test(value);
  return value.startsWith('@');
}

// Длинные ключи, значение которых curl может прочитать из файла или подставить: data*, form, upload-file, json, header, variable.
const CURL_UPLOAD_LONG = ['data', 'data-ascii', 'data-binary', 'data-urlencode', 'form', 'upload-file', 'json', 'header', 'variable', 'url-query'];
const CURL_FILE_CONFIG_REASON_SHORT = new Set(['K']);

// Ключи, которые запрещены целиком: --config/-K читает команды из файла, --expand-* подставляет {{переменные}} и файлы.
function curlBannedLongOption(name) {
  if (name.length >= 3 && 'config'.startsWith(name)) return true;
  return name.length >= 2 && ('expand-'.startsWith(name) || name.startsWith('expand-'));
}

function curlUploads(args) {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--') break;
    if (arg.startsWith('--')) {
      const [rawName, inlineValue] = arg.slice(2).split(/=(.*)/s);
      const name = rawName.toLowerCase();
      if (curlBannedLongOption(name)) return true;
      const option = name.length >= 2 && name !== 'url' ? CURL_UPLOAD_LONG.find((long) => long.startsWith(name)) : undefined;
      if (option && curlValueUploads(option, inlineValue ?? args[i + 1])) return true;
    } else if (/^-[A-Za-z]/.test(arg)) {
      for (let c = 1; c < arg.length; c += 1) {
        if (CURL_FILE_CONFIG_REASON_SHORT.has(arg[c])) return true;
        if (!CURL_ARG_SHORT.has(arg[c])) continue;
        const value = arg.slice(c + 1) || args[i + 1];
        if (['d', 'F', 'T', 'H'].includes(arg[c]) && curlValueUploads(arg[c], value)) return true;
        break; // остаток токена и есть значение этого флага
      }
    }
  }
  return false;
}

function wgetUploads(args) {
  return args.some((arg) => /^--(post-file|body-file)(=|$)/i.test(arg) || /^--(post|body)-?f/i.test(arg));
}

function powershellUploads(args) {
  for (let i = 0; i < args.length; i += 1) {
    if (/^-infile$/i.test(args[i])) return true;
    if (/^-(body|form)$/i.test(args[i]) && /get-content|\bgc\b|readall|[$`(]/i.test(args[i + 1] || '')) return true;
  }
  return false;
}

export function checkUpload(commands) {
  for (const { tokens } of commands) {
    for (let index = 0; index < tokens.length; index += 1) {
      const name = verbName(tokens[index]);
      const args = tokens.slice(index + 1);
      if (name === 'curl' && curlUploads(args)) return UPLOAD_REASON;
      if (name === 'wget' && wgetUploads(args)) return UPLOAD_REASON;
      if (['iwr', 'irm', 'invoke-webrequest', 'invoke-restmethod'].includes(name) && powershellUploads(args)) return UPLOAD_REASON;
      if (['http', 'https', 'xh'].includes(name) && args.some((a) => /(^|[^=:])@(?=\S)/.test(a) && !a.includes('://'))) return UPLOAD_REASON;
    }
  }
  return null;
}

// ---- (интерпретаторы больше не ограничиваем, см. checkInlineCode) ---- Интерпретаторы: белый список. Код в командной строке не разбираем, а запрещаем целиком ----
// Разрешено только: <интерпретатор> <файл внутри проекта> [аргументы], --version/-V/-v, python -m pip|venv|http.server,
// PowerShell -NoProfile -File <файл в проекте>. Всё остальное: «запиши код в файл проекта и запусти файл».
const INTERPRETER_VERBS = /^(python[\d.]*|node|nodejs|bun|deno|ruby|perl|php|pwsh|powershell)$/;
const VERSION_FLAGS = new Set(['--version', '-V', '-v']);
const PYTHON_MODULES = new Set(['pip', 'venv', 'http.server']);
const POWERSHELL_PRE_FLAGS = /^-(noprofile|noninteractive|nologo)$/i;
const INTERPRETER_DENY = 'интерпретатор запускает код из командной строки или с флагами, которые я не проверяю: запиши код в файл проекта и запусти файл';

// Скрипт обязан существовать: лежать в проекте или в домашней папке ученика (кроме точка-папок и Library), не в защищённом месте.
// `cd my-app && node server.js`: путь файла считаем от папки, куда сделали cd (workingDir), а «проектом» остаётся исходная папка.
function isScriptInProject(rawFile, workingDir, extension, cwd = workingDir) {
  const file = rawFile && rawFile.replace(/\$\{?CLAUDE_PLUGIN_ROOT\}?/g, path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
  if (!file || !extension.test(file) || file.startsWith('-') || /[$`*?[\]{}~<>]/.test(file) || /^[a-z][a-z0-9+.-]*:/i.test(file)) return false; // схемы http:, data:, npm:, jsr: — не файл
  if (workingDir === null && !path.isAbsolute(file)) return false;
  const base = workingDir ?? cwd;
  const resolved = path.resolve(base, file);
  const inside = (child, parent) => {
    const relative = path.relative(parent, child);
    return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
  };
  const pluginScripts = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
  const isRealFile = (target) => {
    try { return fs.statSync(target).isFile(); } catch { return false; }
  };
  if (inside(resolved, pluginScripts)) return isRealFile(resolved);
  if (!isRealFile(resolved) || isProtectedPath(resolved, base)) return false;
  const real = realpathNearest(resolved);
  const roots = [cwd, os.homedir()].map(realpathNearest);
  const homeReal = realpathNearest(os.homedir());
  return roots.some((root) => inside(real, root)) &&
    (inside(real, realpathNearest(cwd)) || !/^(?:\.|Library$|Applications$|AppData$)/i.test(path.relative(homeReal, real).split(path.sep)[0])) &&
    !isProtectedPath(real, base);
}

const SCRIPT_EXTENSION = {
  python: /\.py$/i, node: /\.(m?js|cjs|tsx?|jsx)$/i, ruby: /\.rb$/i, perl: /\.pl$/i, php: /\.php$/i, powershell: /\.ps1$/i,
};
const BUN_PACKAGE_COMMANDS = new Set(['install', 'i', 'add', 'remove', 'rm', 'update', 'pm']);

function extensionFor(name) {
  if (/^python/.test(name)) return SCRIPT_EXTENSION.python;
  if (/^(node|nodejs|bun|deno)$/.test(name)) return SCRIPT_EXTENSION.node;
  if (name === 'pwsh' || name === 'powershell') return SCRIPT_EXTENSION.powershell;
  return SCRIPT_EXTENSION[name];
}

// Короткий код прямо в команде (`python3 -c "print(1)"`, `node -e "console.log(1)"`): разрешён, если нет запуска программ, сети, окружения,
// удаления, eval и защищённых путей. Это скорость-лимит, а не стена: то же самое можно записать в файл проекта и запустить.
const INLINE_FLAGS = { python: new Set(['-c']), node: new Set(['-e', '-p', '--eval', '--print']), ruby: new Set(['-e']), perl: new Set(['-e']), php: new Set(['-r']) };
const INLINE_CODE_DENY = new RegExp(
  String.raw`\.claude|\.ssh|\.aws|\.env|\.npmrc|\.netrc|credential|id_rsa|id_ed25519|\.pem|keychain|ii-ramis|settings|hooks|plugins|environ|process\.env|getenv|` +
  String.raw`\bos\b|\bsys\.modules|subprocess|popen|system\(|spawn|\bexec|child_process|eval|Function\(|compile\(|__import__|importlib|ctypes|` +
  String.raw`rmSync|rmdirSync|unlink|rmtree|rmdir|\bremove\(|\bshutil|\bglob\b|walk|chmod|chown|rename|symlink|` +
  String.raw`socket|http|urllib|request|fetch|XMLHttp|smtp|ftp|ssh|curl|wget|base64|b64|atob|btoa|chr\(|fromCharCode|\\x[0-9a-f]{2}|\\u[0-9a-f]{4}|` +
  String.raw`\$|\`|\bsh\b|bash|powershell|cmd\.exe`,
  'i',
);
function inlineCodeAllowed(name, args) {
  const family = /^python/.test(name) ? 'python' : /^(node|nodejs)$/.test(name) ? 'node' : name;
  const flags = INLINE_FLAGS[family];
  if (!flags || args.length !== 2 || !flags.has(args[0])) return false;
  const code = args[1];
  return code.length > 0 && code.length <= 1500 && !INLINE_CODE_DENY.test(code);
}

function interpreterAllowed(name, args, cwd, workingDir = cwd) {
  if (args.length === 1 && VERSION_FLAGS.has(args[0])) return true;
  if (inlineCodeAllowed(name, args)) return true;
  if (name === 'pwsh' || name === 'powershell') {
    let i = 0;
    while (i < args.length && POWERSHELL_PRE_FLAGS.test(args[i])) i += 1;
    return /^-file$/i.test(args[i] || '') && isScriptInProject(args[i + 1], workingDir, extensionFor(name), cwd);
  }
  if (/^python/.test(name) && args[0] === '-m') return PYTHON_MODULES.has(args[1]);
  const extension = extensionFor(name);
  if (name === 'deno') return args[0] === 'run' && isScriptInProject(args[1], workingDir, extension, cwd);
  if (name === 'bun') {
    if (BUN_PACKAGE_COMMANDS.has(args[0])) return true; // пакетный менеджер, а не запуск кода
    if (args[0] === 'run') return isScriptInProject(args[1], workingDir, extension, cwd) || /^[\w:-]+$/.test(args[1] || ''); // файл или скрипт из package.json
  }
  return isScriptInProject(args[0], workingDir, extension, cwd);
}

// Общее правило: если в строке есть интерпретатор, то менять окружение или собирать команды «на лету» в этой же строке нельзя.
const ENVIRONMENT_VERBS = new Set(['export', 'declare', 'typeset', 'set', 'setenv', 'source', '.', 'unset', 'read', 'env']);
const INDIRECT_RUNNERS = new Set(['xargs', 'parallel', 'watch', 'env']);

// source .venv/bin/activate: включение виртуального окружения Python, а не произвольный файл.
function isVirtualEnvActivation(tokens, start) {
  const verb = verbName(tokens[start]);
  return (verb === 'source' || verb === '.') && tokens.length === start + 2 && /(^|[/\\])(?:bin|Scripts)[/\\]activate(?:\.ps1)?$/i.test(tokens[start + 1]) && !/[$`*?[\]{}]/.test(tokens[start + 1]);
}

function changesEnvironmentOrRunsIndirectly(cmd) {
  const { tokens } = cmd;
  const start = commandIndex(tokens);
  if (start !== -1 && ENVIRONMENT_VERBS.has(verbName(tokens[start])) && !isVirtualEnvActivation(tokens, start)) return true;
  if (tokens.some((t) => INDIRECT_RUNNERS.has(verbName(t)))) return true;
  if (tokens.some((t) => verbName(t) === 'find') && tokens.some((t) => /^-(exec|execdir)$/.test(t))) return true;
  return tokens.some((t) => /^\$?env:/i.test(t) || /CLAUDE_PLUGIN_ROOT=/.test(t));
}

export function checkInterpreters(commands, cwd) {
  const hasInterpreter = commands.some((cmd) => {
    const at = commandIndex(cmd.tokens);
    return at !== -1 && INTERPRETER_VERBS.test(verbName(cmd.tokens[at]));
  });
  if (hasInterpreter && commands.some(changesEnvironmentOrRunsIndirectly)) {
    return 'вместе с интерпретатором в одной строке меняется окружение или команда собирается на лету (export, source, env, xargs, find -exec): запускай по одному шагу';
  }
  let workingDir = cwd;
  for (const cmd of commands) {
    const start = commandIndex(cmd.tokens);
    if (start === -1) continue;
    const name = verbName(cmd.tokens[start]);
    const moved = directoryAfter(cmd.tokens, workingDir);
    if (moved !== undefined) { workingDir = moved; continue; }
    if (!INTERPRETER_VERBS.test(name)) continue;
    const prefix = cmd.tokens.slice(0, start);
    if (prefix.some((t) => isAssignment(t) || verbName(t) === 'env')) return INTERPRETER_DENY; // VAR=x python3 ..., env VAR=x node ...: безобидные переменные убирает inline-vars.mjs
    if (cmd.heredoc || cmd.tokens.some((t) => /^\d*<</.test(t) || /^\d*<(?!\()/.test(t))) return INTERPRETER_DENY; // любой ввод через <, <<, <<<
    if (!interpreterAllowed(name, cmd.tokens.slice(start + 1), cwd, workingDir)) return INTERPRETER_DENY;
  }
  return null;
}

// ---- Читающая команда с переменной в аргументе: куда она смотрит, проверить нельзя ----
const READER_VERBS = new Set([
  'cat', 'less', 'more', 'head', 'tail', 'bat', 'xxd', 'od', 'strings', 'base64', 'type', 'get-content', 'gc',
  'nl', 'tac', 'cut', 'source', '.', 'tar', 'zip', 'scp', 'cp',
]);

export function checkUnverifiableReads(commands) {
  for (const { tokens } of commands) {
    const start = commandIndex(tokens);
    if (start === -1 || !READER_VERBS.has(verbName(tokens[start]))) continue;
    if (tokens.slice(start + 1).some((t) => /[$`]/.test(t))) {
      return 'читающая команда получает путь из переменной или подстановки: не могу проверить, что она откроет';
    }
  }
  return null;
}

// Попытки выдать себе разрешение или переписать защиту: старый approve.mjs и файл одобрений.
export function checkSelfApproval(text) {
  return /approve\.mjs|[/\\]\.ii-ramis[/\\]+approv|approvals\.json/i.test(text)
    ? 'попытка выдать себе разрешение в обход защиты'
    : null;
}

// Приёмы, которые не видны по словам верхнего уровня: .NET-вызовы PowerShell, запуск процессов, чтение окружения целиком.
const TEXT_PATTERNS = [
  [/\[\s*(?:System\.)?Environment\s*\]\s*::\s*GetEnvironmentVariables?/i, 'чтение переменных окружения через .NET (там бывают ключи)'],
  [/\$\{!/, 'косвенная подстановка ${!имя}: не могу проверить, какую переменную она выведет'],
  [/\$\{?env:\s*\$/i, 'чтение переменной окружения по имени из переменной'],
  [/\[\s*(?:System\.)?IO\.\w+\s*\]\s*::\s*(?:Delete|Move|Replace|Write\w*|Append\w*|Create\w*|Copy|SetAttributes)/i, 'удаление или запись файлов через .NET ([IO.Directory]::Delete и т.п.): защита правил PowerShell так не обходится'],
  // открыть адрес в браузере (одна ссылка http/https и больше ничего) можно
  // и запустить npm/npx/pnpm/yarn/bun с простыми словами-аргументами (dev-сервер в отдельном процессе)
  [/(?:^|[\s;|&(])(?:start-process|saps)(?![\w-])(?!\s+['"]?https?:\/\/[^\s'";|&`$(){}]+['"]?\s*$)(?!\s+(?:npm|npx|pnpm|yarn|bun)(?:\.cmd)?(?:\s+-ArgumentList\s+(?:"[\w .:@\/=-]*"|'[\w .:@\/=-]*'|[\w.:\/=-]+)(?:,(?:"[\w .:@\/=-]*"|'[\w .:@\/=-]*'|[\w.:\/=-]+))*)?(?:\s+-(?:WindowStyle\s+Hidden|NoNewWindow))*\s*$)/i, 'Start-Process запускает любую программу в обход проверок (ссылку в браузере открыть можно: Start-Process https://…; npm/npx/pnpm/yarn/bun с простыми аргументами тоже)'],
  [/\[\s*scriptblock\s*\]\s*::\s*Create/i, 'сборка скриптблока из строки: выполняет любой код'],
  [/\[\s*(?:System\.)?Diagnostics\.Process\s*\]|New-Object\s+(?:System\.)?Diagnostics\.Process/i, 'запуск процесса через .NET'],
  [/Add-Type|\[\s*Activator\s*\]|\[\s*(?:System\.)?Reflection\./i, 'загрузка .NET-кода или рефлексия в PowerShell'],
  [/\bcompgen\s+-[a-z]*[ev]\b/i, 'список переменных окружения (там бывают ключи)'],
];
export function checkTextPatterns(command) {
  for (const [pattern, reason] of TEXT_PATTERNS) {
    if (pattern.test(command)) return reason;
  }
  return null;
}

// vercel env pull пишет секреты проекта в файл .env: это делает ученик сам, а не Claude.
export function checkVercelEnvPull(command) {
  return /\bvercel(?:@\S+)?\s+(?:--?\S+\s+)*env\s+(?:--?\S+\s+)*pull\b/i.test(command)
    ? 'vercel env pull записывает секреты проекта в файл (.env): сделай это сам в обычном Терминале (не через Claude): vercel env pull .env.local, потом не показывай файл Claude'
    : null;
}


// Отправка секретов наружу: файлы с ключами ловят правила про секретные пути, а здесь закрыты обходы через curl:
// -K/--config (команды из файла), --expand-*, --variable %ИМЯ (значение переменной окружения), (файлы с ключами в -d @файл ловят правила про секретные пути).
export function checkCurlSecretExfil(commands) {
  for (const { tokens } of commands) {
    for (let index = 0; index < tokens.length; index += 1) {
      if (verbName(tokens[index]) !== 'curl') continue;
      const args = tokens.slice(index + 1);
      for (let i = 0; i < args.length; i += 1) {
        const arg = args[i];
        if (arg === '--') break;
        if (arg.startsWith('--')) {
          const [rawName, inline] = arg.slice(2).split(/=(.*)/s);
          const name = rawName.toLowerCase();
          if (name.length >= 3 && 'config'.startsWith(name)) return UPLOAD_REASON;
          if (name.length >= 2 && ('expand-'.startsWith(name) || name.startsWith('expand-'))) return UPLOAD_REASON;
          if (name.length >= 3 && 'variable'.startsWith(name) && /^%/.test(inline ?? args[i + 1] ?? '')) return UPLOAD_REASON;
        } else if (/^-[A-Za-z]*K/.test(arg)) return UPLOAD_REASON;
      }
    }
  }
  return null;
}
