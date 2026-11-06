"""Общие мелочи для montage.py и critic.py: поиск ffmpeg, безопасные пути, зоны Instagram."""
import json
import math
import os
import shutil
import subprocess
import sys

W, H = 1080, 1920
# Безопасная зона Instagram Reels (1080x1920): верх, низ и правая колонка кнопок заняты интерфейсом.
SAFE = {"top": 220, "bottom": H - 420, "left": 90, "right": W - 140}


# Homebrew-ffmpeg без libass не рисует субтитры (нет фильтров ass/subtitles). Полная сборка лежит отдельно (formula ffmpeg-full).
FULL_FFMPEG_DIRS = ["/opt/homebrew/opt/ffmpeg-full/bin", "/usr/local/opt/ffmpeg-full/bin"]


def has_subtitle_filter(ffmpeg_path):
    try:
        out = subprocess.run([ffmpeg_path, "-hide_banner", "-filters"], stdout=subprocess.PIPE,
                             stderr=subprocess.DEVNULL, timeout=20).stdout.decode("utf-8", "replace")
    except (OSError, subprocess.SubprocessError):
        return False
    return " ass " in out or " subtitles " in out


def prefer_full_ffmpeg():
    """Если ffmpeg из PATH без фильтра субтитров, а рядом стоит ffmpeg-full, ставим его впереди PATH для этого запуска."""
    current = shutil.which("ffmpeg")
    if current and has_subtitle_filter(current):
        return
    for folder in FULL_FFMPEG_DIRS:
        candidate = os.path.join(folder, "ffmpeg")
        # только настоящий бинарь внутри Cellar Homebrew (не подложенная ссылка в другое место)
        if os.path.isfile(candidate) and "/Cellar/ffmpeg-full/" in os.path.realpath(candidate) and has_subtitle_filter(candidate):
            os.environ["PATH"] = folder + os.pathsep + os.environ.get("PATH", "")
            return
    if current:
        sys.exit("ffmpeg есть, но без фильтра субтитров (ass), без него субтитры не нарисуются. "
                 "Mac: brew install ffmpeg-full, потом brew unlink ffmpeg и brew link --force ffmpeg-full. "
                 "Windows: winget install --id Gyan.FFmpeg -e (см. references/ustanovka.md).")


def need(tool):
    if tool == "ffmpeg":
        prefer_full_ffmpeg()
    path = shutil.which(tool)
    if not path:
        sys.exit(f"Не найден {tool}. Сначала нужно поставить ffmpeg (см. references/ustanovka.md).")
    return path


def inside(project, path):
    """Путь должен лежать внутри папки проекта (после раскрытия ссылок и ..)."""
    project_real = os.path.realpath(project)
    path_real = os.path.realpath(path)
    return os.path.commonpath([project_real, path_real]) == project_real


def project_path(project, relative, must_exist=True):
    full = os.path.join(project, relative)
    if not inside(project, full):
        sys.exit(f"Путь выходит за папку проекта, так нельзя: {relative}")
    if must_exist and not os.path.isfile(full):
        sys.exit(f"Нет файла: {relative}")
    return full


ALLOWED_FORMATS = {"mov", "mp4", "m4a", "3gp", "3g2", "mj2", "matroska", "webm", "mp3", "wav", "ogg", "flac",
                   "image2", "png_pipe", "jpeg_pipe", "webp_pipe", "aac"}


def guarded(args):
    """Перед каждым входным файлом разрешаем только обычные файлы: плейлисты и сетевые адреса внутри файла не откроются."""
    result = []
    for item in args:
        if item == "-i":
            result += ["-protocol_whitelist", "file,pipe"]
        result.append(item)
    return result


def number(value, low, high, name):
    """Число из плана: конечное и в разумных пределах."""
    try:
        value = float(value)
    except (TypeError, ValueError):
        sys.exit(f"В плане {name} должно быть числом, а не {value!r}")
    if not math.isfinite(value) or not low <= value <= high:
        sys.exit(f"В плане {name} должно быть от {low} до {high}")
    return value


def clean_face(face):
    """Рамка лица из плана: четыре числа в пределах кадра (иначе отказ)."""
    if not face:
        return None
    return {"x": number(face.get("x"), 0, W, "face.x"), "y": number(face.get("y"), 0, H, "face.y"),
            "w": number(face.get("w"), 10, W, "face.w"), "h": number(face.get("h"), 10, H, "face.h")}


def limit_count(items, maximum, name):
    if len(items or []) > maximum:
        sys.exit(f"В плане слишком много элементов {name}: не больше {maximum}")


def media_file(project, relative):
    """Файл внутри проекта, настоящее медиа (не плейлист и не текст, переименованный в .mp4)."""
    full = project_path(project, relative)
    info = probe(full)
    names = set(info.get("format", {}).get("format_name", "").split(","))
    if not names & ALLOWED_FORMATS:
        sys.exit(f"Это не видео, не звук и не картинка: {relative}")
    return full


def own_output(project, path):
    """Куда пишем: внутри проекта и не по ссылке (symlink), иначе запись ушла бы наружу."""
    if os.path.islink(path) or not inside(project, path):
        sys.exit(f"Не пишу сюда, путь ведёт за пределы проекта: {os.path.relpath(path, project)}")
    return path


def write_bytes(project, path, data):
    """Запись файла только внутри проекта и никогда по ссылке: O_NOFOLLOW не даёт открыть symlink."""
    own_output(project, path)
    flags = os.O_WRONLY | os.O_CREAT | os.O_TRUNC | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_BINARY", 0)
    try:
        descriptor = os.open(path, flags, 0o644)
    except OSError as error:
        sys.exit(f"Не могу записать {os.path.relpath(path, project)}: {error.strerror}")
    with os.fdopen(descriptor, "wb") as handle:
        handle.write(data)


def write_text(project, path, text):
    write_bytes(project, path, text.encode("utf-8"))


def require_no_links(project, folder):
    """Папка, куда ffmpeg будет писать файлы: самой папки-ссылки и ссылок внутри быть не должно."""
    own_output(project, folder)
    for root, dirs, files in os.walk(folder):
        for name in dirs + files:
            if os.path.islink(os.path.join(root, name)):
                sys.exit(f"В рабочей папке лежит ссылка, не пишу туда: {os.path.relpath(os.path.join(root, name), project)}")


def copy_fonts(project, source_dir, target_dir):
    """Шрифты копируются по одному, каждый файл проверяется отдельно."""
    own_output(project, target_dir)
    os.makedirs(target_dir, exist_ok=True)
    for name in sorted(os.listdir(source_dir)):
        source = os.path.join(source_dir, name)
        if os.path.isfile(source) and not os.path.islink(source):
            with open(source, "rb") as handle:
                write_bytes(project, os.path.join(target_dir, name), handle.read())


def run(args, cwd=None, capture=False):
    result = subprocess.run(
        args, cwd=cwd, stdout=subprocess.PIPE if capture else None,
        stderr=subprocess.PIPE if capture else None,
    )
    return result


def ffmpeg_ok(args, cwd=None):
    result = run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", *guarded(args)], cwd=cwd, capture=True)
    if result.returncode != 0:
        sys.exit(f"ffmpeg не справился (код {result.returncode}):\n" + result.stderr.decode("utf-8", "replace")[-1500:])


def ffmpeg_text(args, cwd=None):
    """Запуск ffmpeg, из которого нужен текст отчёта (stderr)."""
    result = run(["ffmpeg", "-hide_banner", "-nostats", *guarded(args)], cwd=cwd, capture=True)
    return result.stderr.decode("utf-8", "replace")


def probe(path):
    out = run(
        ["ffprobe", "-v", "error", "-protocol_whitelist", "file,pipe", "-show_streams", "-show_format",
         "-of", "json", path], capture=True
    )
    if out.returncode != 0:
        sys.exit(f"Не могу прочитать видео: {path}")
    return json.loads(out.stdout.decode("utf-8", "replace"))


def load_json(path):
    with open(path, encoding="utf-8") as handle:
        return json.load(handle)
