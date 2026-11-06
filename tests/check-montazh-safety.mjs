// Безопасность скриптов монтажа: запись по ссылкам (symlink) и за пределы проекта отказывает. Нужен python3, ffmpeg не нужен.
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const scripts = join(root, 'plugins', 'ii-ramis', 'skills', 'montazh', 'scripts');
const failures = [];
const check = (ok, message) => { if (!ok) failures.push(message); };
const python = spawnSync('python3', ['-I', '-c', 'print(1)']);
if (python.status !== 0) { console.log('SKIP: нет python3'); process.exit(0); }

const base = mkdtempSync(join(tmpdir(), 'montazh-safety-'));
const outside = join(base, 'outside');
mkdirSync(outside);
const project = join(base, 'project');
mkdirSync(join(project, '_монтаж', 'r'), { recursive: true });
mkdirSync(join(project, 'исходники'));
writeFileSync(join(project, 'исходники', 'v.mp4'), 'not a real video');
const py = (code) => spawnSync('python3', ['-c', `import sys; sys.path.insert(0, ${JSON.stringify(scripts)})\n${code}`], { encoding: 'utf8' });

try {
  // 1. transcribe.py: результат по ссылке и за пределы проекта
  const victim = join(outside, 'victim.json');
  writeFileSync(victim, 'ORIGINAL');
  symlinkSync(victim, join(project, '_монтаж', 'r', 'transcript.json'));
  const link = spawnSync('python3', [join(scripts, 'transcribe.py'), project, 'исходники/v.mp4', '_монтаж/r/transcript.json'], { encoding: 'utf8' });
  check(link.status !== 0 && readFileSync(victim, 'utf8') === 'ORIGINAL', `transcribe.py: запись по symlink должна отказывать: ${link.stderr}`);
  const away = spawnSync('python3', [join(scripts, 'transcribe.py'), project, 'исходники/v.mp4', join(outside, 'x.json')], { encoding: 'utf8' });
  check(away.status !== 0 && !existsSync(join(outside, 'x.json')), 'transcribe.py: результат вне проекта должен отказывать');
  const wrongFolder = spawnSync('python3', [join(scripts, 'transcribe.py'), project, 'исходники/v.mp4', 'исходники/x.json'], { encoding: 'utf8' });
  check(wrongFolder.status !== 0 && !existsSync(join(project, 'исходники', 'x.json')), 'transcribe.py: писать можно только в _монтаж');
  const videoAway = spawnSync('python3', [join(scripts, 'transcribe.py'), project, '/etc/hostname', '_монтаж/r/new.json'], { encoding: 'utf8' });
  check(videoAway.status !== 0, 'transcribe.py: видео вне проекта должно отказывать');

  // 2. critic.py: ссылка внутри папки кадров
  const frames = join(project, '_монтаж', 'r', 'кадры');
  mkdirSync(frames);
  symlinkSync(victim, join(frames, 'кадр_01.png'));
  const framesCheck = py(`from common import require_no_links\nrequire_no_links(${JSON.stringify(project)}, ${JSON.stringify(frames)})`);
  check(framesCheck.status !== 0 && /ссылка/.test(framesCheck.stderr), `critic: ссылка в папке кадров должна отказывать: ${framesCheck.stderr}`);
  const okFolder = join(project, '_монтаж', 'r', 'чистая');
  mkdirSync(okFolder);
  check(py(`from common import require_no_links\nrequire_no_links(${JSON.stringify(project)}, ${JSON.stringify(okFolder)})`).status === 0, 'critic: чистая папка должна проходить');
  const linkedDir = join(project, '_монтаж', 'r', 'кадры2');
  symlinkSync(outside, linkedDir);
  check(py(`from common import require_no_links\nrequire_no_links(${JSON.stringify(project)}, ${JSON.stringify(linkedDir)})`).status !== 0, 'critic: сама папка-ссылка должна отказывать');

  // 3. шрифты и запись файлов: ссылка вместо шрифта и запись O_NOFOLLOW
  const fontsDir = join(project, '_монтаж', 'r', 'fonts');
  mkdirSync(fontsDir);
  const fontsSrc = join(root, 'plugins', 'ii-ramis', 'skills', 'montazh', 'fonts');
  symlinkSync(victim, join(fontsDir, 'Onest-Regular.ttf'));
  const fonts = py(`from common import copy_fonts\ncopy_fonts(${JSON.stringify(project)}, ${JSON.stringify(fontsSrc)}, ${JSON.stringify(fontsDir)})`);
  check(fonts.status !== 0 && readFileSync(victim, 'utf8') === 'ORIGINAL', `шрифты: запись поверх symlink должна отказывать: ${fonts.stderr}`);
  const text = py(`from common import write_text\nwrite_text(${JSON.stringify(project)}, ${JSON.stringify(join(project, '_монтаж', 'r', 'transcript.json'))}, 'X')`);
  check(text.status !== 0 && readFileSync(victim, 'utf8') === 'ORIGINAL', 'write_text: запись по symlink должна отказывать');
  const good = join(project, '_монтаж', 'r', 'ok.txt');
  check(py(`from common import write_text\nwrite_text(${JSON.stringify(project)}, ${JSON.stringify(good)}, 'ok')`).status === 0 && readFileSync(good, 'utf8') === 'ok', 'write_text: обычная запись внутри проекта должна работать');
} finally {
  rmSync(base, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error(failures.map((line) => `FAIL: ${line}`).join('\n'));
  process.exit(1);
}
console.log('OK: скрипты монтажа не пишут по ссылкам и за пределы проекта');
