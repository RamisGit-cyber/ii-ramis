// Тесты agent-context.mjs и host-rules.mjs без запуска настоящих процессов. Запуск: node tests/test-agent-context.mjs
import { agentContext, agentEnvMarker, isAgentProcessName } from '../plugins/ii-ramis/scripts/agent-context.mjs';
import { isInternalHost } from '../plugins/ii-ramis/scripts/host-rules.mjs';

let failed = 0;
function expect(label, actual, wanted) {
  const same = JSON.stringify(actual) === JSON.stringify(wanted);
  if (!same) failed += 1;
  console.log(`  ${same ? 'ok  ' : 'FAIL'} ${label}${same ? '' : ` (ждали ${JSON.stringify(wanted)}, получили ${JSON.stringify(actual)})`}`);
}

const nobody = () => ['/bin/zsh', '/usr/bin/login', '/System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal'];
expect('чистое окружение и родители: человек', agentContext({ PATH: '/bin', HOME: '/h' }, nobody), null);
expect('CLAUDECODE=1: Claude', agentContext({ CLAUDECODE: '1' }, nobody) !== null, true);
expect('CLAUDE_CODE_ENTRYPOINT: Claude', agentContext({ CLAUDE_CODE_ENTRYPOINT: 'cli' }, nobody) !== null, true);
expect('любая CLAUDE_CODE_*: Claude', agentContext({ CLAUDE_CODE_SESSION_ID: 'x' }, nobody) !== null, true);
expect('AI_AGENT: Claude', agentContext({ AI_AGENT: 'claude-code_2' }, nobody) !== null, true);
expect('пустая переменная не считается', agentEnvMarker({ CLAUDECODE: '' }), null);
expect('CLAUDE_CONFIG_DIR сам по себе не признак', agentEnvMarker({ CLAUDE_CONFIG_DIR: '/c' }), null);
expect('CLAUDE_PLUGIN_ROOT не признак', agentEnvMarker({ CLAUDE_PLUGIN_ROOT: '/p' }), null);
expect('env стёрт, но предок claude: Claude', agentContext({}, () => ['/bin/bash', '/Users/x/Library/Application Support/Claude/claude-code/2.1.0/claude']) !== null, true);
expect('предок Claude.app: Claude', agentContext({}, () => ['/bin/zsh', '/Applications/Claude.app/Contents/Helpers/disclaimer']) !== null, true);
expect('предок claude.exe (Windows)', agentContext({}, () => ['pwsh.exe', 'claude.exe']) !== null, true);
expect('предок Claude Helper', agentContext({}, () => ['bash', 'Claude Helper (Renderer)']) !== null, true);
expect('ошибка чтения предков: считаем агентом (fail closed)', agentContext({}, () => { throw new Error('ps не нашёлся'); }) !== null, true);
expect('таймаут чтения предков: считаем агентом', agentContext({}, () => { const e = new Error('spawnSync ETIMEDOUT'); e.code = 'ETIMEDOUT'; throw e; }) !== null, true);
expect('пустая цепочка (сирота, родитель init): человек', agentContext({}, () => []), null);
expect('claude-notes не считается', isAgentProcessName('/usr/bin/claude-notes'), false);
expect('Terminal не считается', isAgentProcessName('/System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal'), false);
expect('iTerm2 не считается', isAgentProcessName('/Applications/iTerm.app/Contents/MacOS/iTerm2'), false);

console.log('== host-rules: внутренние адреса ==');
const blocked = [
  '127.0.0.1', '2130706433', '0x7f.1', '0177.0.0.1', '127.1', '017700000001', '0x7f000001', '0', '0.0.0.0', '10.1.2.3',
  '172.16.0.1', '172.31.255.255', '192.168.0.1', '169.254.169.254', '100.100.100.200',
  '[::1]', '[0:0:0:0:0:0:0:1]', '[::]', '[::ffff:127.0.0.1]', '[::ffff:7f00:1]', '[::ffff:169.254.169.254]', '[::ffff:a00:1]',
  '[fe80::1]', '[febf::1]', '[fc00::1]', '[fd00:ec2::254]', '[64:ff9b::7f00:1]', '[2002:7f00:1::]', '[::ffff:8.8.8.8]', '198.18.0.1', '198.19.255.255', '[64:ff9b:1::1]', '[64:ff9b:1:ffff::1]',
  'localhost', 'localhost.', 'LOCALHOST', 'a.localhost', 'metadata.google.internal', 'metadata.google.internal.', '127.0.0.1.nip.io', '%31%32%37.0.0.1', '127。0。0。1',
];
for (const host of blocked) {
  let name;
  try { name = new URL(`http://${host}/`).hostname; } catch { name = host; }
  expect(`закрыт: ${host}`, isInternalHost(name), true);
}
for (const host of ['example.com', 'github.com', '8.8.8.8', '172.15.0.1', '172.32.0.1', '192.169.0.1', '[2606:4700::1111]', '11.0.0.1', '100.63.0.1', '198.17.0.1', '198.20.0.1']) {
  expect(`открыт: ${host}`, isInternalHost(new URL(`http://${host}/`).hostname), false);
}

console.log(failed === 0 ? 'AGENT-CONTEXT-OK' : `AGENT-CONTEXT-FAIL: ${failed}`);
process.exit(failed === 0 ? 0 : 1);
