"""Regenerates the README art in assets/: animated SVGs drawn with the same face maths as web/js/themes.js.

    python3 assets/make_svgs.py

Each face frame is the real `pixLit` / `catLit` sampled on an OLED grid, encoded as one stroked path per frame
(one horizontal run per lit row segment). Animation is SMIL with discrete steps, so it stays pixel-exact and
renders inside GitHub's <img> sandbox (no scripts, no external CSS, no webfonts).
"""
import math
import random
from pathlib import Path

OUT = Path(__file__).parent
G, DIM = "#46ff86", "#0e2a18"  # themes.js
MONO = "ui-monospace,SFMono-Regular,Menlo,Consolas,'Liberation Mono',monospace"


# --- face maths, ported from web/js/themes.js ----------------------------------------------------------------
def sd_box(px, py, bx, by, r):
    qx, qy = abs(px) - bx + r, abs(py) - by + r
    return min(max(qx, qy), 0) + math.hypot(max(qx, 0), max(qy, 0)) - r


def eyes_lit(e, x, y):
    """pixLit's eyes at gaze 0 (the gaze is applied later as a whole-pixel translate)."""
    sc, op, hap = e.get("sc", 1), e.get("open", 1), e.get("hap", 0)
    hw, hh = 0.2 * sc, max(0.03, 0.24 * sc * op)
    er = min(hw, hh) * 0.6
    for s in (-1, 1):
        ex, ey = 1 + s * 0.4, 0.38
        if sd_box(x - ex, y - ey, hw, hh, er) > 0:
            continue
        smile = hap > 0.05 and ((x - ex) / (1.3 * hw)) ** 2 + ((y - ey - 1.1 * hh) / (1.2 * hh * hap)) ** 2 <= 1
        return not smile
    return False


def mouth_lit(m, x, y, min_h):
    o, w, r, t = m.get("o", 0), m.get("w", 0.3), m.get("r", 0), m.get("t", 0)
    mw, mh, dy = 0.075 + w * 0.09 - r * 0.045, max(min_h, 0.022 + o * 0.075 + r * 0.012), y - 0.82
    if sd_box(x - 1, dy, mw, mh, min(mw, mh) * (0.7 + r * 0.3)) > 0:
        return False
    return not (t > 0.5 and mh > 0.05 and abs(dy) < 0.018)


def seg_dist(px, py, ax, ay, bx, by):
    dx, dy = bx - ax, by - ay
    k = min(1, max(0, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)))
    return math.hypot(px - ax - k * dx, py - ay - k * dy)


def in_tri(px, py, a, b, c):
    d1 = (px - b[0]) * (a[1] - b[1]) - (a[0] - b[0]) * (py - b[1])
    d2 = (px - c[0]) * (b[1] - c[1]) - (b[0] - c[0]) * (py - c[1])
    d3 = (px - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (py - a[1])
    return not ((d1 < 0 or d2 < 0 or d3 < 0) and (d1 > 0 or d2 > 0 or d3 > 0))


def cat_lit(st, x, y, min_h):
    """catLit, with the ear twitch and pupils passed in explicitly."""
    op, hap, m, gx, gy = st.get("open", 1), st.get("hap", 0), st.get("mouth", {}), st.get("gx", 0), st.get("gy", 0)
    rows, line = round(0.55 / min_h), max(0.017, min_h * 0.6)
    head = math.hypot((x - 1) / 0.6, (y - 0.58) / 0.4)
    if abs(head - 1) * 0.4 < line * 0.75:
        return True
    for s in (-1, 1):
        tw = 0.03 if st.get("twitch") == s else 0
        tip, inner, outer = (1 + s * (0.47 + tw), 0.05 + tw), (1 + s * 0.16, 0.2), (1 + s * 0.56, 0.37)
        if head > 1 and (seg_dist(x, y, *tip, *inner) < line * 0.75 or seg_dist(x, y, *tip, *outer) < line * 0.75):
            return True
        if head > 1.05 and in_tri(x, y, (tip[0] - s * 0.01, tip[1] + 0.09), (inner[0] + s * 0.07, inner[1] + 0.01),
                                  (outer[0] - s * 0.04, outer[1] - 0.06)):
            return (math.floor(x / 2 * rows * 2) + math.floor(y * rows)) % 2 == 0
        ex, ey, rx, ry = 1 + s * 0.25 + gx * 0.06, 0.55 + gy * 0.05, 0.095, max(0.018, 0.12 * op)
        if hap > 0.5:
            d = math.hypot((x - ex) / rx, (y - ey - 0.04) / (ry * 0.9))
            if abs(d - 1) < 0.35 and y < ey + 0.03:
                return True
        elif ((x - ex) / rx) ** 2 + ((y - ey) / ry) ** 2 <= 1:
            cl = lambda v: min(1, max(0, v))
            px, py = ex + cl(0.5 + gx * 0.5) * rx * 0.9 - rx * 0.45, ey + cl(0.5 + gy * 0.5) * ry * 0.7 - ry * 0.45
            return not (ry > 0.06 and math.hypot(x - px, y - py) < max(0.03, min_h * 0.75))
        if ((x - 1 - s * 0.42) / 0.08) ** 2 + ((y - 0.72) / 0.045) ** 2 <= 1:
            return (math.floor(x / 2 * rows * 2) + math.floor(y * rows)) % 2 == 0
        for k in (0, 1):
            if seg_dist(x, y, 1 + s * 0.5, 0.66 + k * 0.07, 1 + s * 0.8, 0.6 + k * 0.12) < line * 0.5:
                return True
    if in_tri(x, y, (0.97, 0.655), (1.03, 0.655), (1, 0.685)):
        return True
    for s in (-1, 1):
        d = math.hypot(x - 1 - s * 0.035, y - 0.71)
        if y >= 0.705 and abs(d - 0.035) < line * 0.55:
            return True
    if m.get("o", 0) > 0.08:
        mw, mh = 0.035 + m.get("w", 0.3) * 0.03 - m.get("r", 0) * 0.015, max(min_h, 0.012 + m["o"] * 0.06)
        if sd_box(x - 1, y - (0.745 + mh), mw, mh, min(mw, mh) * 0.9) <= 0:
            return True
    return False


# --- grid → path ---------------------------------------------------------------------------------------------
def sample(lit, cols):
    rows, min_h = cols // 2, 0.55 / (cols // 2)
    return [[lit((i + 0.5) / cols * 2, (j + 0.5) / rows, min_h) for i in range(cols)] for j in range(rows)]


def runs(grid):
    """One horizontal run per lit segment, as a compact relative path (stroke-width 1 = one cell tall)."""
    out, cur = [], None
    for j, row in enumerate(grid):
        i = 0
        while i < len(row):
            if not row[i]:
                i += 1
                continue
            k = i
            while k < len(row) and row[k]:
                k += 1
            out.append(f"M{i} {j + 0.5}" if cur is None else f"m{i - cur[0]} {j - cur[1]}")
            out.append(f"h{k - i}")
            cur, i = (k, j), k
    return "".join(out)


def bitmap(rows, n=1):
    """Pixel art rows ("#" = lit), each art pixel n×n cells."""
    return runs([[c == "#" for c in r for _ in range(n)] for r in rows for _ in range(n)])


EYES = {
    "open": {}, "half": {"open": 0.45}, "shut": {"open": 0.07}, "happy": {"hap": 1},
    "wide": {"sc": 1.12}, "squint": {"open": 0.62, "hap": 0.5}, "sleepy": {"open": 0.1},
}
MOUTHS = {
    "rest": {}, "a": {"o": 0.55, "w": 0.45}, "A": {"o": 0.95, "w": 0.6, "t": 1}, "e": {"o": 0.3, "w": 0.75, "t": 1},
    "o": {"o": 0.6, "r": 1}, "u": {"o": 0.3, "r": 0.9, "w": 0.2}, "m": {"o": 0.12, "w": 0.35},
    "smile": {"o": 0.04, "w": 0.9}, "hum": {"o": 0.16, "w": 0.35, "r": 0.5},
    "snore0": {"o": 0.05, "w": 0.25, "r": 0.4}, "snore1": {"o": 0.22, "w": 0.25, "r": 0.4},
    "O": {"o": 0.85, "r": 1}, "OO": {"o": 1, "r": 1, "w": 0.4},
}
HEART = [".##.##.", "#######", "#######", ".#####.", "..###..", "...#..."]
NOTE = ["...###", "...#.#", "...#..", "...#..", ".###..", "####..", ".##..."]
Z = {3: ["###", ".#.", "###"], 4: ["####", "..#.", ".#..", "####"], 5: ["#####", "...#.", "..#..", ".#...", "#####"]}


# --- SMIL helpers --------------------------------------------------------------------------------------------
def kt(t, total):
    return f"{t / total:.4f}".rstrip("0").rstrip(".") or "0"


def discrete(attr, timeline, total, fmt=str):
    """timeline = [(t, value)] starting at t=0; consecutive duplicates collapse."""
    vals, times = [], []
    for t, v in timeline:
        if vals and vals[-1] == v:
            continue
        if times and kt(t, total) == times[-1]:
            vals[-1] = v
            continue
        vals.append(v)
        times.append(kt(t, total))
    if len(vals) == 1:
        return fmt(vals[0]), ""
    return fmt(vals[0]), (f'<animate attributeName="{attr}" values="{";".join(map(fmt, vals))}" keyTimes="{";".join(times)}" '
                          f'dur="{total}s" calcMode="discrete" repeatCount="indefinite"/>')


def frames(paths, timeline, total, extra=""):
    """paths = {key: d}; timeline = [(t, key)]. One path per key, shown only while the timeline says so."""
    out = []
    for key, d in paths.items():
        tl = [(t, "visible" if k == key else "hidden") for t, k in timeline]
        if all(v == "hidden" for _, v in tl):
            continue
        base, anim = discrete("visibility", tl, total)
        out.append(f'<path d="{d}" visibility="{base}"{extra}>{anim}</path>' if anim else f'<path d="{d}"{extra}/>')
    return "".join(out)


def move(timeline, total, cell, smooth=False):
    """Whole-cell translate keyframes [(t, (dx, dy))] → animateTransform (pixel units)."""
    fmt = lambda v: f"{v[0] * cell:g} {v[1] * cell:g}"
    base, _ = discrete("x", timeline, total, fmt)
    vals = [fmt(v) for _, v in timeline]
    if len(set(vals)) == 1:
        return f'transform="translate({base})"', ""
    times = ";".join(kt(t, total) for t, _ in timeline)
    mode = 'calcMode="linear"' if smooth else 'calcMode="discrete"'
    return (f'transform="translate({base})"',
            f'<animateTransform attributeName="transform" type="translate" values="{";".join(vals)}" '
            f'keyTimes="{times}" dur="{total}s" {mode} repeatCount="indefinite"/>')


def expand(segments):
    """[(duration, state)] → [(t, state)] plus total."""
    t, out = 0.0, []
    for dur, st in segments:
        out.append((round(t, 3), st))
        t += dur
    return out, round(t, 3)


def talk(rng, seconds, shapes="aAeoumam"):
    out, t = [], 0.0
    while t < seconds:
        d = rng.uniform(0.08, 0.15)
        out.append((d, rng.choice(shapes) if rng.random() > 0.12 else "m"))
        t += d
    return out + [(0.1, "rest")]


# --- device chrome -------------------------------------------------------------------------------------------
def defs(uid, cell, light, glow):
    shell = ("#fbfcfb", "#e2e6e2", "#cdd3cd") if light else ("#171a17", "#0a0b0a", "#232823")
    return f"""<defs>
<linearGradient id="{uid}s" x1="0" y1="0" x2=".35" y2="1"><stop offset="0" stop-color="{shell[0]}"/><stop offset="1" stop-color="{shell[1]}"/></linearGradient>
<linearGradient id="{uid}g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".04"/><stop offset=".3" stop-color="#fff" stop-opacity="0"/></linearGradient>
<radialGradient id="{uid}v" cx=".5" cy=".5" r=".75"><stop offset=".6" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity=".55"/></radialGradient>
<radialGradient id="{uid}f"><stop offset="0" stop-color="#000" stop-opacity="{'.18' if light else '.5'}"/><stop offset="1" stop-color="#000" stop-opacity="0"/></radialGradient>
<pattern id="{uid}p" width="{cell}" height="{cell}" patternUnits="userSpaceOnUse"><path d="M0 0h{cell}v{max(1, round(cell * .12))}H0zM0 0h{max(1, round(cell * .12))}v{cell}H0z" fill="#000" fill-opacity=".38"/></pattern>
<filter id="{uid}b" x="-5%" y="-10%" width="110%" height="120%"><feGaussianBlur stdDeviation="{glow}" result="b"/><feColorMatrix in="b" values="1 0 0 0 0 0 1 0 0 0 0 0 1 0 0 0 0 0 .9 0" result="c"/><feMerge><feMergeNode in="c"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
</defs>""", shell[2]


def device(uid, x, y, w, h, pad, radius, content, cell, light=False, glow=3, led=None):
    d, edge = defs(uid, cell, light, glow)
    bw, bh = w + 2 * pad, h + 2 * pad
    led_svg = ""
    if led:
        lx, ly = x + bw - pad * 1.2, y + bh - pad / 2
        led_svg = (f'<circle cx="{lx}" cy="{ly}" r="{max(1.6, pad / 9):.1f}" fill="{G}">'
                   f'<animate attributeName="fill-opacity" values="1;.25;1" dur="{led}s" repeatCount="indefinite"/></circle>')
    return f"""{d}
<ellipse cx="{x + bw / 2}" cy="{y + bh + pad * .6}" rx="{bw * .46}" ry="{pad * 1.1}" fill="url(#{uid}f)"/>
<rect x="{x}" y="{y}" width="{bw}" height="{bh}" rx="{radius}" fill="url(#{uid}s)" stroke="{edge}"/>
<rect x="{x + 1.5}" y="{y + 1.5}" width="{bw - 3}" height="{bh - 3}" rx="{radius - 1.5}" fill="none" stroke="#fff" stroke-opacity="{'.8' if light else '.05'}"/>
<g transform="translate({x + pad} {y + pad})">
<rect width="{w}" height="{h}" rx="{max(3, pad / 3):.0f}" fill="#000"/>
<g filter="url(#{uid}b)">{content}</g>
<rect width="{w}" height="{h}" fill="url(#{uid}p)"/>
<rect width="{w}" height="{h}" rx="{max(3, pad / 3):.0f}" fill="url(#{uid}v)"/>
<rect width="{w}" height="{h}" rx="{max(3, pad / 3):.0f}" fill="url(#{uid}g)"/>
</g>{led_svg}"""


def face(cols, cell, eye_tl, gaze_tl, mouth_tl, total, eye_keys=EYES, mouth_keys=MOUTHS, bob_tl=None):
    rows = cols // 2
    k = cols / 2  # cells per x-unit
    eyes = {n: runs(sample(lambda x, y, _h, e=e: eyes_lit(e, x, y), cols)) for n, e in eye_keys.items()
            if any(s == n for _, s in eye_tl)}
    mouths = {n: runs(sample(lambda x, y, h, m=m: mouth_lit(m, x, y, h), cols)) for n, m in mouth_keys.items()
              if any(s == n for _, s in mouth_tl)}
    gaze = [(t, (round(gx * 0.125 * k), round(gy * 0.1 * rows))) for t, (gx, gy) in gaze_tl]
    gt, ga = move(gaze, total, cell)
    st = f' stroke="{G}" fill="none" stroke-width="1" shape-rendering="crispEdges"'
    body = (f'<g {gt}>{ga}<g transform="scale({cell})"{st}>{frames(eyes, eye_tl, total)}</g></g>'
            f'<g transform="scale({cell})"{st}>{frames(mouths, mouth_tl, total)}</g>')
    if bob_tl:
        bt, ba = move(bob_tl, total, cell)
        body = f"<g {bt}>{ba}{body}</g>"
    return body


def sprite(rows, cell, x0, y0, show, total, path_tl=None, n=1):
    """A pixel bitmap shown during `show` = [(t0, t1)], drifting along path_tl = [(t, (dx, dy))] (cells)."""
    tl = [(0, "hidden")]
    for a, b in show:
        tl += [(a, "visible"), (b, "hidden")]
    base, anim = discrete("visibility", tl, total)
    mt, ma = move(path_tl or [(0, (0, 0))], total, cell)
    return (f'<g {mt}>{ma}<path transform="translate({x0 * cell} {y0 * cell}) scale({cell})" d="{bitmap(rows, n)}" '
            f'stroke="{G}" fill="none" shape-rendering="crispEdges" visibility="{base}">{anim}</path></g>')


def blink_at(t):
    return [(t, "half"), (t + 0.05, "shut"), (t + 0.12, "half"), (t + 0.17, "open")]


def svg(w, h, body, title):
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} {h}" width="{w}" height="{h}" role="img">'
            f'<title>{title}</title>{body}</svg>\n')


# --- hero ----------------------------------------------------------------------------------------------------
def hero(light):
    rng = random.Random(7)
    T, cols, cell = 12, 128, 6
    talk1, talk2 = talk(rng, 2.9), talk(rng, 2.2)
    mouth_tl, _ = expand([(1.2, "rest")] + talk1 + [(0.4, "rest"), (2.2, "smile"), (0.3, "rest"), (1.9, "hum"),
                                                     (0.2, "rest")] + talk2 + [(5, "rest")])
    eye_tl = [(0, "open")] + blink_at(0.7) + [(4.6, "happy"), (6.6, "open")] + blink_at(8.5) + blink_at(10.1) + blink_at(11.6)
    eye_tl.sort()
    gaze_tl = [(0, (0, 0)), (1.25, (-0.6, -0.45)), (1.9, (-0.2, -0.1)), (2.8, (0.15, 0.05)), (3.6, (0, 0)),
               (6.8, (1.05, -0.15)), (7.8, (0.3, -0.05)), (8.4, (0, 0)), (9.1, (0.6, -0.45)), (9.7, (0, 0)),
               (10.8, (-0.15, 0.1)), (11.4, (0, 0))]
    body = face(cols, cell, eye_tl, gaze_tl, mouth_tl, T)
    heart_path = [(round(4.8 + i * 0.16, 2), (0, -i)) for i in range(10)]
    body += sprite(HEART, cell, 108, 14, [(4.8, 6.4)], T, [(0, (0, 0))] + heart_path, n=2)
    body += sprite(["#", ".", "#"], cell, 18, 22, [(6.85, 7.0), (7.15, 7.3)], T)  # tiny "!" twinkle when glancing
    w, h, pad = cols * cell, cols // 2 * cell, 26
    dev = device("h", (960 - w - 2 * pad) / 2, 24, w, h, pad, 40, body, cell, light, glow=4, led=2.4)
    return svg(960, 530, dev, "Eli, a green pixel face that talks, blinks and smiles")


# --- feature cards -------------------------------------------------------------------------------------------
CARD_W, CARD_H, CC, CCOLS = 320, 200, 4, 64


def card(uid, body, title, cell=CC, cols=CCOLS, extra=""):
    w, h, pad = cols * cell, cols // 2 * cell, 14
    return svg(CARD_W, CARD_H, device(uid, (CARD_W - w - 2 * pad) / 2, 10, w, h, pad, 22, body, cell) + extra, title)


def card_talk():
    rng = random.Random(3)
    mouth_tl, T = expand([(0.4, "rest")] + talk(rng, 2.6) + [(0.6, "rest")] + talk(rng, 1.4) + [(0.5, "rest")])
    eye_tl = sorted([(0, "open")] + blink_at(3.1) + blink_at(5.0))
    gaze_tl = [(0, (0, 0)), (0.45, (-0.6, -0.45)), (1.1, (0, 0)), (3.4, (0.6, -0.45)), (4.0, (0, 0))]
    return card("t", face(CCOLS, CC, eye_tl, gaze_tl, mouth_tl, T), "Eli talking")


def card_listen():
    T = 4.0
    eye_tl = [(0, "open"), (0.5, "wide")] + blink_at(1.8) + [(1.97, "wide"), (3.4, "open")]
    gaze_tl = [(0, (0, 0)), (1.0, (0.15, 0.05)), (2.4, (-0.1, 0))]
    bob = [(0, (0, 0)), (0.9, (0, -1)), (1.05, (0, 0)), (2.5, (0, -1)), (2.65, (0, 0))]
    mouth_tl = [(0, "rest"), (3.5, "m"), (3.7, "rest")]
    body = face(CCOLS, CC, eye_tl, gaze_tl, mouth_tl, T, bob_tl=bob)
    key = ('<g transform="translate(110 176)"><g>'
           '<animateTransform attributeName="transform" type="translate" values="0 0;0 3;0 3;0 0" keyTimes="0;.12;.85;1" dur="4s" repeatCount="indefinite"/>'
           '<rect width="100" height="18" rx="5" fill="#121512" stroke="#2b332b"/>'
           f'<rect x="3" y="2" width="94" height="11" rx="3" fill="{G}" fill-opacity=".14">'
           '<animate attributeName="fill-opacity" values=".14;.5;.5;.14" keyTimes="0;.12;.85;1" dur="4s" repeatCount="indefinite"/></rect>'
           f'<text x="50" y="12.5" text-anchor="middle" font-family="{MONO}" font-size="9" fill="{G}" letter-spacing="1">space</text></g></g>')
    return svg(CARD_W, CARD_H, device("l", 32, 6, 256, 128, 14, 22, body, CC) + key, "Eli listening while Space is held")


def card_sing():
    T = 4.0
    beats = [i * 0.5 for i in range(8)]
    mouth_tl = [(0, "o"), (0.5, "O"), (1.0, "a"), (1.5, "OO"), (2.0, "u"), (2.5, "O"), (3.0, "OO"), (3.5, "o")]
    eye_tl = [(0, "happy"), (1.5, "squint"), (2.0, "happy"), (3.0, "squint"), (3.5, "happy")]
    gaze_tl = [(0, (-0.35, -0.2)), (1.0, (0.35, -0.2)), (1.5, (0.2, -0.65)), (2.0, (-0.35, -0.15)),
               (3.0, (0.3, -0.65)), (3.5, (0.35, -0.2))]
    bob = sorted([(b, (0, -1)) for b in beats] + [(b + 0.14, (0, 0)) for b in beats])
    body = face(CCOLS, CC, eye_tl, gaze_tl, mouth_tl, T, bob_tl=[(0, (0, 0))] + bob)
    for x0, t0 in ((4, 0.2), (53, 1.6), (8, 2.6)):
        path = [(0, (0, 0))] + [(round(t0 + i * 0.18, 2), (i % 2, -i)) for i in range(9)]
        body += sprite(NOTE, CC, x0, 18, [(t0, t0 + 1.6)], T, path)
    return card("s", body, "Eli dancing and singing")


def card_sleep():
    T = 4.5  # BREATH in face.js
    mouth_tl = [(0, "snore0"), (0.4, "m"), (0.9, "snore1"), (1.6, "m"), (2.0, "snore0")]
    eye_tl = [(0, "sleepy")]
    gaze_tl = [(0, (0, 0.3))]
    bob = [(0, (0, 0)), (0.6, (0, -1)), (1.8, (0, 0))]
    body = face(CCOLS, CC, eye_tl, gaze_tl, mouth_tl, T, bob_tl=bob)
    for i, (size, t0) in enumerate(((3, 0.3), (4, 1.4), (5, 2.5))):
        path = [(0, (0, 0))] + [(round(t0 + k * 0.3, 2), (k // 2, -k)) for k in range(7)]
        body += sprite(Z[size], CC, 53 + i * 3, 10 - i * 2, [(t0, min(T, t0 + 2.0))], T, path)
    return card("z", body, "Eli asleep, breathing, Zzz")


def card_cat():
    T, cols, cell = 5.0, 128, 2
    states = {
        "n": {}, "h": {"open": 0.45}, "c": {"open": 0.07}, "tw": {"twitch": -1}, "tr": {"twitch": 1, "gx": 0.6},
        "l": {"gx": -0.7, "gy": -0.3}, "m1": {"mouth": {"o": 0.5, "w": 0.4}}, "m2": {"mouth": {"o": 0.95, "w": 0.5, "r": 0.3}},
        "hp": {"hap": 1, "mouth": {"o": 0.3, "w": 0.4}},
    }
    tl = [(0, "n"), (0.6, "tw"), (0.78, "n"), (1.2, "l"), (2.0, "n"), (2.2, "h"), (2.25, "c"), (2.32, "h"), (2.37, "n"),
          (2.8, "m1"), (2.95, "m2"), (3.5, "m1"), (3.6, "hp"), (4.3, "tr"), (4.48, "n")]
    paths = {k: runs(sample(lambda x, y, h, s=s: cat_lit(s, x, y, h), cols)) for k, s in states.items()}
    body = f'<g transform="scale({cell})" stroke="{G}" fill="none" shape-rendering="crispEdges">{frames(paths, tl, T)}</g>'
    bubble = (f'<g visibility="hidden"><animate attributeName="visibility" values="hidden;visible;hidden" keyTimes="0;.56;.74" dur="{T}s" calcMode="discrete" repeatCount="indefinite"/>'
              f'<rect x="196" y="14" width="46" height="18" rx="9" fill="#000" stroke="{G}" stroke-width="1.5"/>'
              f'<path d="M204 31.5l-5 7 11-6.5" fill="#000" stroke="{G}" stroke-width="1.5" stroke-linejoin="round"/>'
              f'<rect x="203" y="30" width="9" height="2" fill="#000"/>'
              f'<text x="219" y="27" text-anchor="middle" font-family="{MONO}" font-size="11" font-weight="700" fill="{G}">mew</text></g>')
    return card("c", body + bubble, "Eli as a pixel cat that meows", cell=cell, cols=cols)


def card_faces():
    """Cycles through a few real themes: pixel, blocs, perles, beads with the unlit LEDs, cat."""
    T, step = 6.0, 1.2
    e, m = EYES["open"], MOUTHS["e"]
    lit = lambda x, y, h: eyes_lit(e, x, y) or mouth_lit(m, x, y, h)
    looks = []
    looks.append(("pixel", f'<g transform="scale(2)" stroke="{G}" stroke-width="1" fill="none" shape-rendering="crispEdges"><path d="{runs(sample(lit, 128))}"/></g>'))
    # blocs: 42 cells of 3px squares (2x2 lit) on the 128x64 OLED, here at 2 screen px per OLED px
    looks.append(("blocs", f'<g transform="translate(2 1) scale(6)" stroke="{G}" stroke-width=".66" stroke-dasharray=".66 .34" fill="none"><path d="{runs(sample(lit, 42))}" transform="translate(0 -.17)"/></g>'))
    looks.append(("perles", f'<g transform="translate(0 0) scale(8)" stroke="{G}" stroke-width=".55" stroke-dasharray="0 1" stroke-dashoffset="-.5" stroke-linecap="square" fill="none"><path d="{runs(sample(lit, 32))}"/></g>'))
    beads = runs(sample(lit, 28))
    bg = "".join(f"M0 {j + 0.5}h28" for j in range(14))
    dot = 'stroke-width=".78" stroke-dasharray="0 1" stroke-dashoffset="-.5" stroke-linecap="round" fill="none"'
    looks.append(("beads", f'<g transform="translate(2 1.1) scale(9.0)"><path d="{bg}" stroke="{DIM}" {dot}/><path d="{beads}" stroke="{G}" {dot}/></g>'))
    cat = runs(sample(lambda x, y, h: cat_lit({}, x, y, h), 128))
    looks.append(("cat", f'<g transform="scale(2)" stroke="{G}" fill="none" shape-rendering="crispEdges"><path d="{cat}"/></g>'))
    body = ""
    for i, (_, g) in enumerate(looks):
        tl = [(0, "hidden")] if i else [(0, "visible")]
        tl += [(i * step, "visible"), ((i + 1) * step, "hidden")] if i else [(step, "hidden")]
        base, anim = discrete("visibility", tl, T)
        body += f'<g visibility="{base}">{anim}{g}</g>'
    w, h, pad = 256, 128, 14
    dots = "".join(
        f'<circle cx="{CARD_W / 2 - 24 + i * 12}" cy="190" r="2.5" fill="{G}" fill-opacity=".25">'
        f'<animate attributeName="fill-opacity" values=".25;1;.25" keyTimes="0;{i / 5:.2f};{(i + 1) / 5:.2f}" dur="{T}s" calcMode="discrete" repeatCount="indefinite"/></circle>'
        for i in range(5))
    return svg(CARD_W, CARD_H, device("f", (CARD_W - w - 2 * pad) / 2, 6, w, h, pad, 22, body, 2) + dots,
               "A few of Eli's faces: pixel, blocks, beads, LEDs, cat")


# --- buttons -------------------------------------------------------------------------------------------------
ICONS = {  # 7x7 pixel glyphs: play, face, arrows, flag
    "start": ["#......", "###....", "#####..", "#######", "#####..", "###....", "#......"],
    "faces": ["#######", "#.....#", "#.#.#.#", "#.....#", "#.###.#", "#.....#", "#######"],
    "protocol": ["...#...", "..#....", "#######", "..#....", "...#...", "#######", "....#.."],
    "roadmap": ["##.....", "###....", "####...", "###....", "##.....", "#......", "#......"],
}


def button(icon, label, accent=False):
    tw = len(label) * 8.4
    w, h = round(tw + 58), 40
    bg, fg, edge = (G, "#031107", G) if accent else ("#0c0f0c", "#dff5e6", "#2b332b")
    ic = G if not accent else "#031107"
    return svg(w, h, f"""<rect x=".5" y=".5" width="{w - 1}" height="{h - 1}" rx="{h / 2 - .5}" fill="{bg}" stroke="{edge}"/>
<path transform="translate(18 13) scale(2)" d="{bitmap(ICONS[icon])}" stroke="{ic}" fill="none" stroke-width="1" shape-rendering="crispEdges"/>
<text x="42" y="25.5" font-family="{MONO}" font-size="14" font-weight="600" fill="{fg}" textLength="{tw:.0f}" lengthAdjust="spacingAndGlyphs">{label}</text>""",
               label)


BUTTONS = {
    "start": ("Quick start", "Démarrer"), "faces": ("Faces", "Visages"),
    "protocol": ("Protocol", "Protocole"), "roadmap": ("Roadmap", "Feuille de route"),
}


def main():
    files = {
        "hero.svg": hero(False), "hero-light.svg": hero(True),
        "card-talk.svg": card_talk(), "card-listen.svg": card_listen(), "card-sing.svg": card_sing(),
        "card-sleep.svg": card_sleep(), "card-cat.svg": card_cat(), "card-faces.svg": card_faces(),
    }
    for key, (en, fr) in BUTTONS.items():
        files[f"btn-{key}.svg"] = button(key, en, accent=key == "start")
        files[f"btn-{key}-fr.svg"] = button(key, fr, accent=key == "start")
    for name, text in files.items():
        (OUT / name).write_text(text)
        print(f"{name:24} {len(text.encode()) / 1024:5.1f} KB")


if __name__ == "__main__":
    main()
