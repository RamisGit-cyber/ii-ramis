"""Критик: объективная проверка готового ролика. Глазами кадры потом смотрит Claude (references/kritik.md).

Запуск: uv run critic.py <папка-проекта> <план.json>
Проверяет: формат и длину, безопасную зону Instagram, лицо, контраст, цифровой звук (громкость, перегруз, провалы),
границы резки (не режем слова), хук в первые секунды. Рисует кадры каждые 2 с в _монтаж/<имя>/кадры/.
Пишет только в _монтаж/<имя>/. Выход: строки ПРОВАЛ / ВНИМАНИЕ / ОК и файл отчёт-критика.json.
"""
import json
import os
import re
import subprocess
import sys

from common import H, SAFE, W, ffmpeg_ok, ffmpeg_text, inside, load_json, need, probe

SAMPLE_FPS = 2
SMALL_W, SMALL_H = 540, 960
FACTOR = W // SMALL_W
FACE_MARGIN = 30
TOLERANCE = 8
TEXT_LEVEL = 60   # яркость пикселя на чёрном фоне, с которой он считается буквой
INSERT_LEVEL = 60  # разница кадра со вставкой и чистого кадра
_TABLES = {}


def _table(level):
    if level not in _TABLES:
        _TABLES[level] = bytes(1 if value > level else 0 for value in range(256))
    return _TABLES[level]


def gray_frames(args, cwd=None):
    """Кадры 540x960 в серых тонах, SAMPLE_FPS в секунду: ffmpeg отдаёт их как PGM по трубе."""
    process = subprocess.Popen(["ffmpeg", "-v", "error", *args, "-f", "image2pipe", "-vcodec", "pgm", "-"],
                               stdout=subprocess.PIPE, cwd=cwd)
    header = f"P5\n{SMALL_W} {SMALL_H}\n255\n".encode()
    size = SMALL_W * SMALL_H
    while True:
        chunk = process.stdout.read(len(header) + size)
        if len(chunk) < len(header) + size:
            break
        yield chunk[len(header):]
    process.stdout.close()
    if process.wait() != 0:
        sys.exit("ffmpeg не смог разобрать кадры для проверки (см. сообщение выше)")


def bright_bbox(frame, level, min_count):
    """Рамка ярких пикселей кадра в координатах 1080x1920 (считает встроенными быстрыми операциями)."""
    table = _table(level)
    ys = [y for y in range(SMALL_H) if frame[y * SMALL_W:(y + 1) * SMALL_W].translate(table).count(1) >= min_count]
    xs = [x for x in range(SMALL_W) if frame[x::SMALL_W].translate(table).count(1) >= min_count]
    if not ys or not xs:
        return None
    return [min(xs) * FACTOR, min(ys) * FACTOR, (max(xs) + 1) * FACTOR, (max(ys) + 1) * FACTOR]


def union(first, second):
    if not first or not second:
        return first or second
    return [min(first[0], second[0]), min(first[1], second[1]), max(first[2], second[2]), max(first[3], second[3])]


def region_brightness(frame, box):
    x0, y0, x1, y1 = (int(v / FACTOR) for v in box)
    total = count = 0
    for y in range(max(0, y0), min(SMALL_H, y1)):
        row = frame[y * SMALL_W + max(0, x0): y * SMALL_W + min(SMALL_W, x1)]
        total += sum(row)
        count += len(row)
    return total / count if count else 128


def contrast_ratio(background_gray):
    luminance = (background_gray / 255) ** 2.2
    return 1.05 / (luminance + 0.05)  # белый текст на таком фоне


def check_picture(workdir, face, has_inserts, backdrop, problems, notes):
    duration = float(probe(os.path.join(workdir, "final.mp4"))["format"]["duration"])
    fit = f"fps={SAMPLE_FPS},scale={SMALL_W}:{SMALL_H},format=gray"
    # 1) где стоят буквы: субтитры рисуются на чёрном фоне, поэтому видны на любом фоне видео
    mask_args = ["-f", "lavfi", "-i", f"color=c=black:s={W}x{H}:r=30:d={duration:.2f}",
                 "-vf", f"ass=filename=subs.ass:fontsdir=fonts,{fit}"]
    text_boxes = [bright_bbox(f, TEXT_LEVEL, 1) for f in gray_frames(mask_args, workdir)]
    # 2) вставки-картинки: видны как разница между чистым кадром и итогом
    insert_boxes = [None] * len(text_boxes)
    if has_inserts:
        diff_args = ["-i", os.path.join(workdir, "final.mp4"), "-i", os.path.join(workdir, "base.mp4"),
                     "-filter_complex", f"[0:v][1:v]blend=all_mode=difference,{fit}"]
        insert_boxes = [bright_bbox(f, INSERT_LEVEL, 6) for f in gray_frames(diff_args, workdir)]
    base_frames = list(gray_frames(["-i", os.path.join(workdir, "base.mp4"), "-vf", fit], workdir))
    samples = []
    for index, frame in enumerate(base_frames):
        text_box = text_boxes[index] if index < len(text_boxes) else None
        extra = insert_boxes[index] if index < len(insert_boxes) else None
        samples.append((index / SAMPLE_FPS, union(text_box, extra), frame))
    shown = [(t, box, frame) for t, box, frame in samples if box]
    first_text = shown[0][0] if shown else None
    if not shown:
        problems.append("ПРОВАЛ: в ролике не нашлось ни одной надписи (субтитры не видны)")
    elif first_text > 1.5:
        notes.append(f"ВНИМАНИЕ: первая надпись появляется на {first_text:.1f} с, хук лучше показать в первые 1-2 секунды")
    else:
        notes.append(f"ОК: первая надпись на {first_text:.1f} с")
    worst = {}
    face_box = None
    if face:
        face_box = [face["x"] - FACE_MARGIN, face["y"] - FACE_MARGIN,
                    face["x"] + face["w"] + FACE_MARGIN, face["y"] + face["h"] + FACE_MARGIN]
    else:
        notes.append("ВНИМАНИЕ: в плане нет рамки лица (face), проверка «не закрывает лицо» только глазами по кадрам")
    for t, box, frame in shown:
        x0, y0, x1, y1 = box
        if x0 < SAFE["left"] - TOLERANCE or x1 > SAFE["right"] + TOLERANCE:
            worst.setdefault("бока", []).append((t, box))
        if y0 < SAFE["top"] - TOLERANCE:
            worst.setdefault("верх", []).append((t, box))
        if y1 > SAFE["bottom"] + TOLERANCE:
            worst.setdefault("низ", []).append((t, box))
        if face_box and not (x1 < face_box[0] or x0 > face_box[2] or y1 < face_box[1] or y0 > face_box[3]):
            worst.setdefault("лицо", []).append((t, box))
        ratio = contrast_ratio(region_brightness(frame, box))
        if ratio < 2.5 and not backdrop:
            worst.setdefault("контраст", []).append((t, box))
    names = {
        "бока": f"надпись заходит за боковые поля или правую колонку кнопок (рабочая ширина x {SAFE['left']}..{SAFE['right']})",
        "верх": f"надпись залезает под шапку Instagram (выше y={SAFE['top']})",
        "низ": f"надпись залезает в подпись и кнопки Instagram (ниже y={SAFE['bottom']})",
        "лицо": "надпись или вставка закрывает лицо или рот",
        "контраст": "белый текст плохо читается на светлом фоне (нужна тёмная подложка: style.backdrop)",
    }
    for key, items in worst.items():
        times = ", ".join(f"{t:.1f}" for t, _ in items[:6]) + (" ..." if len(items) > 6 else "")
        t0, box = items[0]
        problems.append(f"ПРОВАЛ: {names[key]}; секунды: {times}; рамка надписи {box}")
    if shown and not worst:
        boxes = [b for _, b, _ in shown]
        notes.append(f"ОК: надписи внутри безопасной зоны и не задевают лицо; самая низкая надпись до y={max(b[3] for b in boxes)}")
    return len(samples)


def check_format(final, problems, notes):
    info = probe(final)
    video = next((s for s in info["streams"] if s["codec_type"] == "video"), {})
    audio = next((s for s in info["streams"] if s["codec_type"] == "audio"), {})
    duration = float(info["format"]["duration"])
    if (video.get("width"), video.get("height")) != (W, H):
        problems.append(f"ПРОВАЛ: размер {video.get('width')}x{video.get('height')}, нужен {W}x{H}")
    if video.get("codec_name") != "h264" or video.get("pix_fmt") != "yuv420p":
        problems.append(f"ПРОВАЛ: кодек {video.get('codec_name')}/{video.get('pix_fmt')}, нужен h264/yuv420p")
    if audio.get("codec_name") != "aac":
        problems.append("ПРОВАЛ: нет звука AAC")
    if duration < 5 or duration > 90:
        problems.append(f"ПРОВАЛ: длина {duration:.1f} с, для Reels нужно от 5 до 90 с")
    elif duration > 60:
        notes.append(f"ВНИМАНИЕ: длина {duration:.1f} с; ролики до 60 с досматривают чаще")
    else:
        notes.append(f"ОК: длина {duration:.1f} с, формат {W}x{H} h264")
    return duration


def check_sound(final, duration, problems, notes):
    report = ffmpeg_text(["-i", final, "-vn", "-af", "volumedetect,silencedetect=n=-40dB:d=0.6,"
                          "loudnorm=I=-14:TP=-1.5:LRA=11:print_format=json", "-f", "null", os.devnull])
    peak = re.search(r"max_volume: (-?[\d.]+) dB", report)
    block = re.search(r"\{[^{}]*\"input_i\"[^{}]*\}", report, re.S)
    if block:
        measured = json.loads(block.group(0))
        loud, true_peak = float(measured["input_i"]), float(measured["input_tp"])
        if not -17 <= loud <= -11:
            problems.append(f"ПРОВАЛ: громкость {loud:.1f} LUFS, нужно около -14 (от -17 до -11)")
        else:
            notes.append(f"ОК: громкость {loud:.1f} LUFS")
        if true_peak > -0.5 or (peak and float(peak.group(1)) >= -0.1):
            problems.append(f"ПРОВАЛ: звук перегружен (пик {true_peak:.1f} dB), будет хрипеть")
        else:
            notes.append(f"ОК: пик {true_peak:.1f} dB, перегруза нет")
    else:
        notes.append("ВНИМАНИЕ: громкость измерить не удалось")
    starts = [float(x) for x in re.findall(r"silence_start: (-?[\d.]+)", report)]
    ends = [(float(a), float(b)) for a, b in re.findall(r"silence_end: ([\d.]+) \| silence_duration: ([\d.]+)", report)]
    gaps = [(max(0.0, end - length), length) for end, length in ends]
    if starts and not ends:  # тишина тянется до конца ролика
        gaps.append((starts[-1], duration - starts[-1]))
    middle = [(s, d) for s, d in gaps if s > 0.4 and s + d < duration - 0.4]
    long_ones = [(s, d) for s, d in middle if d >= 1.0]
    if long_ones:
        where = ", ".join(f"{s:.1f} с (тишина {d:.1f} с)" for s, d in long_ones)
        problems.append(f"ПРОВАЛ: провал звука или длинная пауза в середине: {where}")
    elif middle:
        notes.append("ВНИМАНИЕ: паузы 0.6-1 с в середине: " + ", ".join(f"{s:.1f} с" for s, _ in middle))
    else:
        notes.append("ОК: провалов звука нет")
    lead = next((d for s, d in gaps if s < 0.1), 0)
    if lead > 0.5:
        notes.append(f"ВНИМАНИЕ: речь начинается только через {lead:.1f} с, лучше вырезать начало")
    tail = next((d for s, d in gaps if s + d > duration - 0.1 and s > 0.4), 0)
    if tail > 1.0:
        notes.append(f"ВНИМАНИЕ: в конце тишина {tail:.1f} с, лучше подрезать")


def check_cuts(workdir, problems, notes):
    transcript = os.path.join(workdir, "transcript.json")
    cut_plan = os.path.join(workdir, "cut-plan.json")
    if not (os.path.isfile(transcript) and os.path.isfile(cut_plan)):
        notes.append("ВНИМАНИЕ: нет расшифровки, проверить резку по словам не смог")
        return
    words = load_json(transcript)["words"]
    segments = load_json(cut_plan)["segments"]
    bad = []
    for start, end in segments:
        for word in words:
            if (word["s"] + 0.03 < start < word["e"] - 0.03) or (word["s"] + 0.03 < end < word["e"] - 0.03):
                bad.append((word["w"], round(start if word["s"] < start < word["e"] else end, 2)))
    if bad:
        problems.append("ПРОВАЛ: резка попадает внутрь слов: " + ", ".join(f"«{w}» на {t} с" for w, t in bad[:6]))
    else:
        notes.append("ОК: резка идёт между словами, слова не обрезаны")
    last = segments[-1][1]
    tail_words = [w for w in words if w["e"] > last - 0.02 and w["s"] < last]
    if any(w["e"] > last + 0.02 for w in tail_words):
        problems.append("ПРОВАЛ: ролик обрывается на полуслове")


def make_frames(workdir):
    frames = os.path.join(workdir, "кадры")
    os.makedirs(frames, exist_ok=True)
    ffmpeg_ok(["-i", os.path.join(workdir, "final.mp4"), "-vf", "fps=0.5,scale=540:-2",
               os.path.join(frames, "кадр_%02d.png")])
    ffmpeg_ok(["-i", os.path.join(workdir, "final.mp4"), "-vf", "fps=0.5,scale=270:-2,tile=6x4",
               "-frames:v", "1", os.path.join(workdir, "лист-кадров.png")])
    return frames


def main():
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    need("ffmpeg"), need("ffprobe")
    project = os.path.abspath(sys.argv[1])
    plan_path = sys.argv[2] if os.path.isabs(sys.argv[2]) else os.path.join(project, sys.argv[2])
    if not inside(project, plan_path) or not os.path.isfile(plan_path):
        sys.exit("План должен лежать внутри папки проекта.")
    plan = load_json(plan_path)
    name = re.sub(r"[^\w\-]+", "_", plan.get("name", "reel"), flags=re.U).strip("_") or "reel"
    workdir = os.path.join(project, "_монтаж", name)
    final = os.path.join(workdir, "final.mp4")
    if not os.path.isfile(final):
        sys.exit("Нет final.mp4: сначала собери ролик (montage.py build).")
    problems, notes = [], []
    duration = check_format(final, problems, notes)
    sample_count = check_picture(workdir, plan.get("face"), bool(plan.get("inserts")), bool(plan.get("style", {}).get("backdrop")), problems, notes)
    check_sound(final, duration, problems, notes)
    check_cuts(workdir, problems, notes)
    frames = make_frames(workdir)
    report = {"verdict": "ПРОВАЛ" if problems else "ПРОЙДЕНО", "problems": problems, "notes": notes,
              "frames": frames, "contact_sheet": os.path.join(workdir, "лист-кадров.png"), "checked_samples": sample_count}
    with open(os.path.join(workdir, "отчёт-критика.json"), "w", encoding="utf-8") as handle:
        json.dump(report, handle, ensure_ascii=False, indent=1)
    print("\n".join(problems + notes))
    print(f"\nИтог автоматической проверки: {report['verdict']}")
    print(f"Кадры каждые 2 с для глаз: {frames}\nЛист кадров: {report['contact_sheet']}")


if __name__ == "__main__":
    main()
