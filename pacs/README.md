# Spinopelvic PACS demo

A NiiVue-based PACS-style viewer for CTSpinoPelvic1K. It loads a real CT +
segmentation, toggles the masks, and renders spinopelvic angles — **PI, SS, PT,
LL** — that were computed by [OpenSpineToolkit (`ostk`)](https://github.com/Gregory-Schwing-MD-PhD/OpenSpineToolkit).
Values are precomputed (`metrics.json`); clicking a measurement animates the
construction on the sagittal view to simulate a live PACS measurement.

## Run locally
NiiVue fetches `.nii.gz` over HTTP, so open it through a server (not `file://`):
```bash
# from the repo root
python -m http.server 8000
# then visit  http://localhost:8000/pacs/
```
On GitHub Pages it just works at `/pacs/`.

## Data bundles (`data/<case>/`)
Each case is `ct.nii.gz` + `seg.nii.gz` + `metrics.json`, listed in
`data/manifest.json`. Bundles are generated from a full case by ostk's exporter,
which **crops to the bone bounding box, optionally bone-masks, and downsamples** —
turning a ~300 MB CT into ~1 MB:
```bash
# in the OpenSpineToolkit repo
python tools/export_demo_case.py \
  --ct 0001_ct.nii.gz --label 0001_label.nii.gz \
  --case-id 0001 --title "Case 0001" \
  --out-dir ../openspineconsortium.github.io/pacs/data \
  --crop-margin 20 --mask-bone --downsample 2
```
`metrics.json` carries the ostk summary plus each angle's world-mm geometry
(`vertex`, `tip1`, `tip2`) which the viewer maps onto NiiVue's sagittal slice.

## Status
- **PI / SS / PT** need the **femoral-head GT (ids 11/12)** → they light up on
  **v3** cases. On pre-v3 cases (no femurs) those buttons are disabled and **LL**
  (which only needs L1 + S1) is shown. Re-export any case once v3 lands to unlock
  the full set.

## Notes for production
- Pin the NiiVue version in `pacs.js` (`…/@niivue/niivue@X.Y.Z/+esm`) once verified.
- The angle overlay maps world mm → NiiVue's on-screen sagittal tile each frame;
  if a NiiVue upgrade changes `screenSlices` / `mm2frac`, adjust `mmToPx()`.

---

# X-ray tab (`/pacs/`)

Two panes. The left one is a reference case; the right one runs a trained detector
**in the browser** on a film you supply.

## Reference pane

A DRR of the same CT the other tab renders in 3-D, built by
`tools/export_xr_demo_case.py`, carrying the shared `metrics.json` contract with
`geometry.space = "image_px"`. Two things it now also carries:

* `geometry.landmarks[]` — 13 named points: the anterior and posterior ends of each
  superior endplate L1–S1, plus the bicoxofemoral point. Each is
  `{id, level, cls, label, xy, color, desc}` and is hoverable on the film.
* a **0.35 mm/px** render (743 × 1200) rather than 1.0 mm/px (260 × 420). Four angle
  lines were legible at the coarse spacing; 13 individually hoverable corner markers
  are not. Set `SPACING=` to change it.

The corners are derived in **3-D and projected**, not read off the 2-D silhouette —
`endplate_corners()` takes the endplate plane ostk already fitted, keeps the voxels
within 3 mm of it, and returns the extremes along the endplate direction. On a
lateral view the sacral ala superimposes on the S1 plate, so a silhouette-derived
sacral corner is simply the wrong point.

## Inference pane

`infer.js` runs **YOLO11n-Pose** (ONNX, opset 12) with onnxruntime-web: WebGPU where
available, single-threaded WASM otherwise. Nothing is uploaded — there is no endpoint
that could receive an image.

Input paths: drag-and-drop anywhere on the window, **clipboard paste** (Ctrl-V of a
PACS screenshot), or a file picker.

| | |
|---|---|
| weights | `models/v11n_640.onnx`, `models/v11n_1024.onnx` (11 MB each) |
| keypoints | 4/instance, order `sup_ant, sup_post, inf_ant, inf_post` — **positional**, a contract with the weights |
| confidence | 0.5, matching `scripts/evaluate_yolo.py` and the published baseline |
| NMS IoU | 0.7, the Ultralytics predict default |
| reported | SS, LL. PI and PT are shown `n/a` — both need femoral head centres and no hip landmark survives on a real film |

`v8l` is the more accurate model but exports to **170 MB**, which is not a web page.
`v11n` costs about 3 points of strict-threshold accuracy and fits in 11 MB.

### Measured latency

One film, same weights, identical output to 0.1° on all three:

| backend | median |
|---|---|
| WebGPU, NVIDIA Turing (discrete) | **133 ms** |
| WebGPU, Intel Gen-9 (integrated) | 445 ms |
| WASM, single-threaded CPU | 1093 ms |

Chromium exposes **one** adapter, fixed when the GPU process launches — so
`powerPreference` does not pick the discrete card on Windows. The OS per-app graphics
setting does. The engine badge names the adapter it got, for exactly this reason.

Threads would speed the WASM path up, but they need `SharedArrayBuffer`, which needs
COOP/COEP headers, which GitHub Pages does not send.

### Mirroring

The keypoint slots are **handed**: a film facing the other way puts every anterior
corner on the posterior wall. This is not a defect to paper over — horizontal-flip
augmentation was measured as the single most damaging augmentation on this task, and
the corner-identity matrix shows the model learned handedness cleanly. So the page
offers one explicit **Mirror left ↔ right** control instead of guessing. Tested: a
wrong-facing film reads SS 1.3° / LL n/a, and one click restores 29.7° / 31.8°.

## Tests

```bash
node pacs/tools/test_decode.mjs <ref_dir>       # JS decode == Python onnxruntime
python pacs/tools/test_page.py <film.jpg>       # headless: panes, paste, mirror, errors
python pacs/tools/test_webgpu.py <film.jpg>     # headed: real adapter, real latency
```

`test_decode.mjs` feeds the **same raw network output** dumped from Python into
`infer.js` and asserts every box, keypoint and confidence matches to 1e-3 px. It is
the only thing standing between a permuted keypoint slot and a page that reports a
confident wrong angle.

**No radiographs are committed to this repo.** The reference pane is a DRR of a CT
case; BUU-LSPINE is evaluation-only and is not redistributed here.

### Does the deployed page match the offline pipeline?

`test_decode.mjs` proves the decode is identical on the same raw tensor, but it starts
*after* preprocessing — it cannot see JPEG decoding, canvas resampling or WebGPU
kernels. Canvas `drawImage` at `imageSmoothingQuality: "high"` area-averages a ~3.8×
downscale where the training pipeline's cv2 `INTER_LINEAR` does not, and on individual
films that moved LL by up to **1.6°**.

So the browser is scored end to end against ground truth on real film
(`tools/test_buu_live.py`), on the **same 40 BUU test radiographs** the offline sweep
uses:

| | vertebrae | SS MAE | LL MAE |
|---|---|---|---|
| offline (onnxruntime, Python) | 6.00 / 6 | 2.79° | 3.81° |
| **live site (WebGPU)** | 6.05 / 6, 38/40 complete | **2.86°** | **3.86°** |

Within **0.07°**. The per-film resampling differences are real but unbiased, and cancel
over the set. Median inference 264 ms.

No radiograph is committed here — point the script at a local directory.
