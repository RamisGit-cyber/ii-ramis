// Тесты host-rules.mjs (внутренние адреса для WebFetch). Запуск: node tests/test-agent-context.mjs
// Имя файла историческое: проверка родительских процессов claude убрана в v1.0.3 вместе с согласием «только из терминала».
import { isInternalHost } from '../plugins/ii-ramis/scripts/host-rules.mjs';

let failed = 0;
function expect(label, actual, wanted) {
  const same = JSON.stringify(actual) === JSON.stringify(wanted);
  if (!same) failed += 1;
  console.log(`  ${same ? 'ok  ' : 'FAIL'} ${label}${same ? '' : ` (ждали ${JSON.stringify(wanted)}, получили ${JSON.stringify(actual)})`}`);
}

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
