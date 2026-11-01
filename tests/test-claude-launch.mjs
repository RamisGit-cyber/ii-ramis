// Тест: любой вложенный запуск claude из команды закрыт (consent-rules.isClaudeLaunch), безобидные упоминания слова claude открыты.
import { isClaudeLaunch } from '../plugins/ii-ramis/scripts/consent-rules.mjs';
const bad = ['claude -p hi', 'claude', 'claude --resume', 'claude -c', 'claude --continue', 'claude --session-id 1 -p x', 'FOO=1 claude -p x', 'env claude -p x', 'env -i claude -p x', 'sudo claude',
  'npx claude -p x', 'npx @anthropic-ai/claude-code -p x', 'node /usr/lib/claude -p x', 'bash -c "claude -p hi"', "sh -c 'claude -p hi'", 'tmux new-session claude', 'tmux send-keys "claude" Enter',
  'script -q /dev/null claude -p x', 'expect -c "spawn claude"', 'ls && claude -p x', 'echo x | claude -p', '(claude -p x)', '$(claude -p x)', '/usr/local/bin/claude -p x', '~/.local/bin/claude -p x',
  'claude.exe -p x', 'timeout 5 claude -p x', 'xargs claude', 'bun x claude -p', 'claude-code -p x', 'printf "да 1234" | claude -p', 'C:\\Users\\a\\claude.exe -p x', 'cmd /c claude -p x', 'powershell -Command "claude -p x"'];
const ok = ['claude --version', 'claude -v', 'grep claude README.md', 'ls ~/.claude', 'echo claude', 'cat CLAUDE.md', 'git commit -m "claude helps"', 'npm run dev', 'cd claude-notes && ls',
  'node claude-notes.js', 'python3 script.py', 'ls /Users/x/.claude/projects', 'echo "ask claude later"', 'cat ~/.claude/settings.json'];
let failed = 0;
for (const c of bad) if (!isClaudeLaunch(c)) { failed += 1; console.log('MISS', c); }
for (const c of ok) if (isClaudeLaunch(c)) { failed += 1; console.log('FALSEPOS', c); }
console.log(failed === 0 ? 'LAUNCH-OK' : `LAUNCH-FAIL ${failed}`);
