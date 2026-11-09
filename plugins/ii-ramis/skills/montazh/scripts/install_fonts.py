"""Установка платных шрифтов Афиши (Druk Cyr, Benzin, Denistina) в ~/.ii-ramis/fonts.

Шрифты куплены Рамисом и в плагин НЕ входят. Ученик получает закрытую ссылку на архив в группе курса.

    python3 install_fonts.py <https-ссылка на архив>
    python3 install_fonts.py --file <архив.zip, уже лежит на компьютере>
    python3 install_fonts.py --check          # какие шрифты уже стоят

Скачивание: только https, до 3 МБ, SHA256 архива сверяется с хешем из `references/afisha-fonts.sha256` (хеш в плагине,
адрес ссылки нет). Распаковка: только 4 файла с известными именами, без папок и ссылок. Ничего не запускается."""
import json
import os
import re
import sys
import tempfile
from pathlib import Path

import safefetch

HERE = Path(__file__).resolve().parent
HASH_FILE = HERE.parent / "references" / "afisha-fonts.sha256"
FONT_FILES = ("DrukCyr-Medium.ttf", "DrukCyr-Bold.ttf", "Benzin-Bold.ttf", "Denistina-Regular.ttf")
MAX_ARCHIVE = 3 * 1024 * 1024
MAX_FILE = 1024 * 1024
FONTS_DIR = Path(os.environ.get("II_RAMIS_HOME") or Path.home() / ".ii-ramis") / "fonts"


def pinned_hash():
    text = HASH_FILE.read_text(encoding="utf-8")
    match = re.search(r"\b([0-9a-f]{64})\b", text)
    if not match:
        safefetch.fail("в плагине нет контрольной суммы архива шрифтов")
    return match.group(1)


def installed():
    return {name: (FONTS_DIR / name).is_file() for name in FONT_FILES}


def main():
    args = sys.argv[1:]
    if args == ["--check"]:
        state = installed()
        print(json.dumps({"dir": str(FONTS_DIR), "fonts": state, "all": all(state.values())}, ensure_ascii=False))
        return
    cleanup = None
    if len(args) == 2 and args[0] == "--file":
        archive = Path(args[1]).expanduser()
        if not archive.is_file() or archive.is_symlink():
            safefetch.fail("такого файла нет (или это ссылка на файл)")
        try:
            digest = safefetch.sha256_file(archive, MAX_ARCHIVE)
        except safefetch.FetchError as error:
            safefetch.fail(str(error))
        if digest != pinned_hash():
            safefetch.fail("контрольная сумма не совпала: это не тот архив. Ничего не установлено")
        source = archive
    elif len(args) == 1 and not args[0].startswith("--"):
        cleanup = Path(tempfile.mkdtemp(prefix="afisha-fonts-"))
        source = cleanup / "afisha-fonts.zip"
        try:
            safefetch.download(args[0], str(source), MAX_ARCHIVE, pinned_hash())
        except safefetch.FetchError as error:
            safefetch.fail(str(error))
    else:
        safefetch.fail(__doc__)
    try:
        names = safefetch.extract_allowed(str(source), str(FONTS_DIR), FONT_FILES, MAX_FILE, MAX_FILE * 4)
    except safefetch.FetchError as error:
        safefetch.fail(str(error))
    finally:
        if cleanup:
            for item in cleanup.iterdir():
                item.unlink()
            cleanup.rmdir()
    print("Шрифты Афиши установлены в", FONTS_DIR, ":", ", ".join(names))


if __name__ == "__main__":
    main()
