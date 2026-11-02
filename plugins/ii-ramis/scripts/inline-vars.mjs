// Подготовка команды к проверке: безобидные переменные и подстановки заменяются настоящим текстом, чтобы правила видели итоговый путь.
// Зачем: `name=app; npm create vite@latest $name` и `git commit -m "fix $(date)"` не должны блокироваться как «путь из переменной»,
// а `d=~/.claude; git clone X $d/hooks` должна: после подстановки правила видят `git clone X ~/.claude/hooks`.
// Всё сомнительное остаётся как есть, и действует прежняя строгость (переменная в пути записи = отказ).
//   - присваивания учитываются, только если они в начале строки или после `;`/перевода строки, вне кавычек, значение буквальное;
//   - при if/for/while/heredoc/комментариях/eval/declare/read и т.п. подстановки нет вообще: порядок выполнения там не очевиден;
//   - служебные переменные (PATH, NODE_OPTIONS, GIT_*, HOME и т.д.) не трогаем: их смена меняет поведение программ.

const SPECIAL_NAME = new RegExp(
  '^(?:PATH|IFS|HOME|USERPROFILE|SHELL|PS[1-4]|PROMPT_COMMAND|BASH_ENV|ENV|CDPATH|GLOBIGNORE|OLDPWD|PWD|TMPDIR|TEMP|TMP|EDITOR|VISUAL|PAGER|MANPAGER|BROWSER|' +
  'NODE_(?!ENV$)\\w*|NPM_\\w*|PYTHON(?!UNBUFFERED$|DONTWRITEBYTECODE$)\\w*|LD_\\w*|DYLD_\\w*|GIT_\\w*|CLAUDE\\w*|ANTHROPIC\\w*|AI_AGENT|CURL_\\w*|\\w*proxy|' +
  'XDG_\\w+|RUBY\\w*|PERL\\w*|JAVA\\w*|PIP_\\w+|DOCKER_\\w*|LESS\\w*|SSH_\\w*|AWS_\\w*|SSL_\\w*|OPENSSL\\w*|COMSPEC|PATHEXT|PSModulePath|APPDATA|LOCALAPPDATA|IIRAMIS\\w*|SUDO_\\w*|MAKEFLAGS|CC|CXX|CFLAGS|LDFLAGS)$',
  'i',
);

// Что нельзя вставлять в команду при подстановке: кавычки, #, ; & | < > ( ) $ ` * ? [ ] { } !: они меняют разбор.
const SAFE_VALUE = /^[\p{L}\p{N} _.\-/:~+@,=%]*$/u;
const SAFE_VALUE_PS = /^[\p{L}\p{N} _.\-/\\:~+@,=%]*$/u;

const BAIL_BASH = new RegExp(
  String.raw`<<|(?:^|[\s;&|])#|(?:^|[\s;&|(])(?:if|then|else|elif|fi|for|while|until|case|esac|do|done|function|select|declare|typeset|local|readonly|read|eval|mapfile|readarray|unset|let|getopts|source|trap|set|exec|alias)(?=[\s;|&)]|$)|(?:^|[\s;&|])[{}](?=\s|$)|printf\s+-v|(?:^|[\s;&|])\.\s+\S`,
);
const BAIL_PS = new RegExp(
  String.raw`<#|@['"]|(?:^|[\s;&|])#|(?:^|[\s;&|(])(?:if|else|elseif|for|foreach|while|do|switch|function|filter|param|set-variable|new-variable|set-item|clear-variable|remove-variable|setx|invoke-expression|iex|invoke-command|icm|sv|nv|si|rv|cv|trap)(?=[\s;|&)({]|$)|(?:^|[\s;&|])[{}](?=\s|$)`,
  'i',
);

function quoteStateAt(text, offset, escape) {
  let state = null;
  for (let i = 0; i < offset; i += 1) {
    const ch = text[i];
    if (state === 'single') { if (ch === "'") state = null; continue; }
    if (ch === escape) { i += 1; continue; }
    if (ch === '"') state = state === 'double' ? null : state === null ? 'double' : state;
    else if (ch === "'" && state === null) state = 'single';
  }
  return state;
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function unwrap(rawValue) {
  if (rawValue.startsWith('"') || rawValue.startsWith("'")) return rawValue.slice(1, -1);
  return rawValue;
}

// Известные переменные внутри ЗНАЧЕНИЯ присваивания (d=$HOME/proj): подставляем тем же способом, что и в остальной команде.
function resolveKnownInValue(value, expandKnown) {
  return /\$/.test(value) && typeof expandKnown === 'function' ? expandKnown(value) : value;
}

const BASH_STATEMENT = /(^|[;\n]\s*)(export\s+)?([A-Za-z_]\w*)=("[^"$`\\\n]*"|'[^'\n]*'|[^\s"'`\\;&|()<>*?[\]{}!#]*)(?=\s*(?:;|&&|\n|$))(\s*(?:;|&&)?\s*)/g;
const BASH_PREFIX = /(^|[;\n|]\s*|&&\s*)((?:[A-Za-z_]\w*=(?:"[^"$`\\\n]*"|'[^'\n]*'|[^\s"'$`\\;&|()<>*?[\]{}!#]*)[ \t]+)+)(?=[^\s=;&|])/g;
const PS_STATEMENT = /(^|[;\n]\s*)\$(env:)?([A-Za-z_]\w*)\s*=\s*("[^"$`\n]*"|'[^'\n]*'|[^\s"'$`;&|(){}<>,@#]+)(?=\s*(?:;|\n|$))(\s*;?\s*)/gi;

function assignmentsOf(prefixText) {
  return [...prefixText.matchAll(/([A-Za-z_]\w*)=("[^"\n]*"|'[^'\n]*'|\S*)/g)].map((m) => ({ name: m[1], value: unwrap(m[2]) }));
}

function inlineBash(command, expandKnown) {
  let text = command;
  for (let guard = 0; guard < 20; guard += 1) {
    BASH_STATEMENT.lastIndex = 0;
    let replaced = false;
    for (const match of text.matchAll(BASH_STATEMENT)) {
      const [whole, boundary, , name, rawValue] = match;
      const start = match.index;
      if (quoteStateAt(text, start + boundary.length, '\\') !== null) continue;
      const value = resolveKnownInValue(unwrap(rawValue), expandKnown);
      const browserNone = /^browser$/i.test(name) && value === 'none';
      if ((SPECIAL_NAME.test(name) && !browserNone) || !SAFE_VALUE.test(value)) continue;
      const rest = text.slice(start + whole.length);
      if (new RegExp(String.raw`(?:^|[^\w$])${escapeRegExp(name)}\+?=`).test(rest)) continue; // повторное присваивание: порядок неясен
      const replacedRest = rest
        .replace(new RegExp(String.raw`\$\{${escapeRegExp(name)}\}`, 'g'), () => value)
        .replace(new RegExp(String.raw`\$${escapeRegExp(name)}(?![\w])`, 'g'), () => value);
      text = text.slice(0, start) + boundary + replacedRest;
      replaced = true;
      break;
    }
    if (!replaced) break;
  }
  return text.replace(BASH_PREFIX, (whole, boundary, assignments, offset) => {
    if (quoteStateAt(text, offset + boundary.length, '\\') !== null) return whole;
    const ok = assignmentsOf(assignments).every(({ name, value }) =>
      (!SPECIAL_NAME.test(name) || (/^browser$/i.test(name) && value === 'none')) && SAFE_VALUE.test(value));
    return ok ? boundary : whole;
  });
}

function inlinePowerShell(command, expandKnown) {
  let text = command;
  for (let guard = 0; guard < 20; guard += 1) {
    PS_STATEMENT.lastIndex = 0;
    let replaced = false;
    for (const match of text.matchAll(PS_STATEMENT)) {
      const [whole, boundary, envForm, name, rawValue] = match;
      const start = match.index;
      if (quoteStateAt(text, start + boundary.length, '`') !== null) continue;
      const value = resolveKnownInValue(unwrap(rawValue), expandKnown);
      if (SPECIAL_NAME.test(name) || !SAFE_VALUE_PS.test(value)) continue;
      const rest = text.slice(start + whole.length);
      if (envForm) {
        text = text.slice(0, start) + boundary + rest; // $env:NODE_ENV = "production": переменная окружения для следующих команд
      } else {
        if (new RegExp(String.raw`\$${escapeRegExp(name)}\s*[+\-*/]?=`, 'i').test(rest)) continue;
        const replacedRest = rest
          .replace(new RegExp(String.raw`\$\{${escapeRegExp(name)}\}`, 'gi'), () => value)
          .replace(new RegExp(String.raw`\$${escapeRegExp(name)}(?![\w:])`, 'gi'), () => value);
        text = text.slice(0, start) + boundary + replacedRest;
      }
      replaced = true;
      break;
    }
    if (!replaced) break;
  }
  return text;
}

export function inlineLiteralVariables(command, mode, expandKnown) {
  if (!/=/.test(command)) return command;
  if ((mode === 'ps' ? BAIL_PS : BAIL_BASH).test(command)) return command;
  return mode === 'ps' ? inlinePowerShell(command, expandKnown) : inlineBash(command, expandKnown);
}

// ---- Подстановки, которые печатают только число или слово и не читают файлов: $(date +%F), $(lsof -ti :3000), $(pwd) ----
const SUBSTITUTION_ARGS = {
  date: (args) => /^(?:\s|["']?\+[^\s"'`$()]*(?:\s+[^\s"'`$()+-][^"'`$()]*)?["']?|-u|-R|-I(?:date|seconds|minutes)?)*$/.test(args),
  lsof: (args) => args.trim().split(/\s+/).filter(Boolean).every((a) => /^(?:-[tinP]+(?:TCP)?:?\d*|-sTCP:LISTEN|:?\d+|tcp:\d+)$/.test(a)),
  pgrep: (args) => /^(?:\s|-[fxnoil]+|["']?[\w.:-]+["']?|["'][\w. :-]+["'])*$/.test(args),
};
const BASH_SUBSTITUTION = /\$\(\s*(date|lsof|pgrep)(?![\w-])([^()$`;&|<>\n]*)\)/g;
const BASH_PWD = /\$\(\s*pwd\s*\)/g;
const PS_DATE = /\$\(\s*Get-Date((?:\s+-(?:Format|UFormat)\s+(?:"[\w:%/. -]+"|'[\w:%/. -]+'|[\w:%/.-]+))*)\s*\)/gi;

const PS_DATE_ASSIGNMENT = /(\$[A-Za-z_]\w*\s*=\s*)Get-Date(?:\s+-(?:Format|UFormat)\s+(?:"[\w:%/. -]+"|'[\w:%/. -]+'|[\w:%/.-]+))*(?=\s*(?:;|\n|$))/gi;

export function neutralizeSafeSubstitutions(command, mode, cwd) {
  if (mode === 'ps') return command.replace(PS_DATE, '0').replace(PS_DATE_ASSIGNMENT, '$1"0"');
  let result = command.replace(BASH_SUBSTITUTION, (whole, verb, args) => (SUBSTITUTION_ARGS[verb](args) ? '0' : whole));
  const changesDirectory = /(?:^|[\s;&|(])(?:cd|pushd|popd|set-location|sl|chdir)(?=\s|$)/i.test(command);
  if (!changesDirectory && typeof cwd === 'string' && SAFE_VALUE.test(cwd) && !/\s/.test(cwd)) result = result.replace(BASH_PWD, () => cwd);
  return result;
}
