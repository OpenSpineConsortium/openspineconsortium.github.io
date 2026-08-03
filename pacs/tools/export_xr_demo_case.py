"""Build the X-ray tab's demo bundle: the DRR of a CT case + ostk's own 2-D
spinopelvic landmarks, in the shared metrics.json contract.

Same scan as the CT tab, same numbers -- only the geometry space changes:

    CT tab :  geometry.space = "world_mm"   3-D points  -> NiiVue mmToPx()
    XR tab :  geometry.space = "image_px"   2-D points  -> xr.js imgToPx()

`summary` is copied VERBATIM from the CT bundle so the two tabs provably report
the same values; only the construction geometry is re-derived in the DRR frame.

REQUIRES OpenSpineToolkit PR #5 (aschehr) -- `ostk.drr` + `ostk.project2d`:
    git fetch origin pull/5/head:pr5 && git worktree add /tmp/ostk_pr5 pr5
    OSTK=/tmp/ostk_pr5 python pacs/tools/export_xr_demo_case.py

PR #5 also carries the S1-endplate fix (the naive slab caught the sacral alae and
under-read SS by 16-43 deg), so DO NOT run this against main.

Two rough edges in that PR this script has to work around -- both worth folding
back into it rather than living here:
  1. sagittal_drr_from_label() returns origin/axes/fov/shape but NOT the in-plane
     extent (u_min, v_min) of the rendered grid. Landmarks come back in plane-mm,
     so without the extent you cannot place them on the image -- which is the only
     thing an overlay needs. We recompute it from _framing_points + DEFAULT_MARGIN_MM,
     duplicating the framing logic (verified identical: fov 260x420 both ways).
  2. pelvic_incidence_2d_from_label() is based at the bicoxofemoral axis and
     lumbar_lordosis_2d_from_label() at the L1 centroid, so their 2-D coords are not
     directly comparable; we re-base LL into the PI/DRR frame via world space.
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

import numpy as np
import nibabel as nib

OSTK = os.environ.get("OSTK", "/tmp/ostk_pr5")
sys.path.insert(0, OSTK)

from ostk import drr as D                       # noqa: E402
from ostk import project2d as P2                # noqa: E402
from ostk.geometry import project_to_plane_2d   # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
COLORS = {"SS": "#60a5fa", "PT": "#f59e0b", "PI": "#a78bfa", "LL": "#34d399"}


def plane_extent(label, affine):
    """(u_min, v_min, W_mm, H_mm) of the DRR grid, in the PI plane frame.
    Mirrors sagittal_drr_from_label's framing exactly -- see note 1 in the docstring."""
    ax = D._pi_axis_and_origin(label, affine)
    if ax is None:
        return None
    lr, origin = ax["lr"], ax["bicox"]
    ant, cranial = P2.sagittal_axes(lr)
    uv = project_to_plane_2d(D._framing_points(label, affine), origin, ant, cranial)
    m = D.DEFAULT_MARGIN_MM
    u0, v0 = uv.min(axis=0) - m
    u1, v1 = uv.max(axis=0) + m
    W_mm = max(u1 - u0, D.MIN_FOV_MM[0])
    H_mm = max(v1 - v0, D.MIN_FOV_MM[1])
    uc, vc = 0.5 * (u0 + u1), 0.5 * (v0 + v1)
    return (uc - W_mm / 2, vc - H_mm / 2, W_mm, H_mm, origin, ant, cranial)


def make_to_px(u_min, v_min, spacing, H, W):
    """Plane-mm -> image pixel. sagittal_drr_from_label ends with img[::-1, ::-1]
    (superior up, anterior left), so both indices are mirrored."""
    def to_px(p):
        col_pre = (p[0] - u_min) / spacing - 0.5
        row_pre = (p[1] - v_min) / spacing - 0.5
        return [round(float(W - 1 - col_pre), 2), round(float(H - 1 - row_pre), 2)]
    return to_px


def line_through(pt, normal, half_len):
    """Endplate segment: through `pt`, perpendicular to `normal`, +/- half_len."""
    d = np.array([-normal[1], normal[0]], float)
    d /= (np.linalg.norm(d) or 1.0)
    return [(np.asarray(pt) - d * half_len).tolist(),
            (np.asarray(pt) + d * half_len).tolist()]


def build(case_dir: Path, out_dir: Path, case_id: str, title: str,
          pixel_spacing_mm: float = 1.0, gamma: float = 0.6):
    ct = nib.load(str(case_dir / "ct.nii.gz"))
    seg = nib.load(str(case_dir / "seg.nii.gz"))
    C = np.asanyarray(ct.dataobj)
    S = np.asanyarray(seg.dataobj).astype(np.int16)
    A = seg.affine

    drr = D.sagittal_drr_from_label(S, C, A, pixel_spacing_mm=pixel_spacing_mm, gamma=gamma)
    if drr is None:
        raise SystemExit("DRR returned None -- PI landmarks not extractable for this case")
    H, W = drr["shape"]
    ext = plane_extent(S, A)
    u_min, v_min, W_mm, H_mm, origin, ant, cranial = ext
    assert abs(W_mm - drr["fov_mm"][0]) < 1e-6 and abs(H_mm - drr["fov_mm"][1]) < 1e-6, \
        "reconstructed framing disagrees with the DRR's own -- PR #5 internals changed"
    to_px = make_to_px(u_min, v_min, drr["pixel_spacing_mm"], H, W)

    pi = P2.pelvic_incidence_2d_from_label(S, A)
    ll = P2.lumbar_lordosis_2d_from_label(S, A)
    if pi is None:
        raise SystemExit("PI landmarks unavailable")

    bicox = pi["landmarks_2d_mm"]["bicoxofemoral"]
    ep_mid = pi["landmarks_2d_mm"]["endplate_midpoint"]
    ep_n = pi["endplate_normal_2d"]

    # LL is based at the L1 centroid -- lift to world, re-project into the PI frame.
    ll_lines = {}
    if ll is not None:
        o2 = np.asarray(ll["origin_world_mm"], float)
        a2 = np.asarray(ll["axes"]["anterior"], float)
        c2 = np.asarray(ll["axes"]["cranial"], float)
        for lvl, uv in ll["landmarks_2d_mm"].items():
            world = o2 + uv[0] * a2 + uv[1] * c2
            here = project_to_plane_2d(world[None, :], origin, ant, cranial)[0]
            ll_lines[lvl] = (here, np.asarray(ll["endplate_normals_2d"][lvl], float))

    # ---- construction geometry --------------------------------------------------
    # PROJECT THE CT BUNDLE'S OWN CONSTRUCTIONS into the DRR plane rather than
    # rebuilding them. The CT metrics.json already carries every segment, dashed
    # reference, arc and label in world mm -- the layout you see on the CT tab. Both
    # tabs then draw the identical construction of the identical case, and the drawn
    # wedge equals the printed value by construction (no re-derivation to drift).
    ct_metrics = json.loads((case_dir / "metrics.json").read_text())
    ct_geo = ct_metrics.get("geometry") or {}

    def w2(p):
        """world mm -> plane mm (the DRR's own frame)."""
        return project_to_plane_2d(np.asarray(p, float)[None, :], origin, ant, cranial)[0]

    def w2px(p):
        return to_px(w2(p))

    def arc_from_ct(a):
        """The CT stores an arc as {center, a, b} + arc_r_mm. Re-emit it as an explicit
        polyline in the projected plane, at the same world radius."""
        arc = a.get("arc")
        if not arc:
            return []
        C, A, B = (w2(arc["center"]), w2(arc["a"]), w2(arc["b"]))
        r = float(a.get("arc_r_mm") or np.linalg.norm(A - C))
        d1, d2 = A - C, B - C
        n1 = np.linalg.norm(d1) or 1.0
        n2 = np.linalg.norm(d2) or 1.0
        a1 = np.arctan2(d1[1] / n1, d1[0] / n1)
        a2 = np.arctan2(d2[1] / n2, d2[0] / n2)
        dd = (a2 - a1 + np.pi) % (2 * np.pi) - np.pi
        N = 32
        return [to_px([C[0] + r * np.cos(a1 + dd * t / (N - 1)),
                       C[1] + r * np.sin(a1 + dd * t / (N - 1))]) for t in range(N)]

    angles = []
    for a in ct_geo.get("angles", []):
        angles.append({
            "id": a["id"], "label": a.get("label", a["id"]),
            "value": a.get("value"), "units": a.get("units", "°"),
            "color": a.get("color", COLORS.get(a["id"], "#ffffff")),
            "segments": [[w2px(p) for p in seg] for seg in (a.get("segments") or [])],
            "dashed":   [[w2px(p) for p in seg] for seg in (a.get("dashed") or [])],
            "arc": arc_from_ct(a),
            "label_at": w2px(a["label_at"]) if a.get("label_at") else None,
        })
    if not angles:
        raise SystemExit("CT bundle has no geometry.angles to project")

    # summary: copied verbatim from the CT bundle -- same scan, same numbers
    ct_metrics = json.loads((case_dir / "metrics.json").read_text())
    summary = dict(ct_metrics["summary"])
    summary["modality"] = "XR (DRR)"
    angles = [a for a in angles if a.get("value") is not None]

    out_dir.mkdir(parents=True, exist_ok=True)
    from PIL import Image
    img = (np.clip(drr["image"], 0, 1) * 255).astype(np.uint8)
    Image.fromarray(img, mode="L").save(out_dir / "image.png")
    (out_dir / "metrics.json").write_text(json.dumps({
        "case_id": case_id, "title": title, "image": "image.png",
        "summary": summary,
        "geometry": {
            "space": "image_px",
            "drr": {k: drr[k] for k in ("pixel_spacing_mm", "origin_world_mm",
                                        "axes", "shape", "fov_mm", "method_version")},
            "angles": angles,
        },
    }, indent=2))
    print(f"wrote {out_dir/'image.png'}  ({W}x{H} px, {drr['pixel_spacing_mm']} mm/px)")
    print(f"wrote {out_dir/'metrics.json'}")
    print("  values:", {a["id"]: a["value"] for a in angles})


def main():
    case_id = os.environ.get("CASE", "0003")
    src = ROOT / "data" / case_id
    out = ROOT / "data" / "xr" / case_id
    build(src, out, case_id, f"Case {case_id} — DRR (same scan as the CT tab)")
    man = ROOT / "data" / "xr" / "manifest.json"
    man.write_text(json.dumps({"cases": [
        {"id": case_id, "label": f"Case {case_id} — DRR of the CT case", "dir": case_id},
    ]}, indent=2))
    print("wrote", man)


if __name__ == "__main__":
    main()
