"""Сборка рилса 1080x1920 из видео ученика: вырезает куски, ставит субтитры и вставки, подмешивает музыку, выравнивает звук.

Запуск (из любой папки):
  uv run montage.py build  <папка-проекта> <план.json>   собрать в _монтаж/<имя>/final.mp4
  uv run montage.py export <папка-проекта> <план.json>   положить проверенный ролик в готово/ (старые не перезаписывает)

Пишет только в <проект>/_монтаж/<имя>/ и <проект>/готово/. Файлы ученика не меняет и не удаляет.
Формат плана и пояснения: references/rabota.md
"""
import json
import os
import re
import shutil
import sys

from common import H, SAFE, W, ffmpeg_ok, ffmpeg_text, inside, load_json, need, probe, project_path

HERE = os.path.dirname(os.path.abspath(__file__))
FONTS_SRC = os.path.join(os.path.dirname(HERE), "fonts")
PAD_BEFORE, PAD_AFTER = 0.06, 0.14  # запас вокруг слов при резке, чтобы не съесть звук слова


def hex_to_ass(color, alpha="00"):
    match = re.fullmatch(r"#?([0-9a-fA-F]{6})", color or "")
    if not match:
        sys.exit(f"Цвет должен быть вида #FFD400, а не {color!r}")
    rgb = match.group(1)
    return f"&H{alpha}{rgb[4:6]}{rgb[2:4]}{rgb[0:2]}".upper()


def ass_time(seconds):
    seconds = max(0.0, seconds)
    h, rest = divmod(seconds, 3600)
    m, s = divmod(rest, 60)
    return f"{int(h)}:{int(m):02d}:{s:05.2f}"


def clean_text(text):
    return re.sub(r"[{}\\\r\n]+", " ", str(text)).strip()


def snap_segments(keep, words, duration):
    """Границы кусков не должны попадать внутрь слова: сдвигаем их к границе слова."""
    result = []
    for start, end in keep:
        start, end = max(0.0, float(start)), min(duration, float(end))
        for word in words:
            if word["s"] < start < word["e"]:
                start = word["s"]
            if word["s"] < end < word["e"]:
                end = word["e"]
        start, end = max(0.0, start - PAD_BEFORE), min(duration, end + PAD_AFTER)
        if end - start < 0.3:
            continue
        if result and start <= result[-1][1]:
            result[-1][1] = max(result[-1][1], end)
        else:
            result.append([start, end])
    if not result:
        sys.exit("В плане нет ни одного подходящего куска (keep).")
    return result


def map_interval(start, end, segments):
    """Отрезок [start, end] из исходника -> отрезок в смонтированном ролике (только та часть, что осталась)."""
    offset, cut_start, cut_end = 0.0, None, None
    for seg_start, seg_end in segments:
        overlap_start, overlap_end = max(start, seg_start), min(end, seg_end)
        if overlap_end > overlap_start:
            if cut_start is None:
                cut_start = offset + (overlap_start - seg_start)
            cut_end = offset + (overlap_end - seg_start)
        offset += seg_end - seg_start
    if cut_start is None or cut_end - cut_start < 0.25:
        return None
    return cut_start, cut_end


def build_ass(cards, style):
    size = int(style.get("size", 84))
    accent_size = int(size * 1.3)
    single = style.get("layout", "stack") == "single"  # "single": одна строка, акцентное слово цветом
    bottom = int(style.get("bottom", 1380))
    bottom = min(bottom, SAFE["bottom"] - 40)
    margin_v = H - bottom
    margin_l, margin_r = SAFE["left"] + 10, W - SAFE["right"] + 10
    accent = hex_to_ass(style.get("accent", "#FFD400"))
    text_color = hex_to_ass(style.get("text", "#FFFFFF"))
    backdrop = bool(style.get("backdrop", False))
    border_style, outline, back = (3, 14, "&H70000000") if backdrop else (1, 0, "&H90000000")
    head = (
        "[Script Info]\nScriptType: v4.00+\n"
        f"PlayResX: {W}\nPlayResY: {H}\nWrapStyle: 0\nScaledBorderAndShadow: yes\n\n"
        "[V4+ Styles]\n"
        "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, "
        "Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, "
        "MarginL, MarginR, MarginV, Encoding\n"
        f"Style: Card,Onest ExtraBold,{size},{text_color},{text_color},{back},{back},0,0,0,0,100,100,0,0,"
        f"{border_style},{outline},4,2,{margin_l},{margin_r},{margin_v},1\n\n"
        "[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n"
    )
    lines = []
    for card in cards:
        text = clean_text(card["text"])
        accent_word = clean_text(card.get("accent", ""))
        if accent_word and accent_word in text and single:
            body = "{\\blur2}" + text.replace(accent_word, f"{{\\1c{accent}}}{accent_word}{{\\1c{text_color}}}", 1)
        elif accent_word and accent_word in text:
            thin = text.replace(accent_word, "", 1).strip()
            body = ""
            if thin:
                body += f"{{\\fnOnest\\fs{int(size * 0.72)}\\1c{text_color}}}{thin}\\N"
            body += f"{{\\fnOnest ExtraBold\\fs{accent_size}\\1c{accent}}}{accent_word}"
        else:
            body = f"{{\\blur2}}{text}"
        lines.append(
            f"Dialogue: 0,{ass_time(card['s'])},{ass_time(card['e'])},Card,,0,0,0,,{{\\fad(80,80)}}{body}"
        )
    return head + "\n".join(lines) + "\n"


def make_cards(plan, segments):
    mapped = []
    for card in plan.get("cards", []):
        interval = map_interval(float(card["s"]), float(card["e"]), segments)
        if interval:
            mapped.append({"s": interval[0], "e": interval[1], "text": card["text"], "accent": card.get("accent", "")})
    mapped.sort(key=lambda c: c["s"])
    for current, following in zip(mapped, mapped[1:]):  # одна строка за раз, без «призраков»
        current["e"] = min(current["e"], following["s"] - 0.02)
    return [c for c in mapped if c["e"] - c["s"] >= 0.25]


def mean_volume(path, seconds=60):
    report = ffmpeg_text(["-t", str(seconds), "-i", path, "-vn", "-af", "volumedetect", "-f", "null", os.devnull])
    match = re.search(r"mean_volume: (-?[\d.]+) dB", report)
    return float(match.group(1)) if match else None


def build_base(project, plan, workdir, segments):
    source = project_path(project, plan["source"])
    info = probe(source)
    if not any(s["codec_type"] == "audio" for s in info["streams"]):
        sys.exit("В исходном видео нет звука, говорящую голову без речи не смонтировать.")
    crop_x = min(1.0, max(0.0, float(plan.get("crop_x", 0.5))))
    fit = (
        f"fps=30,scale={W}:{H}:force_original_aspect_ratio=increase,"
        f"crop={W}:{H}:(iw-{W})*{crop_x}:(ih-{H})*0.5,setsar=1,format=yuv420p"
    )
    inputs, parts, labels = [], [], ""
    for index, (start, end) in enumerate(segments):  # каждый кусок читается отдельно: так не копится память
        fade = min(0.02, (end - start) / 4)
        inputs += ["-ss", f"{start:.3f}", "-t", f"{end - start:.3f}", "-i", source]
        parts.append(f"[{index}:v]{fit}[v{index}]")
        parts.append(
            f"[{index}:a]aresample=48000,asetpts=PTS-STARTPTS,"
            f"afade=t=in:d={fade:.3f},afade=t=out:st={end - start - fade:.3f}:d={fade:.3f}[a{index}]"
        )
        labels += f"[v{index}][a{index}]"
    frame = plan.get("frame") or {}
    zoom = min(1.0, max(0.7, float(frame.get("scale", 1.0))))
    if zoom < 1.0:  # «отъезд»: человек меньше и выше, снизу освобождается место под субтитры; фон — размытая копия того же кадра
        small_w = int(W * zoom) // 2 * 2
        top = int(frame.get("top", 40))
        parts.append(f"{labels}concat=n={len(segments)}:v=1:a=1[vc][ac]")
        parts.append(
            "[vc]split=2[fa][fb];[fb]boxblur=30:3[bg];"
            f"[fa]scale={small_w}:-2[fg];[bg][fg]overlay=(W-w)/2:{top}[v]"
        )
    else:
        parts.append(f"{labels}concat=n={len(segments)}:v=1:a=1[v][ac]")
    base = os.path.join(workdir, "base.mp4")
    ffmpeg_ok([
        *inputs, "-filter_complex", ";".join(parts), "-map", "[v]", "-map", "[ac]",
        "-c:v", "libx264", "-crf", "16", "-preset", "fast", "-c:a", "aac", "-b:a", "192k", base,
    ])
    return base


def mix_audio(project, plan, workdir, base):
    music = plan.get("music")
    mix = os.path.join(workdir, "mix.wav")
    if not music or not music.get("file"):
        ffmpeg_ok(["-i", base, "-vn", "-ac", "2", "-ar", "48000", mix])
        return mix
    music_file = project_path(project, music["file"])
    duration = float(probe(base)["format"]["duration"])
    voice_level, music_level = mean_volume(base), mean_volume(music_file)
    below = float(music.get("below_voice_db", 18))
    gain = (voice_level - below - music_level) if None not in (voice_level, music_level) else -22.0
    fade_out = max(0.0, duration - 1.5)
    graph = (
        f"[1:a]aloop=loop=-1:size=2000000000,atrim=0:{duration:.2f},asetpts=PTS-STARTPTS,volume={gain:.1f}dB,"
        f"afade=t=in:d=1,afade=t=out:st={fade_out:.2f}:d=1.5[m];"
        "[0:a]asplit=2[v1][v2];[m][v2]sidechaincompress=threshold=0.04:ratio=6:attack=20:release=500[md];"
        "[v1][md]amix=inputs=2:duration=first:normalize=0[out]"
    )
    ffmpeg_ok(["-i", base, "-i", music_file, "-filter_complex", graph, "-map", "[out]", "-ac", "2", "-ar", "48000", mix])
    return mix


def measure_loudness(mix):
    report = ffmpeg_text(["-i", mix, "-af", "loudnorm=I=-14:TP=-1.5:LRA=11:print_format=json", "-f", "null", os.devnull])
    block = re.search(r"\{[^{}]*\"input_i\"[^{}]*\}", report, re.S)
    if not block:
        return None
    return json.loads(block.group(0))


def loudnorm_filter(measured):
    if not measured:
        return "loudnorm=I=-14:TP=-1.5:LRA=11"
    return (
        "loudnorm=I=-14:TP=-1.5:LRA=11:"
        f"measured_I={measured['input_i']}:measured_TP={measured['input_tp']}:"
        f"measured_LRA={measured['input_lra']}:measured_thresh={measured['input_thresh']}:"
        f"offset={measured['target_offset']}:linear=true"
    )


INSERT_PRESETS = {"top": ("(W-w)/2", str(SAFE["top"] + 20)), "bottom": ("(W-w)/2", str(SAFE["bottom"] - 460))}


def inserts_chain(project, plan, segments):
    inputs, graph, last = [], [], "vs"
    for index, item in enumerate(plan.get("inserts", [])):
        interval = map_interval(float(item["s"]), float(item["e"]), segments)
        if not interval:
            continue
        path = project_path(project, item["file"])
        width = int(item.get("width", 480))
        x, y = INSERT_PRESETS.get(item.get("pos", "top"), (str(int(item.get("x", 90))), str(int(item.get("y", 240)))))
        slot = len(inputs) // 8 + 1
        inputs += ["-loop", "1", "-framerate", "30", "-t", f"{interval[1] + 1:.2f}", "-i", path]
        graph.append(f"[{slot}:v]scale={width}:-2,format=rgba[ins{index}]")
        out = f"o{index}"
        graph.append(
            f"[{last}][ins{index}]overlay=x={x}:y={y}:enable='between(t,{interval[0]:.2f},{interval[1]:.2f})':eof_action=pass[{out}]"
        )
        last = out
    return inputs, graph, last


def build(project, plan_path):
    need("ffmpeg"), need("ffprobe")
    plan = load_json(plan_path)
    name = re.sub(r"[^\w\-]+", "_", plan.get("name", "reel"), flags=re.U).strip("_") or "reel"
    workdir = os.path.join(project, "_монтаж", name)
    if not inside(project, workdir):
        sys.exit("Рабочая папка вне проекта.")
    os.makedirs(workdir, exist_ok=True)
    source = project_path(project, plan["source"])
    duration = float(probe(source)["format"]["duration"])
    transcript_path = os.path.join(workdir, "transcript.json")
    words = load_json(transcript_path)["words"] if os.path.isfile(transcript_path) else []
    segments = snap_segments(plan.get("keep") or [[0, duration]], words, duration)
    print("Куски (сек в исходнике):", [[round(a, 2), round(b, 2)] for a, b in segments])
    base = build_base(project, plan, workdir, segments)
    cards = make_cards(plan, segments)
    with open(os.path.join(workdir, "subs.ass"), "w", encoding="utf-8") as handle:
        handle.write(build_ass(cards, plan.get("style", {})))
    fonts_dir = os.path.join(workdir, "fonts")
    shutil.copytree(FONTS_SRC, fonts_dir, dirs_exist_ok=True)
    mix = mix_audio(project, plan, workdir, base)
    loudness = loudnorm_filter(measure_loudness(mix))
    extra_inputs, graph, last = inserts_chain(project, plan, segments)
    video_graph = ["[0:v]null[vs]"] + graph + [f"[{last}]ass=filename=subs.ass:fontsdir=fonts[vout]"]
    audio_slot = len(extra_inputs) // 8 + 1  # на каждую вставку приходится 8 аргументов
    final = os.path.join(workdir, "final.mp4")
    ffmpeg_ok(
        ["-i", "base.mp4", *extra_inputs, "-i", "mix.wav", "-filter_complex", ";".join(video_graph),
         "-map", "[vout]", "-map", f"{audio_slot}:a", "-af", loudness, "-c:v", "libx264", "-crf", "18",
         "-preset", "medium", "-pix_fmt", "yuv420p", "-r", "30", "-c:a", "aac", "-b:a", "192k", "-ar", "48000",
         "-movflags", "+faststart", "-shortest", "final.mp4"],
        cwd=workdir,
    )
    with open(os.path.join(workdir, "cut-plan.json"), "w", encoding="utf-8") as handle:
        json.dump({"segments": segments, "cards": cards}, handle, ensure_ascii=False, indent=1)
    print(f"Готово к проверке: {final}")


def export(project, plan_path):
    plan = load_json(plan_path)
    name = re.sub(r"[^\w\-]+", "_", plan.get("name", "reel"), flags=re.U).strip("_") or "reel"
    final = os.path.join(project, "_монтаж", name, "final.mp4")
    if not os.path.isfile(final):
        sys.exit("Сначала собери ролик (build) и пройди проверку критика.")
    out_dir = os.path.join(project, "готово")
    os.makedirs(out_dir, exist_ok=True)
    target, version = os.path.join(out_dir, f"{name}.mp4"), 1
    while os.path.exists(target):  # чужие и прошлые файлы не перезаписываем
        version += 1
        target = os.path.join(out_dir, f"{name}-v{version}.mp4")
    shutil.copyfile(final, target)
    print(f"Ролик лежит здесь: {target}")


def main():
    if len(sys.argv) != 4 or sys.argv[1] not in ("build", "export"):
        sys.exit(__doc__)
    project = os.path.abspath(sys.argv[2])
    plan_path = os.path.join(project, sys.argv[3]) if not os.path.isabs(sys.argv[3]) else sys.argv[3]
    if not inside(project, plan_path) or not os.path.isfile(plan_path):
        sys.exit("План должен лежать внутри папки проекта.")
    (build if sys.argv[1] == "build" else export)(project, plan_path)


if __name__ == "__main__":
    main()
