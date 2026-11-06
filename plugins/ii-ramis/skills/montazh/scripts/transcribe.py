"""Расшифровка речи из видео с таймкодами слов (faster-whisper, всё считается на компьютере ученика).

Запуск: uv run --with faster-whisper==1.2.1 --with av==15.1.0 transcribe.py <папка-проекта> <видео> <куда.json> [--model small|base] [--lang ru]
Видео и результат должны лежать внутри папки проекта; писать по ссылке (symlink) скрипт отказывается.
Модель скачивается один раз с huggingface.co (репозиторий Systran, закреплённая версия), дальше работает без сети.
"""
import json
import os
import sys

from common import inside, media_file, own_output, write_text

os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")
os.environ.setdefault("DO_NOT_TRACK", "1")

MODELS = {
    "small": ("Systran/faster-whisper-small", "536b0662742c02347bc0e980a01041f333bce120"),
    "base": ("Systran/faster-whisper-base", "ebe41f70d5b6dfa9166e2c581c45c9c0cfc57b66"),
}


def parse_args(argv):
    if len(argv) < 4:
        sys.exit("Использование: transcribe.py <папка-проекта> <видео> <выход.json> [--model small|base] [--lang ru]")
    options = {"model": "small", "lang": None}
    for flag in ("--model", "--lang"):
        if flag in argv:
            position = argv.index(flag) + 1
            if position >= len(argv):
                sys.exit(f"После {flag} нужно значение")
            options[flag[2:]] = argv[position]
    if options["lang"] is not None and not options["lang"].isalpha():
        sys.exit("Язык: двухбуквенный код, например ru или en")
    if options["model"] not in MODELS:
        sys.exit("Модель: small (точнее) или base (быстрее)")
    return argv[1], argv[2], argv[3], options


def main():
    project, video, out_path, options = parse_args(sys.argv)
    project = os.path.abspath(project)
    video, out_path = os.path.join(project, video), os.path.join(project, out_path)
    if not inside(project, video) or not os.path.isfile(video):
        sys.exit("Видео должно лежать внутри папки проекта")
    media_file(project, video)  # настоящее видео или звук, а не плейлист под видом .mp4
    if not out_path.endswith(".json") or not inside(os.path.join(project, "_монтаж"), out_path):
        sys.exit("Результат пишется только в .json внутри папки _монтаж проекта")
    own_output(project, out_path)  # не по ссылке и не за пределы проекта
    from faster_whisper import WhisperModel

    repo, revision = MODELS[options["model"]]
    model = WhisperModel(repo, device="cpu", compute_type="int8", revision=revision)
    segments, info = model.transcribe(
        video, language=options["lang"], word_timestamps=True, vad_filter=True, beam_size=5
    )
    words = []
    lines = []
    for segment in segments:
        lines.append(f"[{segment.start:6.2f}-{segment.end:6.2f}] {segment.text.strip()}")
        for word in segment.words or []:
            words.append({"w": word.word.strip(), "s": round(word.start, 2), "e": round(word.end, 2)})
    write_text(project, out_path, json.dumps(
        {"language": info.language, "duration": round(info.duration, 2), "words": words}, ensure_ascii=False, indent=1))
    print(f"Язык: {info.language}, длина: {info.duration:.1f} с, слов: {len(words)}")
    print("\n".join(lines))


if __name__ == "__main__":
    main()
