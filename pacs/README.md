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
- SVA / TPA are out of scope on this FOV (no C7 / T1).

## Notes for production
- Pin the NiiVue version in `pacs.js` (`…/@niivue/niivue@X.Y.Z/+esm`) once verified.
- The angle overlay maps world mm → NiiVue's on-screen sagittal tile each frame;
  if a NiiVue upgrade changes `screenSlices` / `mm2frac`, adjust `mmToPx()`.
