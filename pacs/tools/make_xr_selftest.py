"""Build the X-ray tab's geometry self-test bundle.

Emits a SCHEMATIC diagram (deliberately not a radiograph — no patient data, and
nothing that could be mistaken for one) plus a metrics.json in the shared demo
contract, so the overlay maths can be verified end-to-end before any real film
or trained model exists.

The derivation here is the reference implementation; pacs/xr.js mirrors it
exactly. If the two ever disagree, this file is the source of truth.

    python pacs/tools/make_xr_selftest.py
"""
from __future__ import annotations

import json
import math
from pathlib import Path

from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parents[1] / "data" / "xr" / "_selftest"
W, H = 620, 940

# ── landmarks, in image pixels (x right, y DOWN; anterior = -x, superior = -y) ──
LM = {
    "L1a": [195.0, 250.0],   # L1 superior endplate, anterior corner
    "L1p": [315.0, 262.0],   # L1 superior endplate, posterior corner
    "S1a": [230.0, 600.0],   # S1 superior endplate, anterior corner
    "S1p": [330.0, 640.0],   # S1 superior endplate, posterior corner
    "FH":  [300.0, 730.0],   # femoral head centre
}

sub = lambda a, b: [a[0] - b[0], a[1] - b[1]]
mid = lambda a, b: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]
ang = lambda v: math.degrees(math.atan2(v[1], v[0]))


def acute(d: float) -> float:
    d = abs(d) % 180
    return 180 - d if d > 90 else d


def ext(p, v, ln):
    n = math.hypot(*v) or 1
    return [p[0] + v[0] / n * ln, p[1] + v[1] / n * ln]


def derive(L):
    S1a, S1p, FH, L1a, L1p = (L[k] for k in ("S1a", "S1p", "FH", "L1a", "L1p"))
    S1m = mid(S1a, S1p)
    ep  = sub(S1a, S1p)
    hip = sub(S1m, FH)
    nrm = [-ep[1], ep[0]]
    SS = acute(ang(ep))
    PT = acute(ang(hip) + 90)
    if hip[0] > 0:
        PT = -PT
    PI = acute(ang(hip) - ang(nrm))
    LL = acute(ang(sub(L1a, L1p)) - ang(ep))
    r1 = lambda x: round(x, 1)
    R = max(W, H) * 0.18
    summary = {
        "case_id": "_selftest", "modality": "XR",
        "PI": r1(PI), "SS": r1(SS), "PT": r1(PT), "LL": r1(LL),
        "PI-LL": {"pi_minus_ll": r1(PI - LL), "abs_pi_minus_ll": r1(abs(PI - LL))},
        "qc_flags": ["ok"] if abs((SS + PT) - PI) <= 1.5 else ["pi_identity_mismatch"],
        "method_version": "xr-landmark-v1",
    }
    geometry = {
        "space": "image_px",
        "angles": [
            {"id": "SS", "label": "Sacral Slope", "value": r1(SS), "units": "°",
             "color": "#60a5fa", "segments": [[S1p, S1a]],
             "dashed": [[S1m, ext(S1m, [1, 0], R)]],
             "arc": {"center": S1m, "a": ext(S1m, ep, R * .5), "b": ext(S1m, [1, 0], R * .5)},
             "label_at": ext(S1m, [1, -.35], R * .62)},
            {"id": "PT", "label": "Pelvic Tilt", "value": r1(PT), "units": "°",
             "color": "#f59e0b", "segments": [[FH, S1m]],
             "dashed": [[FH, ext(FH, [0, -1], R * 1.4)]],
             "arc": {"center": FH, "a": ext(FH, hip, R * .5), "b": ext(FH, [0, -1], R * .5)},
             "label_at": ext(FH, [-.5, -1], R * .72)},
            {"id": "PI", "label": "Pelvic Incidence", "value": r1(PI), "units": "°",
             "color": "#a78bfa", "segments": [[FH, S1m], [S1p, S1a]],
             "dashed": [[S1m, ext(S1m, nrm, R * 1.2)]],
             "arc": {"center": S1m, "a": ext(S1m, hip, R * .5), "b": ext(S1m, nrm, R * .5)},
             "label_at": ext(S1m, [-.9, -.4], R * .7)},
            {"id": "LL", "label": "Lumbar Lordosis", "value": r1(LL), "units": "°",
             "color": "#34d399", "segments": [[L1p, L1a], [S1p, S1a]],
             "dashed": [], "arc": None,
             "label_at": mid(mid(L1a, L1p), S1m)},
        ],
        "landmarks": L,
    }
    return summary, geometry


def draw_schematic(path: Path, L):
    """A labelled line diagram. Flat grey on dark, obviously a drawing."""
    im = Image.new("L", (W, H), 18)
    d = ImageDraw.Draw(im)
    d.text((16, 14), "SYNTHETIC SCHEMATIC - geometry self-test, not a radiograph", fill=150)
    # lumbar bodies, marching from L1 down to S1 along the landmark line
    top, bot = L["L1a"], L["S1a"]
    for i in range(5):
        t0, t1 = i / 5, (i + 1) / 5
        ax = top[0] + (bot[0] - top[0]) * t0
        ay = top[1] + (bot[1] - top[1]) * t0
        bx = top[0] + (bot[0] - top[0]) * t1
        by = top[1] + (bot[1] - top[1]) * t1
        d.polygon([(ax, ay), (ax + 118, ay + 11), (bx + 118, by - 12), (bx, by - 22)],
                  fill=96, outline=170)
    # sacrum wedge + femoral head
    d.polygon([tuple(L["S1a"]), tuple(L["S1p"]), (L["S1p"][0] - 26, L["S1p"][1] + 190),
               (L["S1a"][0] - 6, L["S1a"][1] + 205)], fill=104, outline=175)
    fh = L["FH"]
    d.ellipse([fh[0] - 46, fh[1] - 46, fh[0] + 46, fh[1] + 46], fill=112, outline=180)
    for k, p in L.items():
        d.ellipse([p[0] - 3, p[1] - 3, p[0] + 3, p[1] + 3], fill=255)
        d.text((p[0] + 7, p[1] - 6), k, fill=210)
    im.convert("RGB").save(path)


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    summary, geometry = derive(LM)
    draw_schematic(OUT / "image.png", LM)
    (OUT / "metrics.json").write_text(json.dumps({
        "case_id": "_selftest",
        "title": "Geometry self-test (synthetic schematic)",
        "image": "image.png",
        "summary": summary,
        "geometry": geometry,
    }, indent=2))
    man = OUT.parent / "manifest.json"
    man.write_text(json.dumps({"cases": [
        {"id": "_selftest", "label": "Geometry self-test — synthetic schematic", "dir": "_selftest"},
    ]}, indent=2))
    print("wrote", OUT / "image.png")
    print("wrote", OUT / "metrics.json")
    print("wrote", man)
    print("\nderived:", {k: summary[k] for k in ("PI", "SS", "PT", "LL")})
    print("PI identity check: SS + PT =", round(summary["SS"] + summary["PT"], 1),
          "vs PI =", summary["PI"])


if __name__ == "__main__":
    main()
