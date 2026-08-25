"""pacs/tools/reference_corners_from_net.py — place the reference case's corners with the net.

WHY. The reference pane's corners came from the 3-D segmentation, projected into the DRR
plane: for each level, the two extremes of the superior endplate. That is defensible as
ground truth and it looks wrong on the film, for two reasons. It gives TWO points per
vertebra where the model gives four, so the reference teaches half of what the network is
asked for. And a projected extreme is not where a reader would put a corner -- the extreme
of a 3-D endplate band lands past the visible cortex once the vertebra is rotated at all.

So the corners now come from the same network the user pane runs, on the same DRR the
reference pane shows. The bicoxofemoral point does NOT: it is a 3-D construction, the femoral
heads are spheres fitted in the volume, and no lateral radiograph model predicts it. That one
keeps coming from ostk, which is the existing process.

THE DECODE IS NOT REIMPLEMENTED HERE. Confidence filtering, NMS, keypoint slot order and the
letterbox inverse all live in pacs/infer.js and the browser runs them; a second copy in
Python would be a second thing to keep in step, and pacs/tools/test_decode.mjs exists
precisely because that drift is where the silent failures live. This script runs the network
and writes the RAW output; node tools/reference_corners_decode.mjs turns it into corners
using the page's own code.

    python pacs/tools/reference_corners_from_net.py --case data/xr/0003 --imgsz 1024
    node   pacs/tools/reference_corners_decode.mjs data/xr/0003
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np

PAD_GREY = 114


def letterbox_params(w: int, h: int, S: int) -> dict:
    """Identical to letterboxParams in infer.js, including its rounding.

    The -0.1 before rounding is not decoration: Math.round in JS rounds .5 upward, and
    numpy rounds .5 to even. On an odd padding difference those disagree by one pixel, and
    a one-pixel offset in the letterbox is a one-pixel bias in every corner.
    """
    scale = min(S / w, S / h)
    nw, nh = int(round(w * scale)), int(round(h * scale))
    left = int(np.floor((S - nw) / 2 - 0.1 + 0.5))
    top = int(np.floor((S - nh) / 2 - 0.1 + 0.5))
    return {"scale": scale, "nw": nw, "nh": nh, "left": left, "top": top, "ox": 0, "oy": 0}


def preprocess(img_path: Path, S: int):
    from PIL import Image
    im = Image.open(img_path).convert("RGB")
    w, h = im.size
    lb = letterbox_params(w, h, S)
    canvas = Image.new("RGB", (S, S), (PAD_GREY, PAD_GREY, PAD_GREY))
    canvas.paste(im.resize((lb["nw"], lb["nh"]), Image.BICUBIC), (lb["left"], lb["top"]))
    a = np.asarray(canvas, np.float32) / 255.0            # HWC
    x = np.transpose(a, (2, 0, 1))[None]                  # NCHW
    return np.ascontiguousarray(x), lb, (w, h)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--case", required=True, help="directory holding image.png + metrics.json")
    ap.add_argument("--models", default="models")
    ap.add_argument("--imgsz", type=int, default=1024, choices=(640, 1024))
    a = ap.parse_args()

    case = Path(a.case)
    img = case / "image.png"
    if not img.exists():
        print(f"  ! {img} not found")
        return 1
    model = Path(a.models) / f"v11n_{a.imgsz}.onnx"
    if not model.exists():
        print(f"  ! {model} not found")
        return 1

    import onnxruntime as ort
    x, lb, (w, h) = preprocess(img, a.imgsz)
    sess = ort.InferenceSession(str(model), providers=["CPUExecutionProvider"])
    iname = sess.get_inputs()[0].name
    out = sess.run(None, {iname: x})[0]
    out = np.asarray(out, np.float32)
    print(f"  {img.name}: {w}x{h} -> {a.imgsz}, network output {out.shape}")

    # (1, channels, anchors) is what the browser hands decode(); keep that shape and let
    # infer.js interpret it, rather than deciding here what the channels mean
    if out.ndim == 3 and out.shape[0] == 1:
        n_ch, n_anc = int(out.shape[1]), int(out.shape[2])
    else:
        print(f"  ! unexpected output rank {out.shape}")
        return 1

    raw = case / "_net_raw.bin"
    raw.write_bytes(out.astype(np.float32).tobytes())
    (case / "_net_meta.json").write_text(json.dumps({
        "nCh": n_ch, "nAnc": n_anc, "imgsz": a.imgsz,
        "lb": lb, "image_w": w, "image_h": h,
        "model": model.name,
    }, indent=1) + "\n", encoding="utf-8")
    print(f"  wrote {raw.name} and _net_meta.json  ({n_ch} channels, {n_anc} anchors)")
    print(f"  now: node pacs/tools/reference_corners_decode.mjs {case}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
