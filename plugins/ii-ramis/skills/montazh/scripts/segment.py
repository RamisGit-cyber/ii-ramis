"""Маска человека для стиля «Афиша»: слово-тема встаёт ЗА человека.

Запуск (только питоном из окружения маски, оно ставится по «да» ученика, см. nabor/references/ustanovka.md):
    ~/.ii-ramis/mask/bin/python segment.py <папка проекта> _монтаж/<имя>/base.mp4 _монтаж/<имя>/mask.mp4

Как у Монтажки: Robust Video Matting (MobileNetV3, ONNX) на обычном процессоре, прядями по волосам и без мерцания
(сеть помнит прошлые кадры). Модель лежит в ~/.ii-ramis/mask/models (её качает install_rvm.py по «да», в плагине её нет).
Нет модели или onnxruntime, но стоит старое окружение с MediaPipe (плагин до 2.8): считает MediaPipe (грубее).
Читает видео проекта, пишет только внутрь папки проекта и не по ссылкам. Ничего не отправляет в сеть."""
import os
import subprocess
import sys
from pathlib import Path

import common

W, H, FPS = common.W, common.H, 30
MODEL = Path(os.environ.get("II_RAMIS_HOME") or Path.home() / ".ii-ramis") / "mask" / "models" / "rvm_mobilenetv3_fp32.onnx"
MODEL_SHA256 = "88d4531297118f595bf2fd60f6f566aec2e559393802d1f436c380f0cbbd2828"
RATIO = 0.25  # для 1080×1920 по рекомендации авторов модели


def open_streams(video, mask_path, in_w, in_h, rgb_scale):
    decode = subprocess.Popen(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-protocol_whitelist", "file,pipe", "-i", video, "-vf", rgb_scale,
         "-r", str(FPS), "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], stdout=subprocess.PIPE)
    encode = subprocess.Popen(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-f", "rawvideo", "-pix_fmt", "gray", "-s", f"{in_w}x{in_h}",
         "-r", str(FPS), "-i", "-", "-vf", f"scale={W}:{H}:flags=bicubic", "-c:v", "libx264", "-crf", "12", "-pix_fmt", "yuv420p",
         "-r", str(FPS), "-movflags", "+faststart", mask_path], stdin=subprocess.PIPE)
    return decode, encode


def finish(decode, encode, frames):
    if encode.stdin:
        encode.stdin.close()
    decode.stdout.close()
    decode.wait()
    code = encode.wait()
    if frames == 0 or code != 0:
        sys.exit("Маска не получилась (ffmpeg не справился).")


def run_rvm(video, mask_path):
    import hashlib

    import numpy as np
    import onnxruntime as ort

    digest = hashlib.sha256()
    with open(MODEL, "rb") as handle:  # модель могли подменить: сверяем при каждом запуске
        for block in iter(lambda: handle.read(1 << 20), b""):
            digest.update(block)
    if digest.hexdigest() != MODEL_SHA256:
        sys.exit("Файл модели маски не совпал с контрольной суммой. Удали его и запусти install_rvm.py заново.")
    options = ort.SessionOptions()
    options.intra_op_num_threads = max(1, min(4, os.cpu_count() or 2))
    options.inter_op_num_threads = 1
    session = ort.InferenceSession(str(MODEL), options, providers=["CPUExecutionProvider"])
    state = [np.zeros([1, 1, 1, 1], np.float32)] * 4
    ratio = np.array([RATIO], np.float32)
    decode, encode = open_streams(video, mask_path, W, H, f"scale={W}:{H}:flags=bicubic,setsar=1")
    frame_bytes, frames = W * H * 3, 0
    try:
        while True:
            raw = decode.stdout.read(frame_bytes)
            if len(raw) < frame_bytes:
                break
            rgb = np.frombuffer(raw, np.uint8).reshape(H, W, 3)
            src = (rgb.astype(np.float32) / 255).transpose(2, 0, 1)[None]
            _, alpha, *state = session.run(None, {"src": src, "r1i": state[0], "r2i": state[1], "r3i": state[2],
                                                  "r4i": state[3], "downsample_ratio": ratio})
            try:
                encode.stdin.write((np.clip(alpha[0, 0], 0, 1) * 255).astype(np.uint8).tobytes())
            except BrokenPipeError:
                sys.exit("ffmpeg остановился при записи маски, проверь свободное место и ffmpeg.")
            frames += 1
    finally:
        finish(decode, encode, frames)
    return frames


def run_mediapipe(video, mask_path):
    import mediapipe as mp
    import numpy as np

    proc_w, proc_h = 540, 960
    decode, encode = open_streams(video, mask_path, proc_w, proc_h, f"scale={proc_w}:{proc_h}")
    segmenter = mp.solutions.selfie_segmentation.SelfieSegmentation(model_selection=0)
    smooth, frames, frame_bytes = None, 0, proc_w * proc_h * 3
    try:
        while True:
            raw = decode.stdout.read(frame_bytes)
            if len(raw) < frame_bytes:
                break
            rgb = np.frombuffer(raw, np.uint8).reshape(proc_h, proc_w, 3)
            mask = np.clip((segmenter.process(rgb).segmentation_mask - 0.35) / 0.30, 0.0, 1.0)
            smooth = mask if smooth is None else 0.55 * mask + 0.45 * smooth
            try:
                encode.stdin.write((smooth * 255).astype(np.uint8).tobytes())
            except BrokenPipeError:
                sys.exit("ffmpeg остановился при записи маски, проверь свободное место и ffmpeg.")
            frames += 1
    finally:
        segmenter.close()
        finish(decode, encode, frames)
    return frames


def pick_backend():
    if MODEL.is_file():
        try:
            import onnxruntime  # noqa: F401
            import numpy  # noqa: F401
            return "rvm"
        except ImportError:
            pass
    try:
        import mediapipe  # noqa: F401
        import numpy  # noqa: F401
        return "mediapipe"
    except ImportError:
        return None


def main():
    if len(sys.argv) != 4:
        sys.exit("Использование: segment.py <папка проекта> <видео внутри проекта> <маска.mp4 внутри проекта>")
    project, video_rel, mask_rel = sys.argv[1:4]
    project = os.path.abspath(project)
    backend = pick_backend()
    if not backend:
        sys.exit("Нет окружения маски (onnxruntime и модель RVM). Поставь его по разделу «Маска человека» в nabor/references/ustanovka.md "
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
    print("Считаю маску:", "RVM (как у Монтажки)" if backend == "rvm" else "MediaPipe (старое окружение, грубее)")
    frames = run_rvm(video, mask_path) if backend == "rvm" else run_mediapipe(video, mask_path)
    print(f"Маска готова: {mask_rel}, кадров {frames}")


if __name__ == "__main__":
    main()
