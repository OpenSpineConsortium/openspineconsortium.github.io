"""Does the DEPLOYED page reproduce the offline pipeline's clinical numbers on real film?

Drives the live site over a set of BUU-LSPINE test radiographs and scores SS and LL
against ground truth, so the browser is measured the same way `scripts/evaluate_yolo.py`
measures the Python pipeline. The decode is already proven identical (test_decode.mjs,
1e-3 px on the same raw tensor); what this catches is everything AROUND the decode --
JPEG decoding, canvas resampling, WebGPU kernels -- which the tensor-level test cannot
see because it starts after preprocessing.

That gap is not hypothetical: canvas `drawImage` at `imageSmoothingQuality: "high"`
area-averages a 3.8x downscale, while the training pipeline's cv2 INTER_LINEAR does not,
and on single films that moved LL by up to 1.6 deg.

    python pacs/tools/test_buu_live.py <dir with N.jpg + N.txt> [--url ...] [--quality high]

No radiograph is committed to this repo; point it at a local directory.
"""
import argparse, pathlib, statistics, sys

import numpy as np
from PIL import Image


def ang_h(v):
    a = abs(np.degrees(np.arctan2(v[1], v[0])))
    return 180 - a if a > 90 else a


def cobb(a, b):
    c = float(np.dot(a, b) / (np.linalg.norm(a) * np.linalg.norm(b)))
    d = np.degrees(np.arccos(np.clip(c, -1, 1)))
    return 180 - d if d > 90 else d


def gt_angles(jpg: pathlib.Path, txt: pathlib.Path):
    W, H = Image.open(jpg).size
    inst = []
    for line in txt.read_text().strip().splitlines():
        p = [float(v) for v in line.split()]
        k = np.array(p[5:]).reshape(4, 3)
        inst.append((p[2] * H, np.stack([k[:, 0] * W, k[:, 1] * H], 1)))
    if len(inst) < 6:
        return None
    inst.sort(key=lambda r: -r[0])
    s1, l1 = inst[0][1], inst[5][1]
    return ang_h(s1[1] - s1[0]), cobb(l1[1] - l1[0], s1[1] - s1[0])


METRICS_JS = """() => { const o = {};
  document.querySelectorAll('#metricBtns .metric').forEach(b => {
    const k = b.querySelector('.metric__k')?.textContent;
    const v = b.querySelector('.metric__v')?.textContent;
    if (k) o[k] = v; });
  return o; }"""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("dir")
    ap.add_argument("--url", default="https://openspineconsortium.com/pacs/")
    ap.add_argument("--quality", default=None,
                    help="override canvas imageSmoothingQuality (high|medium|low)")
    ap.add_argument("--n", type=int, default=40)
    a = ap.parse_args()

    d = pathlib.Path(a.dir)
    films = sorted(d.glob("*.jpg"))[:a.n]
    from playwright.sync_api import sync_playwright

    ss_e, ll_e, nfound, misses, times = [], [], [], [], []
    with sync_playwright() as p:
        br = p.chromium.launch(headless=False, args=["--force_high_performance_gpu"])
        pg = br.new_page(viewport={"width": 1680, "height": 1000})
        pg.goto(a.url, wait_until="networkidle")
        if a.quality:
            # Patch the canvas hint before any inference, to compare resampling kernels
            # without shipping a change.
            pg.evaluate("""(q) => {
                const orig = OffscreenCanvas.prototype.getContext;
                OffscreenCanvas.prototype.getContext = function (...args) {
                    const cx = orig.apply(this, args);
                    if (cx && 'imageSmoothingQuality' in cx) {
                        Object.defineProperty(cx, 'imageSmoothingQuality',
                            { get: () => q, set: () => {}, configurable: true });
                    }
                    return cx;
                };
            }""", a.quality)
            print(f"  imageSmoothingQuality forced to {a.quality!r}")

        for i, jpg in enumerate(films):
            txt = jpg.with_suffix(".txt")
            gt = gt_angles(jpg, txt) if txt.exists() else None
            if gt is None:
                continue
            if pg.is_visible("#clearUser"):
                pg.click("#clearUser")
                pg.wait_for_selector("#dropPrompt:not([hidden])")
            pg.set_input_files("#fileInput", str(jpg))
            try:
                pg.wait_for_function(
                    "document.querySelectorAll('#uoverlay .lm__hit').length>0",
                    timeout=180000)
            except Exception:
                misses.append(jpg.name)
                continue
            m = pg.evaluate(METRICS_JS)
            hud = pg.inner_text("#hudUser")
            nfound.append(int(hud.split("·")[-1].strip().split()[0])
                          if "vertebrae" in hud else 0)
            times.append(float(pg.inner_text("#timing").split(" ms")[0]))
            if m.get("SS", "n/a") != "n/a":
                ss_e.append(abs(float(m["SS"].rstrip("°")) - gt[0]))
            if m.get("LL", "n/a") != "n/a":
                ll_e.append(abs(float(m["LL"].rstrip("°")) - gt[1]))
            print(f"  [{i+1:2d}/{len(films)}] {jpg.name:<20} "
                  f"SS {m.get('SS','n/a'):>7} (gt {gt[0]:5.1f})  "
                  f"LL {m.get('LL','n/a'):>7} (gt {gt[1]:5.1f})")
        br.close()

    print(f"\n  films scored          : {len(ss_e)}")
    print(f"  vertebrae found       : {statistics.mean(nfound):.2f} / 6 "
          f"({sum(n == 6 for n in nfound)}/{len(nfound)} complete)")
    print(f"  SS MAE vs ground truth: {statistics.mean(ss_e):.2f} deg   "
          f"median {statistics.median(ss_e):.2f}   "
          f"<=5 deg {100*sum(e<=5 for e in ss_e)/len(ss_e):.0f}%")
    print(f"  LL MAE vs ground truth: {statistics.mean(ll_e):.2f} deg   "
          f"median {statistics.median(ll_e):.2f}   "
          f"<=5 deg {100*sum(e<=5 for e in ll_e)/len(ll_e):.0f}%")
    print(f"  inference             : median {statistics.median(times):.0f} ms")
    if misses:
        print(f"  NO DETECTION on       : {misses}")


if __name__ == "__main__":
    main()
