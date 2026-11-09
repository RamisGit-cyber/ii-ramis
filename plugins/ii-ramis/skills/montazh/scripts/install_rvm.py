"""Скачивает модель маски человека RVM (Robust Video Matting, MobileNetV3, ONNX) в ~/.ii-ramis/mask/models.

Модель НЕ лежит в плагине. Источник официальный: GitHub-релиз v1.0.0 авторов (PeterL1n/RobustVideoMatting), лицензия GPL-3.0.
Качается только по «да» ученика (см. nabor/references/ustanovka.md). Только https, до 25 МБ, SHA256 закреплён ниже."""
import os
import sys
from pathlib import Path

import safefetch

URL = "https://github.com/PeterL1n/RobustVideoMatting/releases/download/v1.0.0/rvm_mobilenetv3_fp32.onnx"
SHA256 = "88d4531297118f595bf2fd60f6f566aec2e559393802d1f436c380f0cbbd2828"
MAX_BYTES = 25 * 1024 * 1024
MODEL_DIR = Path(os.environ.get("II_RAMIS_HOME") or Path.home() / ".ii-ramis") / "mask" / "models"
MODEL = MODEL_DIR / "rvm_mobilenetv3_fp32.onnx"


def main():
    if MODEL.is_file() and safefetch.sha256_file(MODEL, MAX_BYTES) == SHA256:
        print("Модель маски уже стоит:", MODEL)
        return
    try:
        safefetch.download(URL, str(MODEL), MAX_BYTES, SHA256, timeout=120)
    except safefetch.FetchError as error:
        safefetch.fail(str(error))
    print("Модель маски установлена:", MODEL)


if __name__ == "__main__":
    main()
