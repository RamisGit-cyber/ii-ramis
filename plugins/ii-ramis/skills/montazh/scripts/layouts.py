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
    """Таблички «Афиши». Слои одной таблички:
    theme: огромное тонкое светлое слово-тема. С маской человека (mask=True) оно стоит ЗА человеком: голова перекрывает буквы
           (слой "behind"). Без маски слово честно ставится над головой (слой "front", запасной вариант).
    main: узкое жирное главное слово перед человеком, надстрочник over (широкий мелкий) и слово-акцент hand (рукописное)."""
    cream = hex_to_ass(style.get("text", "#F3EBDD"))
    accent = hex_to_ass(style.get("accent", "#FFD400"))
    main_color = hex_to_ass(style.get("main", style.get("text", "#F3EBDD")))
    over_color = hex_to_ass(style.get("over", style.get("main", style.get("text", "#F3EBDD"))))
    bottom = min(int(number(style.get("bottom", 1440), 400, 1900, "style.bottom")), SAFE["bottom"] - 40)
    free_top = SAFE["top"] + 20
    free_bottom = (int(face["y"]) - 20) if face else 520
    lines = []
    for card in cards:
        start, end = ass_time(card["s"]), ass_time(card["e"])
        if card.get("theme") and mask and layer == "behind":
            word = clean_text(card["theme"]).upper()
            size = int(min(720, 1000 / max(1, len(word) * 0.56)))  # огромное: почти во всю ширину кадра, голова закрывает середину
            head_mid = (int(face["y"]) + int(face["h"]) * 0.08) if face else 700  # у макушки: буквы торчат над и по бокам головы
            y_center = int(min(max(head_mid, SAFE["top"] + size * 0.5), SAFE["bottom"] - size * 0.5))
            lines.append(_event(start, end, "Theme", 540, y_center + int(size * 0.35), 2, f"\\fs{size}\\alpha&H18&", cream, word, fade=(260, 160)))
        if layer != "front":
            continue
        stack_bottom = bottom
        main_size = 120
        if card.get("main"):
            word = clean_text(card["main"]).upper()
            size = int(min(150, 600 / max(1, len(word) * 0.46)))  # до 150 px, но не шире ~55–60 % кадра
            main_size = size
            lines.append(_event(start, end, "Main", 540, stack_bottom, 2, f"\\fs{size}", main_color, word))
            stack_bottom -= int(size * 1.12)
        if card.get("over") and bottom + 32 + 22 <= SAFE["bottom"] + 6:
            # надстрочник стоит ПОД главным словом (над ним был бы рот и подбородок); нет места до зоны кнопок Instagram, его не ставим
            text = clean_text(card["over"]).upper()
            size = 32
            lines.append(_event(start, end, "Over", 540, bottom + size + 22, 2, f"\\fs{size}\\fsp6", over_color, text))
        if card.get("hand"):
            text = clean_text(card["hand"])
            size = int(min(130, 420 / max(1, len(text) * 0.4)))
            # слово-акцент пересекает правый нижний угол главного слова (как на афише), а не стоит над ртом
            main_text = clean_text(card.get("main", ""))
            main_width = int(main_size * 0.46 * len(main_text))
            hand_x = min(540 + main_width // 2 - 110, W - SAFE["right"] - size * len(text) // 3)
            lines.append(_event(start, end, "Hand", max(hand_x, 400), bottom + 6, 1, f"\\fs{size}\\frz-5", accent, text))
        if card.get("theme") and not mask and free_bottom - free_top >= 140:
            word = clean_text(card["theme"]).upper()
            height = free_bottom - free_top
            size = int(min(300, height * 0.9, 640 / max(1, len(word) * 0.58)))
            lines.append(_event(start, end, "Theme", 540, free_top + height // 2 + size // 3, 2, f"\\fs{size}\\alpha&H30&", cream, word))
    return lines


def _event(start, end, style_name, x, y, align, tags, color, text, fade=(120, 120)):
    return (f"Dialogue: 0,{start},{end},{style_name},,0,0,0,,"
            f"{{\\an{align}\\pos({x},{y})\\fad({fade[0]},{fade[1]})\\1c{color}{tags}}}{text}")


AFISHA_STYLES = (
    ("Theme", "Onest Light", 0),
    ("Main", "Oswald Bold", 0),
    ("Over", "Rubik Mono One", 0),
    ("Hand", "Caveat", 0),
)
