"""Раскладки кадра: сплит-скрин (вставка сверху, говорящий снизу) и стиль «Афиша» (таблички из слов).

Используется montage.py. Цвета и шрифт ученика берутся из плана (style), иначе нейтральные.
"""
import sys

from common import H, SAFE, W, media_file, number, probe

IMAGE_FORMATS = {"image2", "png_pipe", "jpeg_pipe", "webp_pipe"}
SPLIT_GAP = 0  # субтитр сидит прямо над головой, на нижнем краю вставки


def plan_splits(project, plan, map_interval, segments):
    """Окна сплита: когда показываем вставку сверху, а говорящего снизу. Время в ролике после резки."""
    split = plan.get("split")
    if not split:
        return []
    seam = int(number(split.get("seam", 900), 600, 1250, "split.seam"))
    face = plan.get("face")
    if not face:
        sys.exit("Для сплита нужна рамка лица face в плане: по ней выбирается, какую часть кадра оставить снизу.")
    bottom_height = H - seam
    face_top, face_bottom = int(face["y"]), int(face["y"] + face["h"])
    window_top = max(0, min(face_top - 90, H - bottom_height))
    if face_bottom > window_top + bottom_height:
        sys.exit(f"Лицо не помещается в нижнюю часть сплита (высота {bottom_height}). Подними шов: split.seam меньше.")
    windows = []
    for panel in split.get("panels", []):
        interval = map_interval(float(panel["s"]), float(panel["e"]), segments)
        if not interval:
            continue
        path = media_file(project, panel["file"])
        names = set(probe(path)["format"]["format_name"].split(","))
        windows.append({"a": interval[0], "b": interval[1], "file": path, "image": bool(names & IMAGE_FORMATS),
                        "seam": seam, "y0": window_top})
    windows.sort(key=lambda w: w["a"])
    for current, following in zip(windows, windows[1:]):
        if current["b"] > following["a"]:
            current["b"] = following["a"]
    return windows


def split_graph(windows, last, first_input_index):
    """Фильтры сплита: вставка сверху на всю ширину, снизу кусок кадра с говорящим (без масштабирования, лицо целое)."""
    inputs, graph = [], []
    count = len(windows)
    if not count:
        return inputs, graph, last
    graph.append(f"[{last}]split={count + 1}[sb]" + "".join(f"[sc{i}]" for i in range(count)))
    last = "sb"
    for index, win in enumerate(windows):
        seam, hb = win["seam"], H - win["seam"]
        length = win["b"] - win["a"] + 0.5
        slot = first_input_index + index
        if win["image"]:
            inputs += ["-loop", "1", "-framerate", "30", "-t", f"{length + win['a']:.2f}", "-i", win["file"]]
            fit = ""
        else:
            inputs += ["-t", f"{length:.2f}", "-i", win["file"]]
            fit = "fps=30,"
        shift = f"+{win['a']:.3f}/TB"
        graph.append(
            f"[{slot}:v]{fit}scale={W}:{seam}:force_original_aspect_ratio=increase,crop={W}:{seam},setsar=1,"
            f"format=yuv420p" + ("" if win["image"] else f",setpts=PTS-STARTPTS{shift}") + f"[sp{index}]"
        )
        graph.append(f"[sc{index}]crop={W}:{hb}:0:{win['y0']}[sd{index}]")
        enable = f"enable='between(t,{win['a']:.2f},{win['b']:.2f})'"
        graph.append(f"[{last}][sp{index}]overlay=0:0:{enable}:eof_action=pass[sa{index}]")
        graph.append(f"[sa{index}][sd{index}]overlay=0:{seam}:{enable}:eof_action=pass[sx{index}]")
        last = f"sx{index}"
    return inputs, graph, last


def in_split(windows, start, end):
    middle = (start + end) / 2
    return next((w for w in windows if w["a"] <= middle <= w["b"]), None)


def card_pieces(windows, card, bottom):
    """Карточка режется по границам сплита: (начало, конец, нижний край). В сплите субтитр на шве, вне его — на обычном месте."""
    edges = sorted({card["s"], card["e"]} | {t for w in windows for t in (w["a"], w["b"]) if card["s"] < t < card["e"]})
    pieces = []
    for start, end in zip(edges, edges[1:]):
        if end - start < 0.08:
            continue
        window = in_split(windows, start, end)
        pieces.append((start, end, window["seam"] + SPLIT_GAP if window else bottom))
    return pieces


def afisha_lines(cards, style, face, ass_time, hex_to_ass, clean_text, mask=False, layer="front"):
    """Запасной путь «Афиши» (когда нет HyperFrames): те же кегли, цвета и позиции, что у Монтажки (см. afisha_hf.py), но без
    побуквенного проявления и свечения-тени. Слои одной таблички:
    theme: огромное тяжёлое слово-тема (400 px, кремовое 78 %). С маской человека (mask=True) оно стоит ЗА человеком (слой "behind"),
           без маски честно ставится над головой (слой "front").
    over: тонкая строка над главным словом; main: главное слово (160 px, не шире ~620 px); hand: рукописное, наклон −7°."""
    cream = hex_to_ass(style.get("text", "#F3EBDD"))
    main_color = hex_to_ass(style.get("main", "#8A0A12"))
    hand_color = hex_to_ass(style.get("hand", style.get("main", "#8A0A12")))
    glow = hex_to_ass(style.get("text", "#F3EBDD"), "60")
    bottom = int(number(style.get("bottom", 1535), 1200, 1700, "style.bottom")) - 18  # низ строки ASS чуть ниже низа букв
    free_top = SAFE["top"] + 20
    free_bottom = (int(face["y"]) - 20) if face else 520
    lines = []
    for card in cards:
        start, end = ass_time(card["s"]), ass_time(card["e"])
        if card.get("theme") and mask and layer == "behind":
            word = clean_text(card["theme"]).upper()
            size = int(min(560, 880 / max(1, len(word) * 0.46)))  # тяжёлый узкий шрифт: ~880 px шириной, иначе голова закроет слово целиком
            center = int(style["theme_y"]) if "theme_y" in style else (int(face["y"]) + 130 if face else 520)  # у лба: голова закрывает середину букв
            lines.append(_event(start, end, "Theme", 540, center + int(size * 0.36), 2, f"\\fs{size}\\alpha&H38&", cream, word, fade=(260, 100)))
        if layer != "front":
            continue
        main_size = 130
        if card.get("main"):
            word = clean_text(card["main"]).upper()
            main_size = int(min(160, 620 / max(1, len(word) * 0.42)))
            lines.append(_event(start, end, "Main", 540, bottom, 2, f"\\fs{main_size}\\bord1\\3c{glow}\\blur2", main_color, word, fade=(130, 100)))
        main_top = bottom - int(main_size * 0.92)
        if card.get("over"):
            text = clean_text(card["over"]).upper()
            lines.append(_event(start, end, "Over", 540, main_top - 2, 2, f"\\fs30\\fsp1\\bord1\\3c{glow}\\blur2", main_color, text))
        if card.get("hand"):
            text = clean_text(card["hand"])
            size = int(min(120, 560 / max(1, len(text) * 0.42)))
            lines.append(_event(start, end, "Hand", 540, main_top + 40, 2, f"\\fs{size}\\frz7\\bord2\\3c{glow}\\blur3", hand_color, text, fade=(180, 100)))
        if card.get("theme") and not mask and free_bottom - free_top >= 140:
            word = clean_text(card["theme"]).upper()
            height = free_bottom - free_top
            size = int(min(300, height * 0.9, 640 / max(1, len(word) * 0.58)))
            lines.append(_event(start, end, "Theme", 540, free_top + height // 2 + size // 3, 2, f"\\fs{size}\\alpha&H38&", cream, word))
    return lines


def _event(start, end, style_name, x, y, align, tags, color, text, fade=(120, 120)):
    return (f"Dialogue: 0,{start},{end},{style_name},,0,0,0,,"
            f"{{\\an{align}\\pos({x},{y})\\fad({fade[0]},{fade[1]})\\1c{color}{tags}}}{text}")


AFISHA_STYLES = (
    ("Theme", "Fira Sans Extra Condensed Medium", 0),
    ("Main", "Fira Sans Extra Condensed ExtraBold", 0),
    ("Over", "Rubik Mono One", 0),
    ("Hand", "Bad Script", 0),
)
