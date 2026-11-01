// Страница формы ключей и подсказки «где взять». Всё на русском, без внешних файлов и шрифтов.
import { isPublicName } from './key-form-lib.mjs';

const SUPABASE_PATH = 'Supabase → твой проект → Project Settings → API Keys';
const HINTS = {
  NEXT_PUBLIC_SUPABASE_URL: 'Адрес проекта (Project URL), начинается с https://. Его видно по кнопке Connect вверху страницы проекта в Supabase.',
  SUPABASE_URL: 'Адрес проекта (Project URL), начинается с https://. Его видно по кнопке Connect вверху страницы проекта в Supabase.',
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: `Publishable key, начинается с sb_publishable_. Где взять: ${SUPABASE_PATH}, вкладка «Publishable and secret API keys». Этот ключ безопасно использовать на сайте.`,
  NEXT_PUBLIC_SUPABASE_ANON_KEY: `Старое название публичного ключа (anon). Где взять: ${SUPABASE_PATH}, вкладка «Legacy API keys». Если у тебя есть Publishable key, лучше используй его.`,
  SUPABASE_SECRET_KEY: `Secret key, начинается с sb_secret_. Где взять: ${SUPABASE_PATH}, вкладка «Publishable and secret API keys». Секретный: только для серверной части, на сайт не попадает.`,
  SUPABASE_SERVICE_ROLE_KEY: `Старое название секретного ключа (service_role). Где взять: ${SUPABASE_PATH}, вкладка «Legacy API keys». Секретный: только для серверной части.`,
};
const GENERIC_HINT = 'Скопируй значение там, где ты его получил, и вставь сюда.';

export function hintFor(name) {
  return HINTS[name] || GENERIC_HINT;
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
}

function fieldHtml({ name, secret }) {
  const badge = secret
    ? '<span class="badge secret">секретный, только на сервере</span>'
    : (isPublicName(name) ? '<span class="badge">публичный</span>' : '');
  return `<div class="field">
  <label for="f-${name}"><code>${name}</code> ${badge}</label>
  <p class="hint">${escapeHtml(hintFor(name))}</p>
  <div class="row">
    <input id="f-${name}" data-name="${name}" type="password" autocomplete="new-password" data-1p-ignore data-lpignore="true" autocapitalize="off" spellcheck="false" required>
    <button type="button" class="ghost" data-show="f-${name}" aria-pressed="false">показать</button>
  </div>
  <p class="error" id="e-${name}" role="alert"></p>
</div>`;
}

export function renderPage({ title, fields, project, vercel, nonce }) {
  const where = vercel ? 'на этом компьютере и в Vercel' : 'на этом компьютере';
  return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>${escapeHtml(title)}</title>
<style>
:root { --bg: #f6f6f4; --card: #ffffff; --text: #1b1b1a; --muted: #62625e; --line: #d9d9d4; --accent: #3a35c9; --accent-text: #ffffff; --danger: #b3261e; --ok: #1d7a3a; }
@media (prefers-color-scheme: dark) { :root { --bg: #151514; --card: #1f1f1d; --text: #efefec; --muted: #a3a39d; --line: #3a3a36; --accent: #8c89ff; --accent-text: #11110f; --danger: #ff8a80; --ok: #6fd18a; } }
* { box-sizing: border-box; }
body { margin: 0; padding: 24px 16px; background: var(--bg); color: var(--text); font: 16px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width: 560px; margin: 0 auto; background: var(--card); border: 1px solid var(--line); border-radius: 14px; padding: 24px; }
h1 { margin: 0 0 8px; font-size: 22px; }
.lead { margin: 0 0 20px; color: var(--muted); }
.field { margin-bottom: 20px; }
label { display: block; font-weight: 600; margin-bottom: 2px; }
code { font: 14px ui-monospace, Menlo, Consolas, monospace; }
.badge { font-size: 12px; font-weight: 500; color: var(--muted); border: 1px solid var(--line); border-radius: 99px; padding: 1px 8px; margin-left: 6px; }
.badge.secret { color: var(--danger); border-color: var(--danger); }
.hint { margin: 0 0 8px; color: var(--muted); font-size: 14px; }
.row { display: flex; gap: 8px; }
input { flex: 1; min-width: 0; padding: 10px 12px; border: 1px solid var(--line); border-radius: 8px; background: var(--bg); color: var(--text); font: 15px ui-monospace, Menlo, Consolas, monospace; }
input:focus-visible, button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
button { padding: 10px 16px; border-radius: 8px; border: 0; background: var(--accent); color: var(--accent-text); font: 600 16px system-ui, sans-serif; cursor: pointer; }
button.ghost { background: transparent; color: var(--text); border: 1px solid var(--line); font-weight: 500; font-size: 14px; }
button:disabled { opacity: .6; cursor: default; }
.error { margin: 6px 0 0; color: var(--danger); font-size: 14px; min-height: 0; }
.status { margin-top: 16px; font-weight: 600; }
.status.ok { color: var(--ok); }
.status.fail { color: var(--danger); }
.note { margin-top: 16px; color: var(--muted); font-size: 14px; }
</style>
</head>
<body>
<main>
  <h1>${escapeHtml(title)}</h1>
  <p class="lead">Вставь значения в поля ниже. Они сохранятся только ${where}, в чат с Claude не попадут.</p>
  <form id="form" novalidate>
    ${fields.map(fieldHtml).join('\n    ')}
    <button type="submit" id="save">Сохранить</button>
    <p class="status" id="status" role="status"></p>
  </form>
  <p class="note">Проект: ${escapeHtml(project)}. Эта страница работает только на твоём компьютере и закроется сама после сохранения.</p>
</main>
<script nonce="${nonce}">
(function () {
  var token = new URLSearchParams(location.search).get('t') || '';
  history.replaceState(null, '', location.pathname);
  var form = document.getElementById('form');
  var status = document.getElementById('status');
  var save = document.getElementById('save');
  document.querySelectorAll('[data-show]').forEach(function (button) {
    button.addEventListener('click', function () {
      var input = document.getElementById(button.getAttribute('data-show'));
      var show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      button.textContent = show ? 'скрыть' : 'показать';
      button.setAttribute('aria-pressed', String(show));
    });
  });
  function setStatus(text, kind) { status.textContent = text; status.className = 'status ' + (kind || ''); }
  form.addEventListener('submit', function (event) {
    event.preventDefault();
    document.querySelectorAll('.error').forEach(function (node) { node.textContent = ''; });
    var values = {};
    document.querySelectorAll('input[data-name]').forEach(function (input) { values[input.getAttribute('data-name')] = input.value; });
    save.disabled = true;
    setStatus('Сохраняю…', '');
    fetch('/save?t=' + encodeURIComponent(token), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ values: values }) })
      .then(function (response) { return response.json().catch(function () { return { ok: false, message: 'Неожиданный ответ программы.' }; }); })
      .then(function (answer) {
        if (answer.ok) {
          document.querySelectorAll('input[data-name]').forEach(function (input) { input.value = ''; input.disabled = true; });
          setStatus(answer.message || 'Готово. Можно закрыть вкладку и вернуться в Claude.', 'ok');
          return;
        }
        save.disabled = false;
        var errors = answer.errors || {};
        Object.keys(errors).forEach(function (name) {
          var node = document.getElementById('e-' + name);
          if (node) node.textContent = errors[name];
        });
        setStatus(answer.message || 'Исправь отмеченные поля и нажми «Сохранить» ещё раз.', 'fail');
      })
      .catch(function () { save.disabled = false; setStatus('Не получилось связаться с программой. Вернись в Claude и запусти форму заново.', 'fail'); });
  });
})();
</script>
</body>
</html>`;
}
