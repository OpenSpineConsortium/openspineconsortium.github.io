"""tools/home_figures.py: draw the two animated figures of the home page (/).

    python -X utf8 tools/home_figures.py        # rewrite the figures and their keyframes

The lab diagram (three teammates, the repository with its board, main) and the git graph (two
features of one code base at once) are SVG drawn from the coordinates below, each in two
layouts, a wide one for screens over 720px and a tall one for phones, because the labels are
SVG text and scale with the drawing: a 1200-unit drawing shown 360px wide would make them
unreadable. The animation is CSS in assets/css/lab.css, keyed to the classes written here; the
keyframes whose timing comes from these coordinates (which commit pops when) are written by
this script too, between the markers in that file. Every element that moves is also drawn in
its final state, which is what prefers-reduced-motion shows. The script rewrites the body
between <!-- lab:start --> ... <!-- lab:end --> and <!-- graph:start --> ... <!-- graph:end -->
in tools/pages/index/body.html; the prose around them is written by hand.
"""
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parent.parent
BODY = ROOT / "tools" / "pages" / "index" / "body.html"
CSS = ROOT / "assets" / "css" / "lab.css"

# IBM Plex Mono is 0.6em wide per character; the chips behind the phone layout's arrow labels are
# sized from that.
MONO_EM = 0.6


def n(v):
    """A number as SVG writes it: no trailing zeros, no trailing point."""
    s = f"{v:.2f}".rstrip("0").rstrip(".")
    return "0" if s == "-0" else s


def el(tag, **attrs):
    parts = [tag]
    for k, v in attrs.items():
        if v is None:
            continue
        k = k.replace("_", "-") if k != "class_" else "class"
        parts.append(f'{k}="{v if isinstance(v, str) else n(v)}"')
    return "<" + " ".join(parts) + "/>"


def text(x, y, s, cls, size, anchor=None, extra=""):
    a = f' text-anchor="{anchor}"' if anchor else ""
    return f'<text class="{cls}" x="{n(x)}" y="{n(y)}" font-size="{n(size)}"{a}{extra}>{s}</text>'


def defs(prefix, shadow=True):
    """Arrowheads in the two colours and the tiles' soft shadow, with ids unique to one SVG."""
    marker = ('<marker id="{id}" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="11" markerHeight="11" '
              'markerUnits="userSpaceOnUse" orient="auto"><path class="fl-h{mod}" d="M1.5,1.5 L8.5,5 L1.5,8.5"/></marker>')
    out = ["<defs>", marker.format(id=prefix + "-t", mod=""), marker.format(id=prefix + "-o", mod=" fl-h--o")]
    if shadow:
        out.append(f'<filter id="{prefix}-sh" x="-12%" y="-12%" width="124%" height="136%">'
                   '<feDropShadow dx="0" dy="14" stdDeviation="12" flood-color="#0A423D" flood-opacity=".12"/></filter>')
    out.append("</defs>")
    return "".join(out)


def arrow(d, prefix, ochre=False, delay=None):
    """A thin arrow and the dot that runs along it (the flow classes of hero.css)."""
    mod = " fl-a--o" if ochre else ""
    dmod = " fl-d--o" if ochre else ""
    style = f' style="animation-delay:{delay}"' if delay else ""
    head = f"url(#{prefix}-{'o' if ochre else 't'})"
    return (f'<path class="fl-a{mod}" d="{d}" marker-end="{head}"/>'
            f'<path class="fl-d{dmod}" d="{d}" pathLength="100"{style}/>')


# ------------------------------------------------------------
# the lab: teammates, the repository and its board, main
# ------------------------------------------------------------
STATES = ("todo", "claimed", "in review", "merged")
ISSUES = ("#12", "#13", "#14", "#15")
# which state each row shows when nothing moves: the four states in order, top to bottom
STILL = (0, 1, 2, 3)


def icon(kind, x, y, scale):
    """A 48-unit icon drawn at x, y and scaled: a browser window, a cloud with a prompt, a person."""
    g = [f'<g transform="translate({n(x)} {n(y)}) scale({n(scale)})">']
    if kind == "browser":
        g += [el("rect", class_="lb-ib", x=2, y=7, width=44, height=34, rx=5),
              '<path class="lb-ibar" d="M2,16 V12 a5,5 0 0 1 5,-5 H41 a5,5 0 0 1 5,5 V16 Z"/>',
              el("circle", class_="lb-idot", cx=8, cy=11.5, r=1.5),
              el("circle", class_="lb-idot", cx=13, cy=11.5, r=1.5),
              el("circle", class_="lb-idot", cx=18, cy=11.5, r=1.5),
              el("circle", class_="lb-iav", cx=10, cy=25, r=3),
              el("rect", class_="lb-isk", x=16, y=22.5, width=22, height=3, rx=1.5),
              el("rect", class_="lb-isk", x=16, y=28.5, width=16, height=3, rx=1.5),
              el("rect", class_="lb-ibub", x=22, y=33.5, width=20, height=5, rx=2.5)]
    elif kind == "cloud":
        g += ['<g transform="translate(1 12) scale(0.25)"><path class="lb-icloud" vector-effect="non-scaling-stroke" '
              'd="M44,104 A28,28 0 0 1 40,50 A34,34 0 0 1 100,26 A40,40 0 0 1 170,44 A31,31 0 0 1 178,104 Z"/></g>',
              '<path class="lb-iprompt" d="M17,26 l4,4 l-4,4 M24,34 h7"/>']
    else:
        g += [el("circle", class_="lb-ihead", cx=24, cy=15, r=7),
              '<path class="lb-ibody" d="M8,44 a16,15 0 0 1 32,0 Z"/>']
    g.append("</g>")
    return "".join(g)


def tile(x, y, w, h, title, sub, kind, prefix, wide):
    out = [el("rect", class_="lb-tile", x=x, y=y, width=w, height=h, rx=16 if wide else 12, filter=f"url(#{prefix}-sh)")]
    if wide:
        out.append(icon(kind, x + 18, y + 30, 1))
        out.append(text(x + 82, y + 48, title, "lb-title", 18))
        out.append(text(x + 82, y + 72, sub, "lb-sub", 11.5))
    else:
        out.append(icon(kind, x + w / 2 - 18, y + 10, 0.75))
        out.append(text(x + w / 2, y + 66, title, "lb-title", 11.5, "middle"))
        out.append(text(x + w / 2, y + 82, sub, "lb-sub", 8.5, "middle"))
    return out


def pill(x, y, w, h, row, size):
    """The status pill of one board row: one rect whose fill cycles, four texts of which one shows."""
    still = STILL[row]
    out = [el("rect", class_=f"lb-pill lb-pill--{STATES[still].replace(' ', '-')}", x=x, y=y, width=w, height=h,
              rx=h / 2, style=f"--r:-{row * 3}s")]
    for s, word in enumerate(STATES):
        on = " lb-s--on" if s == still else ""
        out.append(text(x + w / 2, y + h / 2 + size * 0.36, word, f"lb-s lb-s{s}{on}", size, "middle",
                        f' style="--r:-{row * 3}s"'))
    return out


def commit(x, y, r, k, label, label_at, size, anchor):
    """A merge commit on main: a disc with a check mark that pops in at slot k, and its label."""
    out = [f'<g class="lb-commit lb-c{k}">',
           el("circle", class_="lb-cdot", cx=x, cy=y, r=r),
           f'<path class="lb-check" d="M{n(x - r * 0.5)},{n(y)} l{n(r * 0.35)},{n(r * 0.35)} l{n(r * 0.65)},{n(-r * 0.65)}"/>',
           "</g>",
           text(label_at[0], label_at[1], label, f"lb-close lb-l{k}", size, anchor)]
    return out


def lab_wide():
    W, H, p = 1200, 540, "lw"
    o = [f'<svg class="lab__art lab__art--wide" viewBox="0 0 {W} {H}" aria-hidden="true" focusable="false">', defs(p)]
    tiles = (("A student", "in claude.ai, in a browser", "browser"),
             ("An autonomous session", "nobody at the keyboard", "cloud"),
             ("A teammate", "their own account and plan", "person"))
    ys = (62, 216, 370)
    for (title, sub, kind), y in zip(tiles, ys):
        o += tile(28, y, 300, 108, title, sub, kind, p, True)
        o.append(el("circle", class_="fl-port", cx=328, cy=y + 54, r=5))
    # the repository
    bx, by, bw, bh = 492, 62, 326, 400
    o += [el("rect", class_="lb-repo", x=bx, y=by, width=bw, height=bh, rx=18, filter=f"url(#{p}-sh)"),
          f'<path class="lb-head" d="M{bx},{by + 46} V{by + 18} a18,18 0 0 1 18,-18 H{bx + bw - 18} a18,18 0 0 1 18,18 V{by + 46} Z"/>',
          el("line", class_="lb-rule", x1=bx, y1=by + 46.5, x2=bx + bw, y2=by + 46.5),
          el("circle", class_="lb-rdot", cx=bx + 24, cy=by + 23, r=5),
          text(bx + 40, by + 30, "your repository", "lb-title", 19),
          text(bx + bw - 18, by + 29, "STATE.md", "lb-k", 11, "end"),
          text(bx + 20, by + 76, "THE BOARD", "lb-k", 10.5, extra=' letter-spacing="1.6"')]
    widths = (136, 104, 118, 92)
    for r in range(4):
        y = by + 90 + 56 * r
        o.append(text(bx + 20, y + 29, ISSUES[r], "lb-num", 13))
        o.append(el("rect", class_="lb-sk", x=bx + 58, y=y + 20, width=widths[r], height=9, rx=4.5))
        o += pill(bx + 222, y + 11, 94, 26, r, 11.5)
        if r < 3:
            o.append(el("line", class_="lb-rule", x1=bx + 20, y1=y + 50.5, x2=bx + bw - 20, y2=y + 50.5))
    o.append(text(bx + bw / 2, by + bh - 20, "one issue · one branch · one pull request", "lb-cap", 11.5, "middle"))
    # the three arrows in, one per verb of the protocol
    rows_in = (by + 90 + 24, by + 90 + 56 + 24, by + 90 + 56 * 3 + 24)
    for i, (y, ry) in enumerate(zip(ys, rows_in)):
        yc = y + 54
        d = f"M328,{yc} C410,{yc} 410,{ry} {bx - 4},{ry}"
        o.append(arrow(d, p, delay=f"{i * 1.05:.2f}s" if i else None))
    o += [text(336, 103, "claims an issue", "lb-lab", 11.5),
          text(336, 292, "works in the open", "lb-lab", 11.5),
          text(336, 445, "lands by pull request", "lb-lab", 11.5)]
    # the merge arrow and main
    mx, my = 1060, 270
    o.append(arrow(f"M{bx + bw},{my} H{mx - 14}", p, ochre=True, delay="1.6s"))
    o += [text(932, 258, "merges", "lb-lab lb-lab--o", 11.5, "middle"),
          text(932, 291, "the check decides", "lb-cap", 11, "middle"),
          el("line", class_="lb-main", x1=mx, y1=92, x2=mx, y2=452),
          text(mx, 72, "main", "lb-title", 20, "middle")]
    for k, y in enumerate((118, 194, 270, 346)):
        o += commit(mx, y, 10, k, f"closes {ISSUES[3 - k]}", (mx + 20, y + 4), 11, None)
    o.append(text(mx, 486, "every merge closes an issue", "lb-cap", 11.5, "middle"))
    o.append("</svg>")
    return "\n".join(o)


def chip(cx, cy, s, size):
    w = len(s) * size * MONO_EM + 14
    return [el("rect", class_="lb-chip", x=cx - w / 2, y=cy - 11, width=w, height=17, rx=8.5),
            text(cx, cy + 3, s, "lb-lab", size, "middle")]


def lab_tall():
    W, H, p = 360, 760, "lt"
    o = [f'<svg class="lab__art lab__art--tall" viewBox="0 0 {W} {H}" aria-hidden="true" focusable="false">', defs(p)]
    tiles = (("A student", "in claude.ai", "browser"),
             ("A cloud session", "nobody watching", "cloud"),
             ("A teammate", "their own account", "person"))
    xs = (14, 130, 246)
    for (title, sub, kind), x in zip(tiles, xs):
        o += tile(x, 16, 100, 96, title, sub, kind, p, False)
        o.append(el("circle", class_="fl-port", cx=x + 50, cy=112, r=4))
    bx, by, bw, bh = 14, 300, 332, 304
    o += [arrow("M64,112 C64,205 90,205 90,296", p),
          arrow("M180,112 V296", p, delay="1.05s"),
          arrow("M296,112 C296,205 270,205 270,296", p, delay="2.1s")]
    o += chip(77, 168, "claims an issue", 9)
    o += chip(180, 204, "works in the open", 9)
    o += chip(283, 240, "lands by pull request", 9)
    o += [el("rect", class_="lb-repo", x=bx, y=by, width=bw, height=bh, rx=14, filter=f"url(#{p}-sh)"),
          f'<path class="lb-head" d="M{bx},{by + 40} V{by + 14} a14,14 0 0 1 14,-14 H{bx + bw - 14} a14,14 0 0 1 14,14 V{by + 40} Z"/>',
          el("line", class_="lb-rule", x1=bx, y1=by + 40.5, x2=bx + bw, y2=by + 40.5),
          el("circle", class_="lb-rdot", cx=bx + 20, cy=by + 20, r=4),
          text(bx + 32, by + 26, "your repository", "lb-title", 15),
          text(bx + bw - 14, by + 25, "STATE.md", "lb-k", 9, "end"),
          text(bx + 16, by + 66, "THE BOARD", "lb-k", 8.5, extra=' letter-spacing="1.3"')]
    widths = (88, 70, 98, 76)
    for r in range(4):
        y = by + 76 + 48 * r
        o.append(text(bx + 16, y + 25, ISSUES[r], "lb-num", 11))
        o.append(el("rect", class_="lb-sk", x=bx + 48, y=y + 16, width=widths[r], height=7, rx=3.5))
        o += pill(bx + 234, y + 8, 84, 24, r, 10)
        if r < 3:
            o.append(el("line", class_="lb-rule", x1=bx + 16, y1=y + 44.5, x2=bx + bw - 16, y2=y + 44.5))
    o.append(text(bx + bw / 2, by + bh - 16, "one issue · one branch · one pull request", "lb-cap", 9, "middle"))
    o.append(arrow(f"M180,{by + bh + 4} V684", p, ochre=True, delay="1.6s"))
    o += [text(192, 640, "merges", "lb-lab lb-lab--o", 9),
          text(192, 654, "the check decides", "lb-cap", 8.5),
          el("line", class_="lb-main", x1=24, y1=694, x2=336, y2=694),
          text(336, 684, "main", "lb-title", 13, "end")]
    for k, x in enumerate((60, 140, 220, 300)):
        o += commit(x, 694, 8, k, f"closes {ISSUES[3 - k]}", (x, 720), 8.5, "middle")
    o.append(text(180, 746, "every merge closes an issue", "lb-cap", 9, "middle"))
    o.append("</svg>")
    return "\n".join(o)


# ------------------------------------------------------------
# the git graph: two features of one code base, at the same time
# ------------------------------------------------------------
# seconds into the ten-second loop: when each piece appears
GRAPH_PERIOD = 10
POPS = {"base": 0.3, "a1": 2.2, "a2": 3.4, "a3": 4.6, "b1": 2.8, "b2": 4.0, "b3": 5.2, "b4": 6.4,
        "ma": 7.0, "mb": 7.8, "last": 8.4}
FADES = {"la": 0.8, "lb": 1.3, "done": 8.8}
DRAWS = {"a": (0.8, 2.0), "b": (1.3, 2.5)}


def gcommit(x, y, r, slot, kind):
    cls = {"main": "lg-c", "a": "lg-c lg-c--a", "b": "lg-c lg-c--b", "ma": "lg-c lg-c--ring lg-c--a", "mb": "lg-c lg-c--ring lg-c--b"}[kind]
    return el("circle", class_=f"{cls} lg-p-{slot}", cx=x, cy=y, r=r)


def graph_wide():
    W, H, p = 1000, 240, "gw"
    o = [f'<svg class="lab__art lab__art--wide" viewBox="0 0 {W} {H}" aria-hidden="true" focusable="false">', defs(p, shadow=False)]
    o += [el("line", class_="lg-main", x1=40, y1=120, x2=960, y2=120),
          '<path class="lg-br lg-br--a lg-d-a" pathLength="100" d="M180,120 C215,120 215,60 250,60 H640 C675,60 675,120 710,120"/>',
          '<path class="lg-br lg-br--b lg-d-b" pathLength="100" d="M260,120 C295,120 295,180 330,180 H760 C795,180 795,120 830,120"/>',
          text(40, 108, "main", "lg-t", 12),
          text(250, 44, "claude/12 · feature A", "lg-t lg-t--a lg-f-la", 12),
          text(330, 206, "claude/13 · feature B", "lg-t lg-t--b lg-f-lb", 12),
          gcommit(120, 120, 8, "base", "main"),
          gcommit(320, 60, 8, "a1", "a"), gcommit(440, 60, 8, "a2", "a"), gcommit(560, 60, 8, "a3", "a"),
          gcommit(400, 180, 8, "b1", "b"), gcommit(520, 180, 8, "b2", "b"), gcommit(640, 180, 8, "b3", "b"), gcommit(720, 180, 8, "b4", "b"),
          gcommit(710, 120, 9, "ma", "ma"), gcommit(830, 120, 9, "mb", "mb"), gcommit(920, 120, 8, "last", "main"),
          text(960, 44, "two features, no conflict, nothing done twice", "lg-done lg-f-done", 17, "end"),
          "</svg>"]
    return "\n".join(o)


def graph_tall():
    W, H, p = 360, 540, "gt"
    o = [f'<svg class="lab__art lab__art--tall" viewBox="0 0 {W} {H}" aria-hidden="true" focusable="false">', defs(p, shadow=False)]
    o += [el("line", class_="lg-main", x1=180, y1=30, x2=180, y2=510),
          '<path class="lg-br lg-br--a lg-d-a" pathLength="100" d="M180,100 C180,122 110,122 110,144 V356 C110,378 180,378 180,400"/>',
          '<path class="lg-br lg-br--b lg-d-b" pathLength="100" d="M180,140 C180,162 250,162 250,184 V416 C250,438 180,438 180,460"/>',
          text(192, 50, "main", "lg-t", 10),
          text(98, 262, "feature A", "lg-t lg-t--a lg-f-la", 10, "end"),
          text(98, 276, "claude/12", "lg-t lg-t--a lg-f-la", 10, "end"),
          text(262, 302, "feature B", "lg-t lg-t--b lg-f-lb", 10),
          text(262, 316, "claude/13", "lg-t lg-t--b lg-f-lb", 10),
          gcommit(180, 70, 7, "base", "main"),
          gcommit(110, 180, 7, "a1", "a"), gcommit(110, 240, 7, "a2", "a"), gcommit(110, 300, 7, "a3", "a"),
          gcommit(250, 220, 7, "b1", "b"), gcommit(250, 280, 7, "b2", "b"), gcommit(250, 340, 7, "b3", "b"), gcommit(250, 390, 7, "b4", "b"),
          gcommit(180, 400, 8, "ma", "ma"), gcommit(180, 460, 8, "mb", "mb"), gcommit(180, 496, 7, "last", "main"),
          text(180, 532, "two features, no conflict, nothing done twice", "lg-done lg-f-done", 13, "middle"),
          "</svg>"]
    return "\n".join(o)


# ------------------------------------------------------------
# the keyframes whose timing comes from the coordinates above
# ------------------------------------------------------------
def pct(seconds, period):
    return n(seconds / period * 100)


def board_keyframes():
    """Twelve seconds, four states of three; a row's pill cycles its fill, and of its four words one
    shows at a time. Each row starts three seconds behind the one above (--r on the elements)."""
    fills = {"todo": ("var(--paper-deep)", "transparent"), "claimed": ("rgba(14, 95, 88, 0.12)", "var(--teal)"),
             "in review": ("rgba(188, 107, 38, 0.14)", "var(--ochre)"), "merged": ("var(--ink)", "var(--ink)")}
    steps = []
    for s, word in enumerate(STATES):
        a, b = s * 25, (s + 1) * 25 - 0.01
        fill, stroke = fills[word]
        steps.append(f"  {n(a)}%, {n(b)}% {{ fill: {fill}; stroke: {stroke}; }}")
    out = ["@keyframes lb-pill {", *steps, "}"]
    for s in range(4):
        a, b = s * 25, (s + 1) * 25 - 0.01
        on = f"  {n(a)}%, {n(b)}% {{ opacity: 1; }}"
        offs = []
        if s > 0:
            offs.append(f"  0%, {n(a - 0.01)}% {{ opacity: 0; }}")
        if s < 3:
            offs.append(f"  {n(b + 0.01)}%, 100% {{ opacity: 0; }}")
        out += [f"@keyframes lb-s{s} {{", *offs, on, "}"]
    # the commits on main: row 3 merges at 0 s, row 2 at 3 s, row 1 at 6 s, row 0 at 9 s
    for k in range(4):
        t = 0.2 + 3 * k
        a, b, c = pct(t, 12), pct(t + 0.25, 12), pct(t + 0.5, 12)
        out += [f"@keyframes lb-c{k} {{",
                f"  0%, {a}% {{ transform: scale(0); opacity: 0; }}",
                f"  {b}% {{ transform: scale(1.22); opacity: 1; }}",
                f"  {c}% {{ transform: scale(1); }}",
                "  96% { opacity: 1; transform: scale(1); }",
                "  100% { opacity: 0; transform: scale(1); }",
                "}",
                f"@keyframes lb-l{k} {{",
                f"  0%, {a}% {{ opacity: 0; }}",
                f"  {c}% {{ opacity: 1; }}",
                "  96% { opacity: 1; }",
                "  100% { opacity: 0; }",
                "}"]
    return out


def graph_keyframes():
    out = []
    for name, t in POPS.items():
        a, b, c = pct(t, GRAPH_PERIOD), pct(t + 0.25, GRAPH_PERIOD), pct(t + 0.45, GRAPH_PERIOD)
        out += [f"@keyframes lg-p-{name} {{",
                f"  0%, {a}% {{ transform: scale(0); opacity: 0; }}",
                f"  {b}% {{ transform: scale(1.22); opacity: 1; }}",
                f"  {c}% {{ transform: scale(1); }}",
                "  95% { opacity: 1; transform: scale(1); }",
                "  100% { opacity: 0; transform: scale(1); }",
                "}"]
    for name, t in FADES.items():
        out += [f"@keyframes lg-f-{name} {{",
                f"  0%, {pct(t, GRAPH_PERIOD)}% {{ opacity: 0; }}",
                f"  {pct(t + 0.4, GRAPH_PERIOD)}% {{ opacity: 1; }}",
                "  95% { opacity: 1; }",
                "  100% { opacity: 0; }",
                "}"]
    for name, (t0, t1) in DRAWS.items():
        out += [f"@keyframes lg-d-{name} {{",
                f"  0%, {pct(t0, GRAPH_PERIOD)}% {{ stroke-dashoffset: 100; opacity: 1; }}",
                f"  {pct(t1, GRAPH_PERIOD)}% {{ stroke-dashoffset: 0; }}",
                "  95% { stroke-dashoffset: 0; opacity: 1; }",
                "  100% { stroke-dashoffset: 0; opacity: 0; }",
                "}"]
    # one rule per piece binds it to its keyframes
    rules = [f".lg-p-{name} {{ animation-name: lg-p-{name}; }}" for name in POPS]
    rules += [f".lg-f-{name} {{ animation-name: lg-f-{name}; }}" for name in FADES]
    rules += [f".lg-d-{name} {{ animation-name: lg-d-{name}; }}" for name in DRAWS]
    return out + rules


def replace_between(text_, start, end, new, where):
    pat = re.compile(re.escape(start) + r".*?" + re.escape(end), re.S)
    if not pat.search(text_):
        raise SystemExit(f"{where}: no {start} ... {end}")
    return pat.sub(lambda m: start + "\n" + new + "\n" + end, text_, count=1)


def main():
    body = BODY.read_text(encoding="utf-8")
    body = replace_between(body, "<!-- lab:start -->", "<!-- lab:end -->", lab_wide() + "\n" + lab_tall(), BODY)
    body = replace_between(body, "<!-- graph:start -->", "<!-- graph:end -->", graph_wide() + "\n" + graph_tall(), BODY)
    BODY.write_text(body, encoding="utf-8", newline="\n")
    css = CSS.read_text(encoding="utf-8")
    generated = "\n".join(board_keyframes() + graph_keyframes())
    css = replace_between(css, "/* generated by tools/home_figures.py: start */",
                          "/* generated by tools/home_figures.py: end */", generated, CSS)
    CSS.write_text(css, encoding="utf-8", newline="\n")
    print(f"wrote {BODY.relative_to(ROOT)} and {CSS.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
