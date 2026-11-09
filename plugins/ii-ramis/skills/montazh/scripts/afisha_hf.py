"""Афиша через HyperFrames: два прозрачных слоя (слово-тема ЗА человеком и таблички ПЕРЕД ним) и сборка ffmpeg.

Это тот же приём, что у настоящей Афиши Монтажки (behind.html + page.html, GSAP, кегли и тайминги из ролика Эрики 13.10):
  * слово-тема огромное, тяжёлое (Druk Medium ~400 px), кремовое 78 %, проявляется по буквам от центра за 0,3 с,
    может быть зачёркнуто красной полосой;
  * над ним человек (маска), перед ним: тонкая строка по словам (Benzin 34 px), главное слово (Druk Bold 160 px,
    проявление 0,13 с с подъёмом 12 px), рукописное слово под углом −7°, свечение кремовым;
  * медленный наезд 1.0→1.04 (в нечётных кусках 1.05→1.07, чтобы склейки не были видны), тихие удар и «вжух».
Если HyperFrames или сеть недоступны, montage.py сам откатывается на ASS (layouts.py). Только стандартная библиотека."""
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

from common import H, W, SAFE, ffmpeg_ok, number, own_output, probe, require_no_links, write_text

HERE = Path(__file__).resolve().parent
SKILL = HERE.parent
HF_VERSION = "0.9.19"
HF_CMD = ["npx", "--yes", f"hyperframes@{HF_VERSION}"]
GSAP_URL = "https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js"
USER_FONTS = Path(os.environ.get("II_RAMIS_HOME") or Path.home() / ".ii-ramis") / "fonts"
OFL_FONTS = SKILL / "fonts"
SFX = SKILL / "assets" / "sfx"
PAID_FILES = ("DrukCyr-Medium.ttf", "DrukCyr-Bold.ttf", "Benzin-Bold.ttf", "Denistina-Regular.ttf")

# Кегли и шрифты по эталону Монтажки (paid) и свободные аналоги OFL. size: максимальный кегль, fit уменьшает под ширину.
FONT_SETS = {
    "paid": {"dir": USER_FONTS, "theme": ("DrukCyr-Medium.ttf", 400), "main": ("DrukCyr-Bold.ttf", 160),
             "over": ("Benzin-Bold.ttf", 34), "hand": ("Denistina-Regular.ttf", 140)},
    "ofl": {"dir": OFL_FONTS, "theme": ("FiraSansExtraCondensed-Medium.ttf", 400), "main": ("FiraSansExtraCondensed-ExtraBold.ttf", 160),
            "over": ("RubikMonoOne-Regular.ttf", 30), "hand": ("BadScript-Regular.ttf", 120)},
}


class HFError(Exception):
    """HyperFrames не получилось, montage.py уйдёт на запасной ASS-путь."""


def choose_fonts(style):
    wanted = style.get("fonts", "auto")
    paid_ok = all((USER_FONTS / name).is_file() and not (USER_FONTS / name).is_symlink() for name in PAID_FILES)
    kind = "paid" if (wanted in ("auto", "paid") and paid_ok) else "ofl"
    return kind, FONT_SETS[kind]


def hf_available():
    if not (shutil.which("node") and shutil.which("npx")):
        return False
    try:
        version = subprocess.run(["node", "-v"], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=20).stdout.decode()
        return int(re.match(r"v(\d+)", version).group(1)) >= 22
    except (OSError, subprocess.SubprocessError, AttributeError, ValueError):
        return False


def tokens(text):
    return [t for t in re.split(r"\s+", str(text or "").strip()) if t]


def norm(word):
    return re.sub(r"[^\w]+", "", word.lower().replace("ё", "е"), flags=re.U)


def cut_time(moment, segments):
    offset = 0.0
    for start, end in segments:
        if start <= moment <= end:
            return offset + (moment - start)
        offset += end - start
    return None


def words_in_cut(words, segments):
    result = []
    for item in words:
        start = cut_time(float(item["s"]) + 0.001, segments)
        if start is not None:
            result.append({"n": norm(item["w"]), "t": start})
    return result


def find_times(parts, spoken, start, end, fallback_from, fallback_to):
    """Время появления каждого слова: по расшифровке (первое подходящее слово дальше по тексту), иначе поровну."""
    pool = [w for w in spoken if start - 0.25 <= w["t"] <= end + 0.1]
    pointer, times = 0, []
    for index, part in enumerate(parts):
        key = norm(part)
        hit = None
        for position in range(pointer, len(pool)):
            word = pool[position]["n"]
            if word and key and (word == key or (len(key) >= 4 and word[:4] == key[:4])):
                hit = position
                break
        if hit is None:
            span = fallback_to - fallback_from
            times.append(fallback_from + span * index / max(1, len(parts)))
        else:
            times.append(max(start, pool[hit]["t"]))
            pointer = hit + 1
    return times


def build_data(cards, spoken, style, kind, fonts):
    """Данные для обоих слоёв: таблички (передний слой) и слова-темы (задний слой)."""
    front, themes = [], []
    for card in cards:
        a, e = card["s"], card["e"]
        span = e - a
        thin_parts = tokens(card.get("over"))
        main_parts = tokens(card.get("main"))
        thin_t = find_times(thin_parts, spoken, a, e, a, a + span * 0.4)
        main_t = find_times(main_parts[:1], spoken, a, e, a + span * 0.45, e) if main_parts else []
        entry = {"a": round(a, 3), "e": round(e, 3),
                 "thin": [{"w": w, "t": round(t, 3)} for w, t in zip(thin_parts, thin_t)],
                 "main": {"w": " ".join(main_parts), "t": round(main_t[0], 3)} if main_parts else None,
                 "hand": None}
        hand = card.get("hand")
        if hand:
            hand_t = find_times(tokens(hand)[:1], spoken, a, e, (main_t[0] if main_t else a) + 0.4, e)[0]
            entry["hand"] = {"w": hand, "t": round(max(hand_t, (main_t[0] if main_t else a) - 0.2), 3),
                             "below": bool(card.get("hand_below"))}
        front.append(entry)
        theme = str(card.get("theme") or "").strip()
        if theme:
            if themes and norm(themes[-1]["w"]) == norm(theme) and a - themes[-1]["e"] < 1.0:
                themes[-1]["e"] = round(e, 3)
                themes[-1]["strike_at"] = themes[-1]["strike_at"] or None
            else:
                strike_at = None
                if card.get("strike"):
                    hit = find_times(tokens(theme)[:1], spoken, a, e, a + 0.5, e)[0]
                    strike_at = round(hit + 0.35, 3)
                themes.append({"w": theme.upper(), "a": round(a, 3), "e": round(e, 3), "strike_at": strike_at})
    # слово живёт до начала следующей темы: без «дырок» между табличками одного плана
    for current, following in zip(themes, themes[1:]):
        current["e"] = round(max(current["e"], following["a"] - 0.02), 3)
    return {"front": front, "themes": themes}


def head_top(workdir, moment, zoom_at):
    """Верх головы (px из 1920) по маске в момент moment: первая строка, где белого заметно. Нет маски: None."""
    mask = Path(workdir) / "mask.mp4"
    if not mask.is_file():
        return None
    small_w, small_h = 108, 192
    result = subprocess.run(
        ["ffmpeg", "-v", "error", "-protocol_whitelist", "file,pipe", "-ss", f"{max(0.0, moment):.2f}", "-i", str(mask),
         "-frames:v", "1", "-vf", f"scale={small_w}:{small_h},format=gray", "-f", "rawvideo", "-"],
        stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=60)
    frame = result.stdout
    if len(frame) < small_w * small_h:
        return None
    for row in range(small_h):
        if sum(1 for value in frame[row * small_w:(row + 1) * small_w] if value > 128) >= 4:
            y = row * (H / small_h)
            zoom = zoom_at(moment)
            return H / 2 - (H / 2 - y) * zoom  # наезд сдвигает верх головы выше
    return None


def write_layers(layer_dir, kind, fonts, data, style, duration):
    """index.html каждого слоя: статичная разметка + данные JSON, анимация описана в одном месте (ANIM_JS)."""
    layer_dir.mkdir(parents=True, exist_ok=True)
    face_rules = []
    for role in ("theme", "main", "over", "hand"):
        name, _ = fonts[role]
        source = fonts["dir"] / name
        target = layer_dir / "fonts" / name
        target.parent.mkdir(exist_ok=True)
        if target.is_symlink() or not source.is_file():
            raise HFError(f"нет шрифта {name}")
        shutil.copyfile(source, target)
        face_rules.append(f"@font-face{{font-family:Af{role};src:url(fonts/{name})}}")
    page = (PAGE_HEAD.replace("__FONTS__", "".join(face_rules)).replace("__GSAP__", GSAP_URL)
            .replace("__DURATION__", f"{duration:.3f}"))
    return page, layer_dir


def layer_html(page, data, which, config):
    payload = json.dumps({**data, "layer": which, "cfg": config}, ensure_ascii=False).replace("</", "<\\/").replace("<!--", "<\\!--")
    return page.replace("__DATA__", payload)


PAGE_HEAD = """<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>Афиша</title>
<script src="__GSAP__" integrity="sha384-sG0Hv1tP1lZCk9KQmrIbY/XNwi+OY84GQqhMscbnsoBFqAz8KNCil1kvfL3Hbbk2" crossorigin="anonymous"></script>
<style>__FONTS__
html,body{margin:0;width:1080px;height:1920px;background:transparent;overflow:hidden}
#root{position:relative;width:1080px;height:1920px;overflow:hidden}
.ghost{position:absolute;left:60px;width:960px;text-align:center;opacity:0}
.word{font-family:Aftheme;line-height:.86;text-transform:uppercase;letter-spacing:-.005em;white-space:nowrap;position:relative;display:inline-block}
.word span{display:inline-block;opacity:0}
.strike{position:absolute;left:0;top:52%;height:26px;width:100%;transform-origin:left center;transform:scaleX(0)}
.card{position:absolute;left:0;right:0;display:flex;flex-direction:column;align-items:center;opacity:0}
.thinwrap{width:600px;text-align:center}
.thin{font-family:Afover;line-height:1.1;text-transform:uppercase;letter-spacing:.02em;text-align:center;display:inline-block}
.thin span{opacity:0}
.mainwrap{position:relative;width:660px;text-align:center;margin-top:-8px}
.main{font-family:Afmain;line-height:.9;text-transform:uppercase;white-space:nowrap;display:inline-block;opacity:0}
.hand{font-family:Afhand;line-height:1;opacity:0;white-space:nowrap}
.hand.row{margin-bottom:-34px;transform:rotate(-7deg)}
.hand.below{margin-top:-46px;transform:rotate(-7deg)}
</style></head><body>
<div id="root" data-composition-id="main" data-start="0" data-width="1080" data-height="1920" data-duration="__DURATION__"></div>
<script>
const D = __DATA__;
const clamp = (v) => Math.min(Math.max(v, 0), 1);
const root = document.getElementById('root');
const cfg = D.cfg;
const make = (tag, cls, text, parent) => { const el = document.createElement(tag); if (cls) el.className = cls; if (text !== undefined) el.textContent = text; if (parent) parent.appendChild(el); return el; };
const shrink = (el, limit, minShare) => { // кегль вниз, пока слово не влезет в ширину
  const base = parseFloat(getComputedStyle(el).fontSize); let size = base;
  while (el.scrollWidth > limit + 0.5 && size > base * minShare) { size *= 0.97; el.style.fontSize = size + 'px'; }
};
const grow = (el, target, maxSize) => {
  let size = parseFloat(getComputedStyle(el).fontSize);
  while (el.scrollWidth < target && size * 1.03 <= maxSize) { size *= 1.03; el.style.fontSize = size + 'px'; }
  while (el.scrollWidth > 960 && size > 100) { size *= 0.98; el.style.fontSize = size + 'px'; }
};
function buildBehind(tl) {
  D.themes.forEach((theme) => {
    const ghost = make('div', 'ghost', undefined, root);
    const word = make('div', 'word', undefined, ghost);
    word.style.fontSize = cfg.theme_size + 'px'; word.style.color = cfg.theme_color;
    const letters = [...theme.w].map((ch) => make('span', '', ch, word));
    let strike = null;
    if (theme.strike_at) { strike = make('div', 'strike', undefined, word); strike.style.background = cfg.main_color; }
    shrink(word, 960, 0.5);
    grow(word, 880, cfg.theme_max); // короткое слово тянем до ~880 px шириной, иначе голова закроет его целиком
    const box = word.getBoundingClientRect();
    ghost.style.top = Math.round(cfg.theme_center - box.height / 2) + 'px';
    tl.set(ghost, { opacity: 1 }, theme.a);
    const mid = (letters.length - 1) / 2;
    letters.forEach((span, k) => { // от центра к краям: 0,3 с каждая, разброс до 0,35 с
      const d = Math.abs(k - mid) / Math.max(mid, 1) * 0.35;
      tl.fromTo(span, { opacity: 0 }, { opacity: cfg.theme_opacity, duration: 0.3, ease: 'power3.out' }, theme.a + d);
    });
    if (strike) tl.fromTo(strike, { scaleX: 0 }, { scaleX: 1, duration: 0.25, ease: 'power3.out' }, theme.strike_at);
    tl.set(ghost, { opacity: 0 }, theme.e);
  });
}
function buildFront(tl) {
  D.front.forEach((card) => {
    const el = make('div', 'card', undefined, root);
    el.style.bottom = (1920 - cfg.bottom) + 'px';
    let thinSpans = [], hand = null, main = null;
    if (card.thin.length) {
      const wrap = make('div', 'thinwrap', undefined, el); const thin = make('div', 'thin', undefined, wrap);
      thin.style.fontSize = cfg.over_size + 'px'; thin.style.color = cfg.main_color; thin.style.textShadow = cfg.glow_thin;
      card.thin.forEach((item, i) => { thinSpans.push(make('span', '', item.w, thin)); if (i < card.thin.length - 1) thin.appendChild(document.createTextNode(' ')); });
    }
    if (card.hand && !card.hand.below) { hand = make('div', 'hand row', card.hand.w, el); }
    if (card.main) {
      const wrap = make('div', 'mainwrap', undefined, el); main = make('div', 'main', card.main.w, wrap);
      main.style.fontSize = cfg.main_size + 'px'; main.style.color = cfg.main_color; main.style.textShadow = cfg.glow_main;
    }
    if (card.hand && card.hand.below) { hand = make('div', 'hand below', card.hand.w, el); }
    if (hand) { hand.style.fontSize = cfg.hand_size + 'px'; hand.style.color = cfg.hand_color; hand.style.textShadow = cfg.glow_hand; }
    if (main) shrink(main, cfg.main_width, 0.5);
    tl.set(el, { opacity: 1 }, card.a);
    thinSpans.forEach((span, i) => tl.fromTo(span, { opacity: 0 }, { opacity: 1, duration: 0.1, ease: 'none' }, Math.max(card.a, card.thin[i].t - 0.03)));
    if (main) tl.fromTo(main, { opacity: 0, y: 12 }, { opacity: 1, y: 0, duration: 0.13, ease: 'power3.out' }, Math.max(card.a, card.main.t - 0.03));
    if (hand) tl.fromTo(hand, { opacity: 0 }, { opacity: 1, duration: 0.18, ease: 'power3.out' }, Math.max(card.a, card.hand.t - 0.03));
    tl.to(el, { opacity: 0, duration: 0.1, ease: 'none' }, Math.max(card.a, card.e - 0.1));
    tl.set(el, { opacity: 0 }, card.e);
  });
}
document.fonts.ready.then(() => {
  const tl = gsap.timeline({ paused: true });
  if (D.layer === 'behind') buildBehind(tl); else buildFront(tl);
  window.__timelines['main'] = tl;
});
</script></body></html>
"""


def zoom_plan(segments, enabled):
    """Наезд по кускам нарезки: чётные 1.00→1.04, нечётные 1.05→1.07 (склейка прячется сменой крупности)."""
    plan, offset = [], 0.0
    for index, (start, end) in enumerate(segments):
        length = end - start
        z0, z1 = (1.00, 1.04) if index % 2 == 0 else (1.05, 1.07)
        if not enabled:
            z0 = z1 = 1.0
        plan.append((offset, offset + length, z0, z1))
        offset += length
    return plan


def zoom_value(plan, moment):
    for a, b, z0, z1 in plan:
        if a <= moment < b:
            return z0 + (z1 - z0) * (moment - a) / max(b - a, 1e-6)
    return plan[-1][3] if plan else 1.0


def zoom_expr(plan):
    """Выражение ffmpeg для масштаба в момент t (eval=frame): ступенчато по кускам, внутри куска линейно."""
    expr = f"{plan[-1][3]:.4f}" if plan else "1"
    for a, b, z0, z1 in reversed(plan):
        expr = f"if(lt(t,{b:.4f}),{z0:.4f}+({z1 - z0:.4f})*(t-{a:.4f})/{max(b - a, 1e-6):.4f},{expr})"
    return expr


def zoom_filter(plan, label_in, label_out):
    z = zoom_expr(plan)
    return (f"[{label_in}]scale=w='trunc({W}*({z})/2)*2':h='trunc({H}*({z})/2)*2':eval=frame:flags=bicubic,"
            f"crop={W}:{H}:(iw-{W})/2:(ih-{H})/2,setsar=1[{label_out}]")


def hf_env(neutral):
    """Окружение для npx: официальный реестр, пустые пользовательские и системные настройки npm, без статистики."""
    empty_config = Path(neutral) / "empty-npm-config"
    empty_config.write_text("", encoding="utf-8")
    dropped = ("NODE_OPTIONS", "NODE_PATH")  # чужой код в процессе node
    env = {name: value for name, value in os.environ.items() if not name.upper().startswith("NPM_CONFIG_") and name.upper() not in dropped}
    env.update({
        "NPM_CONFIG_REGISTRY": "https://registry.npmjs.org/", "NPM_CONFIG_USERCONFIG": str(empty_config),
        "NPM_CONFIG_GLOBALCONFIG": str(empty_config), "NPM_CONFIG_UPDATE_NOTIFIER": "false",
        "HYPERFRAMES_NO_TELEMETRY": "1", "HYPERFRAMES_NO_UPDATE_CHECK": "1", "DO_NOT_TRACK": "1", "DISABLE_TELEMETRY": "1",
    })
    return env


def render_layer(layer_dir, frames_dir, log):
    if frames_dir.exists():
        raise HFError("папка кадров уже есть (внутренняя ошибка)")
    # npx запускается из пустой временной папки, а не из папки проекта ученика: чужие настройки npm и package.json не подменят пакет.
    command = [*HF_CMD, "render", str(Path(layer_dir).resolve()), "--format", "png-sequence", "--workers", "1",
               "-o", str(Path(frames_dir).resolve()), "--quiet"]
    try:
        with tempfile.TemporaryDirectory(prefix="ii-ramis-hf-") as neutral:
            result = subprocess.run(command, cwd=neutral, env=hf_env(neutral), stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=1500)
    except (OSError, subprocess.SubprocessError) as error:
        raise HFError(f"HyperFrames не запустился: {error}") from error
    tail = result.stdout.decode("utf-8", "replace")[-800:]
    if result.returncode != 0 or not any(frames_dir.glob("frame_*.png")):
        last = tail.strip().splitlines()[-1] if tail.strip() else "пустой ответ"
        raise HFError(f"HyperFrames не отрисовал слой: {last}")
    log(f"слой {layer_dir.name}: {len(list(frames_dir.glob('frame_*.png')))} кадров")


def prepare(project, workdir, cards, segments, words, style, duration, log=print):
    """Рисует оба слоя. Возвращает описание для сборки или поднимает HFError (тогда montage.py берёт ASS)."""
    workdir = Path(workdir)
    root = workdir / "afisha-hf"
    own_output(project, str(root))
    if root.exists():
        require_no_links(project, str(root))  # в рабочей папке Афиши ссылок быть не должно
    kind, fonts = choose_fonts(style)
    spoken = words_in_cut(words, segments)
    data = build_data(cards, spoken, style, kind, fonts)
    if not data["front"]:
        raise HFError("в плане нет ни одной таблички")
    push = style.get("push", True) is not False
    zplan = zoom_plan(segments, push)
    zoom_at = lambda moment: zoom_value(zplan, moment)
    bottom = int(number(style.get("bottom", 1535), 1200, 1700, "style.bottom"))
    tops = [head_top(workdir, theme["a"] + 0.3, zoom_at) for theme in data["themes"]]
    known = [t for t in tops if t is not None]
    if "theme_y" in style:
        center = int(number(style["theme_y"], 150, 1100, "style.theme_y"))
    elif known:
        center = int(min(known) + 250)  # у лба: верх букв чуть ниже макушки, как у эталона (~+250 px от верха головы)
    else:
        raise HFError("нет маски человека, слово-тема не встанет за голову")
    theme_size = fonts["theme"][1]
    over_size, main_size, hand_size = fonts["over"][1], fonts["main"][1], fonts["hand"][1]
    main_color = style.get("main", "#8A0A12")
    cream = style.get("text", "#F3EBDD")
    config = {
        "theme_size": theme_size, "theme_max": 560, "over_size": over_size, "main_size": main_size, "hand_size": hand_size,
        "theme_color": cream, "theme_opacity": 0.78, "theme_center": center, "main_color": main_color,
        "hand_color": style.get("hand", main_color), "bottom": bottom, "main_width": 620,
        "glow_main": "0 0 22px rgba(243,235,221,.5)",
        "glow_thin": "0 0 5px rgba(243,235,221,.9),0 0 14px rgba(243,235,221,.6)",
        "glow_hand": "0 0 6px rgba(243,235,221,.95),0 0 18px rgba(243,235,221,.8)",
    }
    run = f"run-{int(time.time())}"  # каждый запуск в свою папку: старые кадры не удаляем и не перепутываем
    for which in ("behind", "front"):
        page, layer_dir = write_layers(root / which, kind, fonts, data, style, duration)
        write_text(project, str(layer_dir / "index.html"), layer_html(page, data, which, config))
        render_layer(layer_dir, root / run / f"{which}-frames", log)
    log(f"Афиша: шрифты «{'Druk/Benzin/Denistina' if kind == 'paid' else 'свободные аналоги'}», тем {len(data['themes'])}, табличек {len(data['front'])}")
    return {"kind": kind, "zoom": zplan, "data": data, "run": run, "behind": f"afisha-hf/{run}/behind-frames/frame_%06d.png",
            "front": f"afisha-hf/{run}/front-frames/frame_%06d.png", "center": center}


def inputs_and_graph(prep, first_slot):
    """Входы ffmpeg и граф: наезд на основу и маску, слой за человеком, человек по маске, слой перед человеком."""
    mask_slot, behind_slot, front_slot = first_slot, first_slot + 1, first_slot + 2
    inputs = ["-i", "mask.mp4", "-framerate", "30", "-i", prep["behind"], "-framerate", "30", "-i", prep["front"]]
    graph = [
        zoom_filter(prep["zoom"], "0:v", "bgz"),
        zoom_filter(prep["zoom"], f"{mask_slot}:v", "mz"),
        "[bgz]split=2[bga][bgb]",
        f"[bgb][mz]alphamerge[person]",
        f"[bga][{behind_slot}:v]overlay=format=auto:eof_action=pass[withword]",
        "[withword][person]overlay=format=auto[withperson]",
        f"[withperson][{front_slot}:v]overlay=format=auto:eof_action=pass[vout]",
    ]
    return inputs, graph


def sfx_list(prep):
    """Тихие звуки как у эталона: удар на зачёркивании, «вжух» на входе второй и следующих тем."""
    events = []
    for index, theme in enumerate(prep["data"]["themes"]):
        if theme.get("strike_at"):
            events.append((SFX / "impact" / "impact-sub-drop-tight.wav", theme["strike_at"] - 0.02))
        if index > 0:
            events.append((SFX / "whoosh" / "whoosh-air-up-short.wav", theme["a"] - 0.05))
    return [(path, max(0.0, t)) for path, t in events if path.is_file()]


def add_sfx(project, workdir, prep, mix_name="mix.wav", volume=0.3):
    events = sfx_list(prep)
    if not events:
        return
    inputs, parts, labels = ["-i", mix_name], [], ""
    for index, (path, moment) in enumerate(events, start=1):
        inputs += ["-i", str(path)]
        delay = int(moment * 1000)
        parts.append(f"[{index}:a]aresample=48000,adelay={delay}|{delay},volume={volume}[s{index}]")
        labels += f"[s{index}]"
    graph = ";".join(parts) + f";[0:a]{labels}amix=inputs={len(events) + 1}:duration=first:normalize=0[out]"
    out = "mix-sfx.wav"
    own_output(project, os.path.join(workdir, out))
    ffmpeg_ok([*inputs, "-filter_complex", graph, "-map", "[out]", "-ac", "2", "-ar", "48000", out], cwd=str(workdir))
    os.replace(os.path.join(workdir, out), os.path.join(workdir, mix_name))
