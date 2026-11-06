"""Расшифровка речи из видео с таймкодами слов (faster-whisper, всё считается на компьютере ученика).

Запуск: uv run --with faster-whisper==1.2.1 --with av==15.1.0 transcribe.py <видео> <куда.json> [--model small|base] [--lang ru]
Модель скачивается один раз с huggingface.co (репозиторий Systran, закреплённая версия), дальше работает без сети.
"""
import json
import os
import sys

os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")
os.environ.setdefault("DO_NOT_TRACK", "1")

MODELS = {
    "small": ("Systran/faster-whisper-small", "536b0662742c02347bc0e980a01041f333bce120"),
    "base": ("Systran/faster-whisper-base", "ebe41f70d5b6dfa9166e2c581c45c9c0cfc57b66"),
}


def parse_args(argv):
    if len(argv) < 3:
        sys.exit("Использование: transcribe.py <видео> <выход.json> [--model small|base] [--lang ru]")
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
    return argv[1], argv[2], options


def main():
    video, out_path, options = parse_args(sys.argv)
    if not os.path.isfile(video):
        sys.exit(f"Нет файла: {video}")
    out_parts = os.path.normpath(os.path.realpath(os.path.dirname(os.path.abspath(out_path)))).split(os.sep)
    if not out_path.endswith(".json") or "_монтаж" not in out_parts:
        sys.exit("Результат пишется только в .json внутри папки _монтаж проекта")
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
    with open(out_path, "w", encoding="utf-8") as handle:
        json.dump(
            {"language": info.language, "duration": round(info.duration, 2), "words": words},
            handle, ensure_ascii=False, indent=1,
        )
    print(f"Язык: {info.language}, длина: {info.duration:.1f} с, слов: {len(words)}")
    print("\n".join(lines))


if __name__ == "__main__":
    main()
