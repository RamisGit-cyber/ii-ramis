"""Общие мелочи для montage.py и critic.py: поиск ffmpeg, безопасные пути, зоны Instagram."""
import json
import os
import shutil
import subprocess
import sys

W, H = 1080, 1920
# Безопасная зона Instagram Reels (1080x1920): верх, низ и правая колонка кнопок заняты интерфейсом.
SAFE = {"top": 220, "bottom": H - 420, "left": 90, "right": W - 140}


def need(tool):
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


def run(args, cwd=None, capture=False):
    result = subprocess.run(
        args, cwd=cwd, stdout=subprocess.PIPE if capture else None,
        stderr=subprocess.PIPE if capture else None,
    )
    return result


def ffmpeg_ok(args, cwd=None):
    result = run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", *args], cwd=cwd, capture=True)
    if result.returncode != 0:
        sys.exit(f"ffmpeg не справился (код {result.returncode}):\n" + result.stderr.decode("utf-8", "replace")[-1500:])


def ffmpeg_text(args, cwd=None):
    """Запуск ffmpeg, из которого нужен текст отчёта (stderr)."""
    result = run(["ffmpeg", "-hide_banner", "-nostats", *args], cwd=cwd, capture=True)
    return result.stderr.decode("utf-8", "replace")


def probe(path):
    out = run(
        ["ffprobe", "-v", "error", "-show_streams", "-show_format", "-of", "json", path], capture=True
    )
    if out.returncode != 0:
        sys.exit(f"Не могу прочитать видео: {path}")
    return json.loads(out.stdout.decode("utf-8", "replace"))


def load_json(path):
    with open(path, encoding="utf-8") as handle:
        return json.load(handle)
