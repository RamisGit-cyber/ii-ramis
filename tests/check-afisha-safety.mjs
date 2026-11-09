// Безопасность загрузки шрифтов и модели Афиши (2.8.0): только https, без цифровых адресов, сверка SHA256,
// распаковка без выхода из папки, лишние файлы и ссылки отказывают. Сеть не нужна. Нужен python3.
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync, readFileSync, realpathSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const scripts = join(root, 'plugins', 'ii-ramis', 'skills', 'montazh', 'scripts');
const failures = [];
const check = (ok, message) => { if (!ok) failures.push(message); };
if (spawnSync('python3', ['-I', '-c', 'print(1)']).status !== 0) { console.log('SKIP: нет python3'); process.exit(0); }

const base = mkdtempSync(join(tmpdir(), 'afisha-safety-'));
const py = (code, env = {}) => spawnSync('python3', ['-c', `import sys; sys.path.insert(0, ${JSON.stringify(scripts)})\n${code}`],
  { encoding: 'utf8', env: { ...process.env, ...env } });

try {
  // 1. Адреса: только https, без логина, без цифр, без localhost, без нестандартного порта
  const bad = ['http://example.com/a.zip', 'ftp://example.com/a.zip', 'file:///etc/hosts', 'https://user:pw@example.com/a.zip',
    'https://127.0.0.1/a.zip', 'https://[::1]/a.zip', 'https://192.168.1.5/a.zip', 'https://localhost/a.zip', 'https://printer.local/a.zip',
    'https://example.com:8443/a.zip', 'https://169.254.169.254/latest', 'https://2130706433/a.zip', 'https://0x7f.1/a.zip', 'https://017700000001/a.zip', 'https://127.1/a.zip',
    'https://localhost./a.zip', 'https://foo.local./a.zip', 'https://x.internal./a.zip', 'https://metadata.google.internal./a.zip', 'https://intranet/a.zip'];
  for (const url of bad) {
    const r = py(`import safefetch\ntry:\n    safefetch.check_url(${JSON.stringify(url)})\n    print('OK')\nexcept safefetch.FetchError:\n    print('REFUSED')`);
    check(r.stdout.trim() === 'REFUSED', `check_url должен отказать: ${url} (${r.stdout}${r.stderr})`);
  }
  const good = py(`import safefetch\nprint(safefetch.check_url('https://github.com/a/b/releases/download/v1/x.onnx'))`);
  check(good.stdout.includes('https://github.com'), `check_url должен пропускать обычный https: ${good.stderr}`);

  // 2. Распаковка: собираем «злые» архивы
  const make = `
import zipfile, os, stat, sys
names = ('DrukCyr-Medium.ttf', 'DrukCyr-Bold.ttf', 'Benzin-Bold.ttf', 'Denistina-Regular.ttf')
def zip_with(path, entries, symlink=None):
    with zipfile.ZipFile(path, 'w') as z:
        for name, data in entries:
            z.writestr(name, data)
        if symlink:
            info = zipfile.ZipInfo(symlink[0]); info.external_attr = (stat.S_IFLNK | 0o777) << 16
            z.writestr(info, symlink[1])
good = [(n, b'x' * 10) for n in names]
zip_with(${JSON.stringify(join(base, 'good.zip'))}, good)
zip_with(${JSON.stringify(join(base, 'extra.zip'))}, good + [('evil.sh', b'rm -rf /')])
zip_with(${JSON.stringify(join(base, 'traversal.zip'))}, good + [('../../evil.ttf', b'x')])
zip_with(${JSON.stringify(join(base, 'subdir.zip'))}, [('fonts/' + n, b'x') for n in names])
zip_with(${JSON.stringify(join(base, 'missing.zip'))}, good[:3])
zip_with(${JSON.stringify(join(base, 'link.zip'))}, good[:3], symlink=('DrukCyr-Medium.ttf', '/etc/hosts'))
zip_with(${JSON.stringify(join(base, 'big.zip'))}, [(n, b'x' * 2_000_000) for n in names])
open(${JSON.stringify(join(base, 'notzip.zip'))}, 'wb').write(b'not a zip')
`;
  check(py(make).status === 0, 'тест: не собрались тестовые архивы');
  const run = (name) => {
    const out = join(base, `out-${name}`);
    const r = py(`import safefetch\nnames = ('DrukCyr-Medium.ttf','DrukCyr-Bold.ttf','Benzin-Bold.ttf','Denistina-Regular.ttf')\ntry:\n    safefetch.extract_allowed(${JSON.stringify(join(base, `${name}.zip`))}, ${JSON.stringify(out)}, names, 1024*1024, 4*1024*1024)\n    print('OK')\nexcept safefetch.FetchError as e:\n    print('REFUSED')`);
    return { verdict: r.stdout.trim(), out, err: r.stderr };
  };
  const ok = run('good');
  check(ok.verdict === 'OK' && readdirSync(ok.out).length === 4, `good.zip должен распаковаться: ${ok.verdict}${ok.err}`);
  for (const name of ['extra', 'traversal', 'subdir', 'missing', 'link', 'big', 'notzip']) {
    const r = run(name);
    check(r.verdict === 'REFUSED', `${name}.zip должен быть отказан, а вышло: ${r.verdict}${r.err}`);
    check(!existsSync(join(base, 'evil.ttf')) && !existsSync(join(base, '..', 'evil.ttf')), `${name}.zip: файл не должен выйти за папку`);
    if (existsSync(r.out)) check(readdirSync(r.out).length === 0, `${name}.zip: при отказе в папку ничего не должно попасть`);
  }

  // 3. install_fonts.py --file: хеш не совпал, значит ничего не ставится (HOME подменён, чужие шрифты не трогаем)
  const home = join(base, 'home');
  mkdirSync(home);
  const wrong = spawnSync('python3', [join(scripts, 'install_fonts.py'), '--file', join(base, 'good.zip')],
    { encoding: 'utf8', env: { ...process.env, II_RAMIS_HOME: home } });
  check(wrong.status !== 0 && !existsSync(join(home, 'fonts')), `install_fonts.py: архив с чужим хешем не должен ставиться: ${wrong.stdout}${wrong.stderr}`);
  const http = spawnSync('python3', [join(scripts, 'install_fonts.py'), 'http://example.com/a.zip'], { encoding: 'utf8', env: { ...process.env, II_RAMIS_HOME: home } });
  check(http.status !== 0 && !existsSync(join(home, 'fonts')), 'install_fonts.py: http-ссылка должна отказывать');
  const status = spawnSync('python3', [join(scripts, 'install_fonts.py'), '--check'], { encoding: 'utf8', env: { ...process.env, II_RAMIS_HOME: home } });
  check(status.status === 0 && status.stdout.includes('"all": false'), 'install_fonts.py --check: без шрифтов должно быть all=false');

  // 4. HyperFrames (npx) запускается не из папки проекта ученика, а из пустой временной, с официальным реестром и пустыми настройками npm
  const project = join(base, 'student-project');
  const layer = join(project, 'afisha-hf', 'behind');
  mkdirSync(layer, { recursive: true });
  writeFileSync(join(project, 'package.json'), '{"name":"evil"}');
  const fakeBin = join(base, 'fakebin');
  mkdirSync(fakeBin);
  const record = join(base, 'npx-record.txt');
  const fakeNpx = join(fakeBin, 'npx');
  writeFileSync(fakeNpx, `#!/usr/bin/env bash
{ echo "CWD=$(pwd -P)"; echo "ARGS=$*"; echo "REG=$NPM_CONFIG_REGISTRY"; echo "USERCFG=$NPM_CONFIG_USERCONFIG"; echo "GLOBALCFG=$NPM_CONFIG_GLOBALCONFIG"; echo "TEL=$HYPERFRAMES_NO_TELEMETRY$DO_NOT_TRACK"; echo "EVIL=$NPM_CONFIG_EVIL"; echo "USERCFG_SIZE=$(wc -c < "$NPM_CONFIG_USERCONFIG" | tr -d ' ')"; } > "${record}"
while [ $# -gt 0 ]; do [ "$1" = "-o" ] && { mkdir -p "$2" && touch "$2/frame_000001.png"; }; shift; done
`);
  chmodSync(fakeNpx, 0o755);
  const render = py(`import afisha_hf\nfrom pathlib import Path\nafisha_hf.render_layer(Path(${JSON.stringify(layer)}), Path(${JSON.stringify(join(project, 'afisha-hf', 'run-1', 'behind-frames'))}), print)\nprint('RENDERED')`,
    { PATH: `${fakeBin}:${process.env.PATH}`, NPM_CONFIG_EVIL: 'x', NPM_CONFIG_REGISTRY: 'https://evil.example/' });
  check(render.stdout.includes('RENDERED'), `render_layer с поддельным npx: ${render.stdout}${render.stderr}`);
  const seen = existsSync(record) ? readFileSync(record, 'utf8') : '';
  const field = (name) => (seen.match(new RegExp(`^${name}=(.*)$`, 'm')) ?? [])[1] ?? '';
  check(field('CWD') !== '' && !field('CWD').startsWith(realpathSync(project)) && !field('CWD').startsWith(project), `npx должен запускаться вне папки проекта, а запустился в ${field('CWD')}`);
  check(field('REG') === 'https://registry.npmjs.org/' && field('EVIL') === '', `npx: реестр официальный, чужие NPM_CONFIG_* вычищены: ${seen}`);
  check(field('USERCFG') !== '' && field('USERCFG') === field('GLOBALCFG') && field('USERCFG_SIZE') === '0', `npx: пользовательские и системные настройки npm пустые: ${seen}`);
  check(field('TEL') === '11', `npx: статистика HyperFrames выключена (HYPERFRAMES_NO_TELEMETRY, DO_NOT_TRACK): ${seen}`);
  check(new RegExp(`ARGS=--yes hyperframes@0\\.9\\.19 render ${layer.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} `).test(seen), `npx: версия закреплена, путь к слою абсолютный: ${seen}`);
} finally {
  rmSync(base, { recursive: true, force: true });
}

if (failures.length) { console.error(failures.map((f) => `ПРОВАЛ: ${f}`).join('\n')); process.exit(1); }
console.log('OK: загрузка и распаковка шрифтов и модели Афиши безопасны');
