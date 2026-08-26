"""tools/square_headshot.py — crop a portrait headshot to a square that keeps the head.

THE PROBLEM. The person cards show a square portrait with object-fit: cover, which centres
on the middle of the IMAGE. A studio headshot is a tall portrait with the face in the upper
third, so centring on the image middle crops the top of the head off and fills the bottom of
the square with shirt. On the principal cards, where the portrait is 150px rather than a
60px avatar chip, that is very visible.

WHY NOT JUST object-position: 50% 20%. Because the right fraction is different for every
photograph -- how tightly it was framed, how much headroom the photographer left -- and CSS
cannot see the image. Guessing one number for all of them trades a crop on some faces for
too much ceiling on others.

HOW THE HEAD IS FOUND WITHOUT A FACE DETECTOR. These are studio portraits on a plain
backdrop, so the subject is simply the part of the frame that is not the backdrop. Sample
the backdrop from the top edge, mark every pixel that differs from it, and the first row
carrying a real run of marked pixels is the top of the head. The horizontal centre comes
from the marked pixels in the upper quarter, which is head and shoulders rather than the
body. The square is then placed to leave a set fraction of headroom above the crown.

Falls back to a top-biased crop if the backdrop is not plain enough to separate -- which is
still better than centring on the middle, and it says so when it does.

    python tools/square_headshot.py "headshots/Schwiebert,Loren.jpg"
    python tools/square_headshot.py "headshots/Schwiebert,Loren.jpg" --dry-run
"""
from __future__ import annotations

import argparse
import shutil
import sys
from pathlib import Path

import numpy as np
from PIL import Image

HEADROOM = 0.11          # fraction of the square left above the crown
MIN_RUN = 0.03           # a row is "subject" once this fraction of it differs from backdrop
DIFF = 34                # per-channel distance from the backdrop that counts as subject


def head_box(a: np.ndarray):
    """(top row of the head, centre column of the head), or None if the backdrop is busy."""
    h, w, _ = a.shape
    # the backdrop, from the top edge -- in a headshot that strip is never the subject
    bg = np.median(a[: max(2, h // 40)].reshape(-1, 3), axis=0)
    mask = (np.abs(a.astype(np.int16) - bg).max(axis=2) > DIFF)

    # a plain backdrop leaves the top rows almost empty; if they are not, this is a busy
    # photograph and the estimate cannot be trusted
    if mask[: h // 20].mean() > 0.25:
        return None

    rows = mask.mean(axis=1)
    hits = np.where(rows > MIN_RUN)[0]
    if not len(hits):
        return None
    top = int(hits[0])
    band = mask[top: top + max(1, h // 4)]
    cols = np.where(band.any(axis=0))[0]
    if not len(cols):
        return None
    return top, int((cols.min() + cols.max()) / 2)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("image")
    ap.add_argument("--headroom", type=float, default=HEADROOM)
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--no-backup", action="store_true")
    a = ap.parse_args()

    p = Path(a.image)
    im = Image.open(p).convert("RGB")
    w, h = im.size
    if abs(w - h) <= 2:
        print(f"  {p.name} is already square ({w}x{h}) -- nothing to do")
        return 0

    arr = np.asarray(im)
    S = min(w, h)
    found = head_box(arr)
    if found is None:
        top, cx = int(0.04 * h), w // 2
        print("  ! backdrop is not plain enough to find the head; using a top-biased crop")
    else:
        top, cx = found
        print(f"  head starts at y={top} ({100 * top / h:.0f}% down), "
              f"centred on x={cx} ({100 * cx / w:.0f}% across)")

    y0 = int(round(top - a.headroom * S))
    x0 = int(round(cx - S / 2))
    y0 = max(0, min(y0, h - S))
    x0 = max(0, min(x0, w - S))
    print(f"  {w}x{h} -> {S}x{S} at ({x0}, {y0}); "
          f"crown sits {100 * (top - y0) / S:.0f}% down the square")

    if a.dry_run:
        return 0
    if not a.no_backup:
        bak = p.with_suffix(p.suffix + ".orig")
        if not bak.exists():
            shutil.copy2(p, bak)
            print(f"  original kept at {bak.name}")
    im.crop((x0, y0, x0 + S, y0 + S)).save(p, quality=92, subsampling=1)
    print(f"  wrote {p}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
