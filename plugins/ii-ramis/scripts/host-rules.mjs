// Проверка имени хоста для WebFetch: внутренние адреса (этого компьютера, домашней сети, облачные метаданные) закрыты.
// Хост разбираем как число, а не по тексту: 2130706433, 0x7f.1, 0177.0.0.1, [::ffff:127.0.0.1] — всё это 127.0.0.1.
// Десятичные, шестнадцатеричные и восьмеричные формы IPv4 приводит к обычному виду сам разбор адреса (new URL).

const BLOCKED_NAMES = new Set(['localhost', 'localhost.localdomain', 'ip6-localhost', 'ip6-loopback', 'metadata.google.internal', 'metadata', 'instance-data']);
const BLOCKED_SUFFIXES = ['.localhost', '.internal', '.local', '.nip.io', '.sslip.io', '.xip.io', '.localtest.me', '.lvh.me', '.vcap.me'];
const BLOCKED_EXACT_SUFFIX_ROOTS = new Set(['nip.io', 'sslip.io', 'xip.io', 'localtest.me', 'lvh.me', 'vcap.me']);

function parseIPv4(text) {
  const match = text.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!match) return null;
  const parts = match.slice(1).map(Number);
  return parts.every((n) => n <= 255) ? parts : null;
}

// Возвращает 8 чисел по 16 бит или null. Понимает «::», а также IPv4 в хвосте (::ffff:1.2.3.4).
function parseIPv6(text) {
  let source = text;
  const tail = source.match(/(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (tail) {
    const v4 = parseIPv4(tail[1]);
    if (!v4) return null;
    source = `${source.slice(0, -tail[1].length)}${((v4[0] << 8) | v4[1]).toString(16)}:${((v4[2] << 8) | v4[3]).toString(16)}`;
  }
  const halves = source.split('::');
  if (halves.length > 2) return null;
  const toGroups = (part) => (part === '' ? [] : part.split(':'));
  const head = toGroups(halves[0]);
  const rest = halves.length === 2 ? toGroups(halves[1]) : [];
  const missing = 8 - head.length - rest.length;
  if (halves.length === 1 ? head.length !== 8 : missing < 1) return null;
  const groups = [...head, ...Array(halves.length === 2 ? missing : 0).fill('0'), ...rest];
  if (groups.length !== 8 || !groups.every((g) => /^[0-9a-f]{1,4}$/i.test(g))) return null;
  return groups.map((g) => parseInt(g, 16));
}

function isPrivateIPv4([a, b]) {
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
}

function embeddedIPv4(high, low) {
  return [high >> 8, high & 255, low >> 8, low & 255];
}

function isPrivateIPv6(groups) {
  const [g0, g1, g2, g3, g4, g5, g6, g7] = groups;
  if (groups.every((g) => g === 0)) return true; // ::
  if (groups.slice(0, 7).every((g) => g === 0) && g7 === 1) return true; // ::1
  if ((g0 & 0xffc0) === 0xfe80) return true; // fe80::/10
  if ((g0 & 0xfe00) === 0xfc00) return true; // fc00::/7, в том числе fd00:ec2::254 (метаданные AWS)
  if (g0 === 0xff00 || (g0 & 0xff00) === 0xff00) return true; // multicast
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0xffff) return true; // ::ffff:0:0/96 целиком: IPv4-mapped, любой адрес
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) return isPrivateIPv4(embeddedIPv4(g6, g7)); // ::a.b.c.d
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 1) return true; // 64:ff9b:1::/48 (локальный NAT64)
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) return isPrivateIPv4(embeddedIPv4(g6, g7)); // NAT64
  if (g0 === 0x2002) return isPrivateIPv4(embeddedIPv4(g1, g2)); // 6to4
  if (g0 === 0x2001 && g1 === 0) return true; // Teredo: адрес внутри закодирован, считаем закрытым
  return false;
}

// hostname — то, что вернул new URL(...).hostname. Возвращает true, если адрес внутренний.
export function isInternalHost(hostname) {
  let host = String(hostname).toLowerCase().trim();
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  host = host.replace(/%.*$/, ''); // зона IPv6 (fe80::1%eth0)
  host = host.replace(/\.+$/, ''); // «localhost.» с точкой на конце
  if (host === '') return true;
  if (host.includes(':')) {
    const groups = parseIPv6(host);
    return groups === null ? true : isPrivateIPv6(groups); // не разобрали IPv6 — не пускаем
  }
  const v4 = parseIPv4(host);
  if (v4) return isPrivateIPv4(v4);
  // Если WHATWG-разбор оставил числовой вид (всё из цифр и точек), а не IPv4, это странная запись: не пускаем.
  if (/^[0-9.]+$/.test(host) || /^0x[0-9a-f.]+$/i.test(host)) return true;
  if (BLOCKED_NAMES.has(host)) return true;
  if (BLOCKED_EXACT_SUFFIX_ROOTS.has(host)) return true;
  return BLOCKED_SUFFIXES.some((suffix) => host.endsWith(suffix));
}
