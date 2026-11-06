"""Маска человека для стиля «Афиша»: слово-тема встаёт ЗА человека.

Запуск (только питоном из окружения маски, оно ставится по «да» ученика, см. nabor/references/ustanovka.md):
    ~/.ii-ramis/mask/bin/python segment.py <папка проекта> _монтаж/<имя>/base.mp4 _монтаж/<имя>/mask.mp4

Читает видео проекта, для каждого кадра считает маску человека (MediaPipe Selfie Segmentation, работает на обычном
процессоре, модель внутри пакета, интернет не нужен), сглаживает её по времени и пишет чёрно-белое видео-маску
(белое = человек). Пишет только внутрь папки проекта и не по ссылкам. Ничего не отправляет в сеть.
"""
import os
import subprocess
import sys

import common

PROC_W, PROC_H = 540, 960  # считаем на половинном разрешении: быстро, края потом сглаживает ffmpeg
FPS = 30


def main():
    if len(sys.argv) != 4:
        sys.exit("Использование: segment.py <папка проекта> <видео внутри проекта> <маска.mp4 внутри проекта>")
    project, video_rel, mask_rel = sys.argv[1:4]
    project = os.path.abspath(project)
    try:
        import cv2  # noqa: F401
        import mediapipe as mp
        import numpy as np
    except ImportError:
        sys.exit("Нет окружения маски (mediapipe). Поставь его по разделу «Маска человека» в nabor/references/ustanovka.md "
                 "и запусти этот скрипт питоном из ~/.ii-ramis/mask. Без маски стиль «Афиша» ставит слово-тему над головой.")
    common.need("ffmpeg")
    video = common.media_file(project, video_rel)
    mask_path = os.path.join(project, mask_rel)
    work_root = os.path.realpath(os.path.join(project, "_монтаж"))
    if os.path.commonpath([work_root, os.path.realpath(mask_path)]) != work_root:
        sys.exit("Маска пишется только в _монтаж/ внутри проекта.")
    common.own_output(project, mask_path)
    duration = float(common.probe(video)["format"]["duration"])
    if duration > 180:
        sys.exit("Ролик длиннее 3 минут, для рилса это лишнее.")

    decode = subprocess.Popen(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-protocol_whitelist", "file,pipe", "-i", video, "-vf",
         f"scale={PROC_W}:{PROC_H}", "-r", str(FPS), "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
        stdout=subprocess.PIPE)
    encode = subprocess.Popen(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-f", "rawvideo", "-pix_fmt", "gray", "-s",
         f"{PROC_W}x{PROC_H}", "-r", str(FPS), "-i", "-", "-vf", "scale=1080:1920:flags=bicubic,boxblur=2:1",
         "-c:v", "libx264", "-crf", "12", "-pix_fmt", "yuv420p", "-r", str(FPS), "-movflags", "+faststart", mask_path],
        stdin=subprocess.PIPE)
    frame_bytes = PROC_W * PROC_H * 3
    segmenter = mp.solutions.selfie_segmentation.SelfieSegmentation(model_selection=0)
    smooth = None
    frames = 0
    try:
        while True:
            raw = decode.stdout.read(frame_bytes)
            if len(raw) < frame_bytes:
                break
            rgb = np.frombuffer(raw, np.uint8).reshape(PROC_H, PROC_W, 3)
            mask = segmenter.process(rgb).segmentation_mask  # 0..1 на размере кадра
            mask = np.clip((mask - 0.35) / 0.30, 0.0, 1.0)  # мягкий порог: уверенный человек = 1, фон = 0
            smooth = mask if smooth is None else 0.55 * mask + 0.45 * smooth  # меньше мерцания краёв
            try:
                encode.stdin.write((smooth * 255).astype(np.uint8).tobytes())
            except BrokenPipeError:
                sys.exit("ffmpeg остановился при записи маски, проверь свободное место и ffmpeg.")
            frames += 1
    finally:
        segmenter.close()
        if encode.stdin:
            encode.stdin.close()
        decode.stdout.close()
        decode.wait()
        code = encode.wait()
    if frames == 0 or code != 0:
        sys.exit("Маска не получилась (ffmpeg не справился).")
    print(f"Маска готова: {mask_rel}, кадров {frames}")


if __name__ == "__main__":
    main()
