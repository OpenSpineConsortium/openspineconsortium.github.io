"""pacs/tools/reference_angles_from_corners.py — measure the reference film from the
network's corners, using ostk as the measurement engine.

WHAT CHANGED AND WHY. The reference pane used to carry two different things: corners
predicted by the network, and angles derived independently in 3-D from the segmentation.
Two sources on one film, agreeing to about two degrees, which is a nice thing to report and
a confusing thing to draw -- the endplate line an angle is measured from did not pass
through the corners drawn beside it.

So the corners are now the input. ostk.metrics2d already takes endplates as LINES -- a pair
of corners -- and returns the same schema the 3-D summary returns, using the same
definitions on 2-D vectors. Feeding the network's corners into it makes one measurement
chain: the net finds the corners, ostk measures them, and the drawn endplate is the line the
angle was taken from because there is only one line.

THE FEMORAL HEAD IS STILL ostk's. It is a sphere fitted in the volume, no lateral-radiograph
model predicts it, and PI and PT are undefined without it -- which is exactly why the
reference pane can show PI and PT and a dropped film cannot.

IMAGE PIXELS RUN DOWNWARD. metrics2d takes `sup`, the superior direction in the frame it is
given. In image pixels that is (0, -1), not the default (0, +1). Getting this wrong does not
raise; it silently reflects every angle.

    python pacs/tools/reference_angles_from_corners.py --case data/xr/0003
"""
from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[3] / "OpenSpineToolkit"))

# the palette xr.js uses, so a precomputed angle and a re-inferred one are the same
# colour -- otherwise switching model looks like switching parameter
COLORS = {"SS": "#60a5fa", "PT": "#f59e0b", "PI": "#a78bfa", "LL": "#34d399"}
LABELS = {"SS": "Sacral Slope", "PT": "Pelvic Tilt",
          "PI": "Pelvic Incidence", "LL": "Lumbar Lordosis"}


def intersect(p1, p2, p3, p4):
    """Where two lines cross, or None if they are parallel."""
    d = (p1[0] - p2[0]) * (p3[1] - p4[1]) - (p1[1] - p2[1]) * (p3[0] - p4[0])
    if abs(d) < 1e-9:
        return None
    a = p1[0] * p2[1] - p1[1] * p2[0]
    b = p3[0] * p4[1] - p3[1] * p4[0]
    return [(a * (p3[0] - p4[0]) - (p1[0] - p2[0]) * b) / d,
            (a * (p3[1] - p4[1]) - (p1[1] - p2[1]) * b) / d]


def extend(a, b, k):
    """The segment a-b lengthened about its midpoint by k, for drawing."""
    mx, my = (a[0] + b[0]) / 2, (a[1] + b[1]) / 2
    return ([mx + (a[0] - mx) * k, my + (a[1] - my) * k],
            [mx + (b[0] - mx) * k, my + (b[1] - my) * k])


def label_out(mid, W, side, dy=0.0):
    """A label just outside the film, with a leader back to the construction.

    drawAngle only writes the number when `label_at` is present -- without it the segments
    and the wedge still draw, so the figure looks complete and every value has silently
    disappeared. That is what happened when these angles were rebuilt from the corners.
    Placed off the image edge for the same reason buildUserView does it: over the film the
    number sits on the anatomy it is measuring.
    """
    x = -0.015 * W if side < 0 else 1.015 * W
    lx = -0.012 * W if side < 0 else 1.012 * W
    return ([x, mid[1] + dy], "end" if side < 0 else "start",
            [[lx, mid[1] + dy], list(mid)])


def arc_pts(c, p, q, r, n=28):
    """A circular arc at `c` from the direction of p to the direction of q."""
    a0 = math.atan2(p[1] - c[1], p[0] - c[0])
    a1 = math.atan2(q[1] - c[1], q[0] - c[0])
    d = (a1 - a0 + math.pi) % (2 * math.pi) - math.pi
    return [[c[0] + r * math.cos(a0 + d * i / n),
             c[1] + r * math.sin(a0 + d * i / n)] for i in range(n + 1)]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--case", required=True)
    a = ap.parse_args()

    case = Path(a.case)
    mp = case / "metrics.json"
    m = json.loads(mp.read_text(encoding="utf-8"))
    g = m["geometry"]
    lms = g["landmarks"]

    by = {}
    for l in lms:
        by.setdefault(l["level"] if "level" in l else l["cls"], {})[l["cls"]] = l["xy"]
    femoral = next((l["xy"] for l in lms if l["cls"] == "hip_axis"), None)
    if femoral is None:
        print("  ! no bicoxofemoral landmark; PI and PT cannot be measured")

    # SUPERIOR endplates only: that is what metrics2d's chain is defined on, and it is
    # what the 3-D code measures too
    endplates = {}
    for level, pts in by.items():
        if "sup_ant" in pts and "sup_post" in pts:
            endplates[level] = (pts["sup_ant"], pts["sup_post"])
    if not endplates:
        print("  ! no superior endplate pairs among the landmarks")
        return 1
    print(f"  endplates from the network: {', '.join(sorted(endplates))}")

    from ostk.metrics2d import spinopelvic_summary_2d
    # image pixels run downward, so superior is -y
    s = spinopelvic_summary_2d(endplates, femoral, sup=(0, -1),
                               case_id=m.get("case_id", ""))
    print(f"  ostk on those corners: PI {s['PI']}  SS {s['SS']}  PT {s['PT']}  LL {s['LL']}")
    prev = {x["id"]: x["value"] for x in g.get("angles", [])}
    for k in ("PI", "SS", "PT", "LL"):
        if s[k] is not None and k in prev:
            print(f"    {k}: was {prev[k]} from the volume, now {s[k]:.1f} from the film "
                  f"(delta {s[k] - prev[k]:+.1f})")

    # ---- the drawn constructions, from the SAME lines that were measured --------------
    W = g["drr"]["shape"][1]
    angles = []
    s1 = endplates.get("S1")
    if s1 is not None and s["SS"] is not None:
        A, P = list(s1[0]), list(s1[1])
        e0, e1 = extend(A, P, 1.9)
        mid = [(A[0] + P[0]) / 2, (A[1] + P[1]) / 2]
        ln = math.hypot(P[0] - A[0], P[1] - A[1])
        dr = -1 if A[0] <= P[0] else 1
        hz = [mid[0] + dr * ln * 0.95, mid[1]]
        lab, anch, lead = label_out(mid, W, dr)
        angles.append({"id": "SS", "label": LABELS["SS"], "value": round(s["SS"], 1),
                       "units": "°", "color": COLORS["SS"],
                       "segments": [[e0, e1]], "dashed": [[mid, hz]],
                       "arc": arc_pts(mid, e0 if dr < 0 else e1, hz, ln * 0.55),
                       "label_at": lab, "label_anchor": anch, "leader": lead})
        if femoral is not None and s["PT"] is not None:
            vert = [mid[0], mid[1] - ln * 1.2]
            lab, anch, lead = label_out(list(femoral), W, dr)
            angles.append({"id": "PT", "label": LABELS["PT"], "value": round(s["PT"], 1),
                           "units": "°", "color": COLORS["PT"],
                           "segments": [[list(femoral), mid]],
                           "dashed": [[list(femoral), [femoral[0], femoral[1] - ln * 1.6]]],
                           "arc": arc_pts(list(femoral), mid,
                                          [femoral[0], femoral[1] - ln * 1.6], ln * 0.5),
                           "label_at": lab, "label_anchor": anch, "leader": lead})
        if femoral is not None and s["PI"] is not None:
            # PI is the angle at the endplate midpoint between its perpendicular and the
            # line to the femoral head -- the same construction the 3-D code uses
            d = [(P[0] - A[0]) / ln, (P[1] - A[1]) / ln]
            n = [-d[1], d[0]]
            if n[1] > 0:
                n = [-n[0], -n[1]]                       # point it cranially
            tip = [mid[0] + n[0] * ln * 1.1, mid[1] + n[1] * ln * 1.1]
            # nudged clear of SS, which is labelled at the same midpoint
            lab, anch, lead = label_out(mid, W, dr, dy=-2.2 * ln)
            angles.append({"id": "PI", "label": LABELS["PI"], "value": round(s["PI"], 1),
                           "units": "°", "color": COLORS["PI"],
                           "segments": [[mid, list(femoral)]], "dashed": [[mid, tip]],
                           "arc": arc_pts(mid, tip, list(femoral), ln * 0.62),
                           "label_at": lab, "label_anchor": anch, "leader": lead})
    l1 = endplates.get("L1")
    if l1 is not None and s1 is not None and s["LL"] is not None:
        A1, P1 = list(l1[0]), list(l1[1])
        A2, P2 = list(s1[0]), list(s1[1])
        l1mid = [(A1[0] + P1[0]) / 2, (A1[1] + P1[1]) / 2]
        side = -1 if A1[0] <= P1[0] else 1
        lab, anch, lead = label_out(l1mid, W, side)
        a = {"id": "LL", "label": LABELS["LL"], "value": round(s["LL"], 1),
             "units": "°", "color": COLORS["LL"],
             "segments": [list(extend(A1, P1, 1.6)), list(extend(A2, P2, 1.6))],
             "label_at": lab, "label_anchor": anch, "leader": lead}
        # THE COBB LINES MEET ANTERIORLY IN A LORDOSIS, usually off the film. Draw the wedge
        # only where the vertex is somewhere a reader can see it, which is the same rule the
        # user pane applies.
        X = intersect(A1, P1, A2, P2)
        H = g["drr"]["shape"][0]
        if X and -0.35 * W < X[0] < 1.35 * W and -0.35 * H < X[1] < 1.35 * H:
            r = 0.55 * min(math.hypot(X[0] - A1[0], X[1] - A1[1]),
                           math.hypot(X[0] - A2[0], X[1] - A2[1]))
            a["arc"] = arc_pts(X, A1, A2, r)
        angles.append(a)

    g["angles"] = angles
    g.setdefault("net", {})["angles_from_ostk_on_net_corners"] = {
        k: s[k] for k in ("PI", "SS", "PT", "LL")}
    g["net"]["measured_by"] = "ostk.metrics2d on the network's corners"
    m["summary"] = {**m.get("summary", {}),
                    **{k: s[k] for k in ("PI", "SS", "PT", "LL")},
                    "modality": "radiograph_2d",
                    "note": "Corners predicted by the network on this synthetic radiograph; "
                            "angles measured from those corners by ostk.metrics2d. The "
                            "femoral head is a 3-D fit and is not predicted."}
    mp.write_text(json.dumps(m, indent=1) + "\n", encoding="utf-8")
    print(f"  wrote {mp}: {len(angles)} angle construction(s) from the network's corners")
    return 0


if __name__ == "__main__":
    sys.exit(main())
