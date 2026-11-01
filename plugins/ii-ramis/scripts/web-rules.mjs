// Страховка для WebFetch: адрес может быть «письмом наружу» (ключ или кусок файла, зашитый в адрес).
// Обычное чтение документации (длинные, но нормальные адреса, параметры ?page=2&lang=ru) не трогаем.
import { mentionsSecretPath, tokenMentionsShellStartup } from './lib.mjs';

const MAX_URL_LENGTH = 1200;
const MAX_VALUE_LENGTH = 120;
const SECRET_PARAM = /^(?:api[_-]?key|apikey|access[_-]?key|key|token|access[_-]?token|auth|authorization|secret|client[_-]?secret|password|passwd|pwd|session|sid)$/i;
const KEY_SHAPES = [
  /\bsk-[A-Za-z0-9_-]{16,}/, /\bghp_[A-Za-z0-9]{20,}/, /\bgithub_pat_[A-Za-z0-9_]{20,}/, /\bAKIA[0-9A-Z]{12,}/, /\bxox[abprs]-[A-Za-z0-9-]{10,}/,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/, /-----BEGIN [A-Z ]*PRIVATE KEY/, /\bAIza[0-9A-Za-z_-]{30,}/,
];
const BLOB_RUN = /[A-Za-z0-9+/=]{40,}/g;
// Длинная сплошная «каша» из букв и цифр (base64 и т.п.). Хеши коммитов git (40 или 64 hex-символа) в ссылках на GitHub — норма.
function hasBlob(text) {
  return (text.match(BLOB_RUN) || []).some((run) => !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(run));
}
const REASON_PREFIX = 'адрес для WebFetch похож на отправку данных наружу';

function decoded(text) {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

export function checkWebFetch(toolInput) {
  const raw = typeof toolInput.url === 'string' ? toolInput.url.trim() : '';
  if (!raw) return null;
  let url;
  try {
    url = new URL(raw);
  } catch {
    return 'адрес для WebFetch не разобрать';
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return `${REASON_PREFIX}: схема ${url.protocol} не разрешена`;
  if (url.username || url.password) return `${REASON_PREFIX}: в адресе логин или пароль`;
  if (/^169\.254\.|^metadata\.google\.internal$|^fd00:ec2::/i.test(url.hostname)) return `${REASON_PREFIX}: служебный адрес облака (там лежат ключи сервера)`;
  if (raw.length > MAX_URL_LENGTH) return `${REASON_PREFIX}: адрес слишком длинный (${raw.length} символов)`;
  if (url.hostname.split('.').some((label) => hasBlob(label))) return `${REASON_PREFIX}: в имени сайта закодированные данные`;

  const text = decoded(raw);
  if (KEY_SHAPES.some((shape) => shape.test(text))) return `${REASON_PREFIX}: в адресе виден ключ`;
  if (mentionsSecretPath(text.replace(/^https?:\/\/[^/]+/, '')) || tokenMentionsShellStartup(url.pathname)) {
    return `${REASON_PREFIX}: в адресе имя файла с ключами или настройками оболочки`;
  }
  for (const [name, value] of url.searchParams) {
    if (SECRET_PARAM.test(name) && value.length >= 8) return `${REASON_PREFIX}: параметр «${name}» с длинным значением`;
    if (value.length > MAX_VALUE_LENGTH || hasBlob(value)) return `${REASON_PREFIX}: в параметре «${name}» длинный набор символов`;
  }
  if (url.pathname.split('/').some((segment) => hasBlob(decoded(segment)))) return `${REASON_PREFIX}: в пути длинный набор символов`;
  return null;
}
