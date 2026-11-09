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
import sys

import math

import afisha_hf
import layouts
from common import H, SAFE, W, clean_face, copy_fonts, limit_count, write_bytes, ffmpeg_ok, ffmpeg_text, inside, load_json, media_file, need, number, own_output, probe, require_no_links, write_text

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


def build_ass(cards, style, windows, face, mask=False, layer="front"):
    size = int(number(style.get("size", 84), 30, 200, "style.size"))
    accent_size = int(size * 1.3)
    single = style.get("layout", "stack") == "single"  # "single": одна строка, акцентное слово цветом
    bottom = int(number(style.get("bottom", 1380), 400, 1900, "style.bottom"))
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
    if style.get("preset") == "afisha":
        extra = "".join(
            f"Style: {name},{font},60,&H00FFFFFF,&H00FFFFFF,&H90000000,&H90000000,0,0,0,0,100,100,0,0,1,0,4,2,0,0,0,1\n"
            for name, font, _ in layouts.AFISHA_STYLES
        )
        head = head.replace("\n[Events]", extra + "\n[Events]", 1)
        return head + "\n".join(layouts.afisha_lines(cards, style, face, ass_time, hex_to_ass, clean_text, mask, layer)) + "\n"
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
        pieces = layouts.card_pieces(windows, card, bottom) if windows else [(card["s"], card["e"], None)]
        for start, end, piece_bottom in pieces:  # в сплите субтитр стоит на шве, вне сплита — на обычном месте
            place = f"\\an2\\pos({W // 2},{piece_bottom})" if piece_bottom is not None else ""
            lines.append(f"Dialogue: 0,{ass_time(start)},{ass_time(end)},Card,,0,0,0,,{{{place}\\fad(80,80)}}{body}")
    return head + "\n".join(lines) + "\n"


def make_cards(plan, segments):
    mapped = []
    for card in plan.get("cards", []):
        interval = map_interval(float(card["s"]), float(card["e"]), segments)
        if interval:
            fields = {key: card.get(key, "") for key in ("text", "accent", "theme", "main", "over", "hand", "strike", "hand_below")}
            mapped.append({"s": interval[0], "e": interval[1], **fields})
    mapped.sort(key=lambda c: c["s"])
    for current, following in zip(mapped, mapped[1:]):  # одна строка за раз, без «призраков»
        current["e"] = min(current["e"], following["s"] - 0.02)
    return [c for c in mapped if c["e"] - c["s"] >= 0.25]


def mean_volume(path, seconds=60):
    report = ffmpeg_text(["-t", str(seconds), "-i", path, "-vn", "-af", "volumedetect", "-f", "null", os.devnull])
    match = re.search(r"mean_volume: (-?[\d.]+) dB", report)
    return float(match.group(1)) if match else None


def build_base(project, plan, workdir, segments):
    source = media_file(project, plan["source"])
    info = probe(source)
    if not any(s["codec_type"] == "audio" for s in info["streams"]):
        sys.exit("В исходном видео нет звука, говорящую голову без речи не смонтировать.")
    crop_x = number(plan.get("crop_x", 0.5), 0.0, 1.0, "crop_x")
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
    zoom = number(frame.get("scale", 1.0), 0.7, 1.0, "frame.scale")
    if zoom < 1.0:  # «отъезд»: человек меньше и выше, снизу освобождается место под субтитры; фон — размытая копия того же кадра
        small_w = int(W * zoom) // 2 * 2
        top = int(number(frame.get("top", 40), 0, 400, "frame.top"))
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
        "-map_metadata", "-1", "-c:v", "libx264", "-crf", "16", "-preset", "fast", "-c:a", "aac", "-b:a", "192k", base,
    ])
    return base


def mix_audio(project, plan, workdir, base):
    music = plan.get("music")
    mix = os.path.join(workdir, "mix.wav")
    if not music or not music.get("file"):
        ffmpeg_ok(["-i", base, "-vn", "-map_metadata", "-1", "-ac", "2", "-ar", "48000", mix])
        return mix
    music_file = media_file(project, music["file"])
    duration = float(probe(base)["format"]["duration"])
    music_seconds = float(probe(music_file)["format"].get("duration") or 1)
    voice_level, music_level = mean_volume(base), mean_volume(music_file)
    below = number(music.get("below_voice_db", 18), 6, 40, "music.below_voice_db")
    gain = (voice_level - below - music_level) if None not in (voice_level, music_level) else -22.0
    fade_out = max(0.0, duration - 1.5)
    graph = (
        f"[1:a]aloop=loop=-1:size={int(music_seconds * 48000) + 1},atrim=0:{duration:.2f},asetpts=PTS-STARTPTS,volume={gain:.1f}dB,"
        f"afade=t=in:d=1,afade=t=out:st={fade_out:.2f}:d=1.5[m];"
        "[0:a]asplit=2[v1][v2];[m][v2]sidechaincompress=threshold=0.04:ratio=6:attack=20:release=500[md];"
        "[v1][md]amix=inputs=2:duration=first:normalize=0[out]"
    )
    ffmpeg_ok(["-i", base, "-i", music_file, "-filter_complex", graph, "-map", "[out]", "-map_metadata", "-1", "-ac", "2", "-ar", "48000", mix])
    return mix


def measure_loudness(mix):
    report = ffmpeg_text(["-i", mix, "-af", "loudnorm=I=-14:TP=-1.5:LRA=11:print_format=json", "-f", "null", os.devnull])
    blocks = re.findall(r"\{[^{}]*\"input_i\"[^{}]*\}", report, re.S)
    if not blocks:
        return None
    try:  # значения идут в фильтр ffmpeg, поэтому только числа, а не строки из отчёта
        raw = json.loads(blocks[-1])
        keys = ("input_i", "input_tp", "input_lra", "input_thresh", "target_offset")
        values = {key: float(raw[key]) for key in keys}
    except (ValueError, KeyError, TypeError):
        return None
    return values if all(math.isfinite(v) for v in values.values()) else None


def loudnorm_filter(measured):
    if not measured:
        return "loudnorm=I=-14:TP=-1.5:LRA=11"
    return (
        "loudnorm=I=-14:TP=-1.5:LRA=11:"
        f"measured_I={measured['input_i']:.2f}:measured_TP={measured['input_tp']:.2f}:"
        f"measured_LRA={measured['input_lra']:.2f}:measured_thresh={measured['input_thresh']:.2f}:"
        f"offset={measured['target_offset']:.2f}:linear=true"
    )


INSERT_PRESETS = {"top": ("(W-w)/2", str(SAFE["top"] + 20)), "bottom": ("(W-w)/2", str(SAFE["bottom"] - 460))}


def inserts_chain(project, plan, segments, last, first_slot):
    inputs, graph = [], []
    for index, item in enumerate(plan.get("inserts", [])):
        interval = map_interval(float(item["s"]), float(item["e"]), segments)
        if not interval:
            continue
        path = media_file(project, item["file"])
        width = int(number(item.get("width", 480), 50, W, "inserts.width"))
        if item.get("pos") in INSERT_PRESETS:
            x, y = INSERT_PRESETS[item["pos"]]
        else:
            x = str(int(number(item.get("x", 90), 0, W, "inserts.x")))
            y = str(int(number(item.get("y", 240), 0, H, "inserts.y")))
        slot = first_slot + len(inputs) // 8
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
    plan["face"] = clean_face(plan.get("face"))
    for key, maximum in (("keep", 80), ("cards", 400), ("inserts", 20)):
        limit_count(plan.get(key), maximum, key)
    limit_count((plan.get("split") or {}).get("panels"), 20, "split.panels")
    name = re.sub(r"[^\w\-]+", "_", plan.get("name", "reel"), flags=re.U).strip("_") or "reel"
    workdir = os.path.join(project, "_монтаж", name)
    if not inside(project, workdir):
        sys.exit("Рабочая папка вне проекта.")
    os.makedirs(workdir, exist_ok=True)
    own_output(project, workdir)
    require_no_links(project, os.path.join(workdir, "fonts")) if os.path.isdir(os.path.join(workdir, "fonts")) else None
    for name in ("base.mp4", "mix.wav", "final.mp4", "subs.ass", "subs-behind.ass", "fonts", "cut-plan.json"):
        own_output(project, os.path.join(workdir, name))  # не пишем по ссылкам, ведущим за пределы проекта
    source = media_file(project, plan["source"])
    duration = float(probe(source)["format"]["duration"])
    transcript_path = os.path.join(workdir, "transcript.json")
    words = load_json(transcript_path)["words"] if os.path.isfile(transcript_path) else []
    segments = snap_segments(plan.get("keep") or [[0, duration]], words, duration)
    print("Куски (сек в исходнике):", [[round(a, 2), round(b, 2)] for a, b in segments])
    base = build_base(project, plan, workdir, segments)
    cards = make_cards(plan, segments)
    windows = layouts.plan_splits(project, plan, map_interval, segments)
    style_plan = plan.get("style", {})
    # Маска человека (mask.mp4 рядом с base.mp4, её делает segment.py): слово-тема «Афиши» встаёт за человека
    mask_file = os.path.join(workdir, "mask.mp4")
    use_mask = style_plan.get("preset") == "afisha" and os.path.isfile(mask_file) and not windows and not plan.get("inserts")
    if style_plan.get("preset") == "afisha" and not use_mask:
        print("Маски человека нет: слово-тема «Афиши» встанет над головой, а не за ней (маска: nabor/references/ustanovka.md, «Маска человека»).")
    copy_fonts(project, FONTS_SRC, os.path.join(workdir, "fonts"))
    hf = None
    if use_mask and style_plan.get("engine", "auto") != "ass" and afisha_hf.hf_available():
        try:  # Афиша как у Монтажки: два слоя HyperFrames; не получилось, ниже запасной путь на ASS
            hf = afisha_hf.prepare(project, workdir, cards, segments, words, style_plan, float(probe(base)["format"]["duration"]))
        except afisha_hf.HFError as error:
            print(f"Афиша через HyperFrames не вышла ({error}). Собираю запасным путём (субтитры ASS).")
    elif style_plan.get("preset") == "afisha" and use_mask:
        reason = "выбран запасной путь (style.engine: ass)" if style_plan.get("engine") == "ass" else "HyperFrames (Node 22+) не найден"
        print(f"{reason}: Афиша соберётся субтитрами ASS, без побуквенного проявления и свечения.")
    if not hf:
        write_text(project, os.path.join(workdir, "subs.ass"), build_ass(cards, style_plan, windows, plan.get("face"), use_mask, "front"))
        if use_mask:
            write_text(project, os.path.join(workdir, "subs-behind.ass"), build_ass(cards, style_plan, windows, plan.get("face"), True, "behind"))
    mix = mix_audio(project, plan, workdir, base)
    if hf:
        afisha_hf.add_sfx(project, workdir, hf)
    loudness = loudnorm_filter(measure_loudness(mix))
    split_inputs, split_graph, last = layouts.split_graph(windows, "vs", 1)
    insert_inputs, graph, last = inserts_chain(project, plan, segments, last, split_inputs.count("-i") + 1)
    extra_inputs = split_inputs + insert_inputs
    if hf:
        hf_inputs, hf_graph = afisha_hf.inputs_and_graph(hf, extra_inputs.count("-i") + 1)
        extra_inputs = extra_inputs + hf_inputs
        video_graph = hf_graph
    elif use_mask:
        mask_slot = extra_inputs.count("-i") + 1
        extra_inputs = extra_inputs + ["-i", "mask.mp4"]
        video_graph = ["[0:v]null[vs]"] + split_graph + graph + [
            f"[{last}]ass=filename=subs-behind.ass:fontsdir=fonts[bg]",
            f"[0:v][{mask_slot}:v]alphamerge[person]",
            "[bg][person]overlay=format=auto[fg]",
            "[fg]ass=filename=subs.ass:fontsdir=fonts[vout]"]
    else:
        video_graph = ["[0:v]null[vs]"] + split_graph + graph + [f"[{last}]ass=filename=subs.ass:fontsdir=fonts[vout]"]
    audio_slot = extra_inputs.count("-i") + 1
    final = os.path.join(workdir, "final.mp4")
    ffmpeg_ok(
        ["-i", "base.mp4", *extra_inputs, "-i", "mix.wav", "-filter_complex", ";".join(video_graph),
         "-map", "[vout]", "-map", f"{audio_slot}:a", "-map_metadata", "-1", "-af", loudness, "-c:v", "libx264", "-crf", "18",
         "-preset", "medium", "-pix_fmt", "yuv420p", "-r", "30", "-c:a", "aac", "-b:a", "192k", "-ar", "48000",
         "-movflags", "+faststart", "-shortest", "final.mp4"],
        cwd=workdir,
    )
    cut_plan = json.dumps({"segments": segments, "cards": cards, "splits": [
            {"a": w["a"], "b": w["b"], "seam": w["seam"], "y0": w["y0"]} for w in windows],
            "preset": plan.get("style", {}).get("preset", "classic"),
            "engine": "hyperframes" if hf else "ass",
            "hf_center": hf["center"] if hf else None,
            "hf_front": hf["front"] if hf else None,
            "text_color": plan.get("style", {}).get(
                "text", "#F3EBDD" if plan.get("style", {}).get("preset") == "afisha" else "#FFFFFF"),
            "main_color": plan.get("style", {}).get("main", plan.get("style", {}).get("text", "#F3EBDD")),
            "face_top": (plan.get("face") or {}).get("y")}, ensure_ascii=False, indent=1)
    write_text(project, os.path.join(workdir, "cut-plan.json"), cut_plan)
    print(f"Готово к проверке: {final}")


def export(project, plan_path):
    plan = load_json(plan_path)
    name = re.sub(r"[^\w\-]+", "_", plan.get("name", "reel"), flags=re.U).strip("_") or "reel"
    final = os.path.join(project, "_монтаж", name, "final.mp4")
    if not os.path.isfile(final):
        sys.exit("Сначала собери ролик (build) и пройди проверку критика.")
    own_output(project, final)
    out_dir = own_output(project, os.path.join(project, "готово"))
    os.makedirs(out_dir, exist_ok=True)
    target, version = os.path.join(out_dir, f"{name}.mp4"), 1
    while os.path.exists(target):  # чужие и прошлые файлы не перезаписываем
        version += 1
        target = os.path.join(out_dir, f"{name}-v{version}.mp4")
    with open(final, "rb") as handle:
        write_bytes(project, target, handle.read())
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
