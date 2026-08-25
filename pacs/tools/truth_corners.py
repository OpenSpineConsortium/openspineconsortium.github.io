"""pacs/tools/truth_corners.py — 3-D endplate corners that stop at the vertebral BODY.

WHAT WAS WRONG WITH THE OLD ONES. export_xr_demo_case.endplate_corners took every voxel of
the vertebra label, kept the ones within 3 mm of the fitted endplate PLANE, and returned the
two extremes along the plate. But that plane, extended backwards, runs straight through the
pedicles and the superior articular processes -- they sit at exactly that height. So the
posterior extreme was the back of the ARCH, not the back of the body, and the drawn endplate
came out 64 to 74 mm long on a patient whose vertebral bodies are 38 to 44 mm deep. Measured
against the network's corners it was 76 px too far posterior, while its anterior corner was
right to within 6 px.

So the body is carved first, the way the rest of this codebase already carves it: everything
anterior to the anterior wall of the spinal canal, found as the largest enclosed hole in the
ring. Then the plane band and the extremes mean what they say.

    python pacs/tools/truth_corners.py --case data/0003 --xr data/xr/0003 --check
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np
import nibabel as nib
from scipy import ndimage

sys.path.insert(0, str(Path(__file__).resolve().parents[3] / "OpenSpineToolkit"))

BAND_MM = 3.0
# THE CANAL'S ANTERIOR WALL IS A FEW MILLIMETRES ANTERIOR OF THE BODY'S POSTERIOR CORTEX --
# the cortex has thickness and the ring is widest below the plate. Tuned against the network
# on case 0003: at 0 mm the lumbar posterior corners sat 1.7-9.8 mm from the prediction, at
# 3 mm they sit 1.8-6.8 mm, and the anterior corner is untouched by this because the cut is
# behind it. Beyond 3 mm the plate starts running past the body again.
CUT_OFFSET_MM = 3.0
# how far above the endplate to look for the canal ring: at the plate itself the ring is
# often incomplete, and a slice or two down it is closed
RING_LOOK_MM = 8.0


def body_mask(vert, ap_axis, ap_increases_anteriorly, si_axis,
              si_increases_down=True, cut_offset_mm=0.0, ap_spacing_mm=1.0):
    """The vertebral body: everything ANTERIOR to the anterior wall of the spinal canal.

    THE DIRECTION OF THE AXIS DECIDES WHICH SIDE TO KEEP, and getting it wrong keeps the
    arch instead of the body. These volumes are ('P','I','R'): index 0 increases POSTERIORLY,
    so anterior is the LOW index and the body is everything below the cut, not above it. The
    first version kept the wrong half and produced 20 mm endplates on 40 mm bodies.

    The canal is the enclosed hole in the bony ring; its anterior wall is the body's
    posterior wall, which is the cut wanted here. Mirrors extract_degenerative.body_of
    rather than inventing a second definition of where a body ends.
    """
    moved = np.moveaxis(vert, (ap_axis, si_axis), (1, 2))
    zs = np.nonzero(moved.any(axis=(0, 1)))[0]
    if len(zs) < 5:
        return None
    # SAMPLE THE RING NEAR THE PLATE BEING MEASURED, not at the vertebra's waist. The canal
    # is triangular and its anterior wall moves with height, so a median taken across the
    # middle of the body sits a few millimetres off the wall at the superior endplate --
    # which showed up as L1 and L2 plates about eight millimetres short. `si_increases_down`
    # says which end of the index range is superior.
    n = len(zs)
    if si_increases_down:
        lo, hi = int(zs[0]), int(zs[max(0, int(0.45 * n) - 1)])
    else:
        lo, hi = int(zs[int(0.55 * n)]), int(zs[-1])

    fronts = []
    for z in range(lo, hi + 1):
        sl = moved[:, :, z]
        if sl.sum() < 60:
            continue
        hole = ndimage.binary_fill_holes(sl) & ~sl
        if not hole.any():
            continue
        cc, n = ndimage.label(hole)
        if n == 0:
            continue
        sizes = ndimage.sum(hole, cc, range(1, n + 1))
        big = cc == (int(np.argmax(sizes)) + 1)
        if big.sum() < 20:
            continue
        cols = np.nonzero(big.any(axis=0))[0]
        fronts.append(int(cols.max()) if ap_increases_anteriorly else int(cols.min()))

    if fronts:
        cut = float(np.median(fronts))
    else:
        ys = np.nonzero(moved.any(axis=(0, 2)))[0]
        if len(ys) < 4:
            return None
        cut = (ys.min() + 0.45 * (ys.max() - ys.min()) if ap_increases_anteriorly
               else ys.max() - 0.45 * (ys.max() - ys.min()))

    # THE CANAL'S ANTERIOR WALL IS THE BODY'S POSTERIOR WALL IN PRINCIPLE, and a little
    # posterior of it in practice: the cortex has thickness and the ring is widest a few
    # millimetres below the plate. `cut_offset_mm` moves the cut posteriorly, which can only
    # lengthen the plate at the back and cannot touch the anterior corner at all.
    steps = cut_offset_mm / max(ap_spacing_mm, 1e-6)
    cut = cut + (-steps if ap_increases_anteriorly else steps)
    out = np.zeros_like(moved)
    c = int(round(cut))
    if ap_increases_anteriorly:
        out[:, c:, :] = moved[:, c:, :]
    else:
        out[:, :c + 1, :] = moved[:, :c + 1, :]
    if out.sum() < 300:
        return None
    return np.moveaxis(out, (1, 2), (ap_axis, si_axis))


def corners_for(seg, affine, level, origin, ant, cranial, band_mm=BAND_MM,
                cut_offset_mm=CUT_OFFSET_MM, midline_mm=0.0):
    """Anterior and posterior ends of this level's SUPERIOR endplate, in plane mm."""
    from ostk.geometry import project_to_plane_2d
    from ostk.metrics import _endplate_normal_from_label
    import ostk.drr as D

    # ostk takes the level NAME here; LABELS maps it to the id for the mask
    from ostk.labels import LABELS
    n3, c3, _rms, _k = _endplate_normal_from_label(
        seg, affine, level, "superior", D.WORLD_SUPERIOR, 0.15, 30)
    if n3 is None:
        return None
    vert = seg == LABELS[level]
    if vert.sum() < 200:
        return None

    codes = nib.aff2axcodes(affine)
    ap = next((i for i, c in enumerate(codes) if c in "AP"), 1)
    si = next((i for i, c in enumerate(codes) if c in "SI"), 2)
    body = body_mask(vert, ap, codes[ap] == "A", si, codes[si] == "I",
                     cut_offset_mm, float(np.abs(affine[:3, ap]).sum()))
    if body is None:
        body = vert

    # THE SACRAL PROMONTORY IS MIDLINE; THE ALAE ARE NOT. A carve at the canal keeps both,
    # so S1's "endplate" came out fifty millimetres long against the network's thirty-six --
    # it was measuring across the wings, which are not the plate any angle is taken from.
    # Restricting to a midline slab is the same reasoning the 3-D pipeline uses when it
    # measures a disc in a midline column rather than at the rim.
    if midline_mm:
        lr = next((i for i, c in enumerate(nib.aff2axcodes(affine)) if c in "LR"), 0)
        li = np.argwhere(body)
        mid = float(np.median(li[:, lr]))
        step = float(np.abs(affine[:3, lr]).sum()) or 1.0
        half = midline_mm / step
        trimmed = np.zeros_like(body)
        sel = li[np.abs(li[:, lr] - mid) <= half]
        if len(sel) >= 200:
            trimmed[tuple(sel.T)] = True
            body = trimmed

    ijk_all = np.argwhere(body)
    world_all = nib.affines.apply_affine(affine, ijk_all)
    keep = np.abs((world_all - c3) @ n3) < band_mm
    if keep.sum() < 8:
        return None
    world = world_all[keep]
    keep = np.ones(len(world), bool)
    uv = project_to_plane_2d(world[keep], origin, ant, cranial)
    c2 = project_to_plane_2d(c3[None, :], origin, ant, cranial)[0]
    n2 = project_to_plane_2d((c3 + n3)[None, :], origin, ant, cranial)[0] - c2
    n2 = n2 / (np.linalg.norm(n2) or 1.0)
    d = np.array([-n2[1], n2[0]], float)
    if d[0] < 0:
        d = -d
    t = (uv - c2) @ d
    return {"ant": (c2 + d * t.max()).tolist(), "post": (c2 + d * t.min()).tolist()}


def main() -> int:
    ap_ = argparse.ArgumentParser()
    ap_.add_argument("--case", required=True, help="dir with seg.nii.gz")
    ap_.add_argument("--xr", required=True, help="dir with metrics.json (the DRR bundle)")
    ap_.add_argument("--band-mm", type=float, default=BAND_MM)
    ap_.add_argument("--cut-offset-mm", type=float, default=CUT_OFFSET_MM,
                     help="move the body cut this far posteriorly")
    ap_.add_argument("--midline-mm", type=float, default=0.0,
                     help="half-width of the midline slab used for S1")
    ap_.add_argument("--check", action="store_true", help="compare against the network")
    ap_.add_argument("--write", action="store_true", help="add truth corners to the bundle")
    a = ap_.parse_args()

    from ostk.labels import LABELS

    seg_img = nib.load(str(Path(a.case) / "seg.nii.gz"))
    seg = np.asanyarray(seg_img.dataobj).astype(np.int16)
    affine = seg_img.affine

    xr = Path(a.xr)
    m = json.loads((xr / "metrics.json").read_text(encoding="utf-8"))
    drr = m["geometry"]["drr"]
    sp = drr["pixel_spacing_mm"]
    H, W = drr["shape"]

    # THE FRAMING COMES FROM THE EXPORTER, NOT FROM A GUESS. sagittal_drr_from_label ends
    # with img[::-1, ::-1], so both pixel indices are mirrored, and the plane origin is not
    # the corner of the image -- reconstructing that by hand put every corner 200 mm out.
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from export_xr_demo_case import plane_extent, make_to_px
    u_min, v_min, W_mm, H_mm, origin, ant, cranial = plane_extent(seg, affine)
    to_px = make_to_px(u_min, v_min, sp, H, W)

    net = {}
    for l in m["geometry"]["landmarks"]:
        if l["cls"] in ("sup_ant", "sup_post"):
            net.setdefault(l["level"], {})[l["cls"]] = l["xy"]

    rows, truth = [], {}
    for level in ("L1", "L2", "L3", "L4", "L5", "S1"):
        if level not in LABELS:
            continue
        # only the sacrum needs the midline restriction; a lumbar body has no wings
        got = corners_for(seg, affine, level, origin, ant, cranial, a.band_mm,
                          a.cut_offset_mm,
                          a.midline_mm if level == "S1" else 0.0)
        if got is None:
            continue
        pa, pp = to_px(got["ant"]), to_px(got["post"])
        truth[level] = {"ant": pa, "post": pp}
        n = net.get(level)
        if n:
            da = float(np.hypot(pa[0] - n["sup_ant"][0], pa[1] - n["sup_ant"][1]))
            dp = float(np.hypot(pp[0] - n["sup_post"][0], pp[1] - n["sup_post"][1]))
            ln_t = float(np.hypot(pa[0] - pp[0], pa[1] - pp[1]))
            ln_n = float(np.hypot(n["sup_ant"][0] - n["sup_post"][0],
                                  n["sup_ant"][1] - n["sup_post"][1]))
            rows.append((level, da, dp, ln_t * sp, ln_n * sp))

    if rows:
        print(f"  band {a.band_mm} mm, cut offset {a.cut_offset_mm} mm — distance to the network's corners, in mm\n")
        print(f"  {'level':6s} {'anterior':>10s} {'posterior':>10s} "
              f"{'plate (truth)':>14s} {'plate (net)':>12s}")
        for lv, da, dp, lt, ln in rows:
            print(f"  {lv:6s} {da * sp:>9.1f}mm {dp * sp:>9.1f}mm "
                  f"{lt:>13.1f}mm {ln:>11.1f}mm")
        A = np.array([r[1] for r in rows]) * sp
        P = np.array([r[2] for r in rows]) * sp
        print(f"\n  anterior  : mean {A.mean():.1f} mm, worst {A.max():.1f} mm")
        print(f"  posterior : mean {P.mean():.1f} mm, worst {P.max():.1f} mm")
        print(f"  plate length: truth {np.mean([r[3] for r in rows]):.1f} mm, "
              f"net {np.mean([r[4] for r in rows]):.1f} mm")

    if a.write:
        keep = [l for l in m["geometry"]["landmarks"]]
        for level, c in truth.items():
            for side, xy in (("ant", c["ant"]), ("post", c["post"])):
                keep.append({
                    "id": f"{level}_truth_{side}", "level": level,
                    "cls": f"truth_{side}", "kind": "truth",
                    "label": f"{level} superior endplate, {side}erior (3-D)",
                    "xy": [round(xy[0], 2), round(xy[1], 2)],
                    "color": "#94a3b8",
                    "desc": f"{level} superior endplate {side}erior corner, fitted in the "
                            f"volume and projected. The body is carved at the anterior wall "
                            f"of the canal first, so the plate stops where the body does.",
                })
        m["geometry"]["landmarks"] = keep
        m["geometry"].setdefault("net", {})["truth_corners"] = {
            "levels": sorted(truth), "band_mm": a.band_mm,
            "cut_offset_mm": a.cut_offset_mm,
            "agreement_mm": {lv: {"anterior": round(da * sp, 1),
                                  "posterior": round(dp * sp, 1)}
                             for lv, da, dp, _lt, _ln in rows},
            "note": "Endplate corners fitted in the volume and projected, with the body "
                    "carved at the anterior wall of the canal. Shipped for comparison, not "
                    "as the measured line: on this case they agree with the network to "
                    "about 3 mm anteriorly and 5 mm posteriorly across L1-L5, and disagree "
                    "by 13 mm at S1, where the sacral canal is not the same landmark and "
                    "this carve does not transfer.",
        }
        (xr / "metrics.json").write_text(json.dumps(m, indent=1) + "\n", encoding="utf-8")
        print(f"\n  wrote {len(truth) * 2} truth corners into {xr / 'metrics.json'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
