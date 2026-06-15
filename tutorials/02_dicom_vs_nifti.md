# Tutorial 2 — DICOM vs. NIfTI: What's Inside a Medical Image

*AI Imaging Workshop · the 10:00 AM "DICOM / NIFTI File Overview" block.*
*Prerequisite: Tutorial 1 (you have the `imaging` conda environment).*

A medical image is not a picture — it is a **3-D grid of numbers** plus the
information needed to place that grid in the patient's body. In this tutorial you
open both file formats we use, see exactly what they contain, and load a real CT
scan with its segmentation.

```bash
conda activate imaging          # from Tutorial 1
mkdir -p ~/workshop && cd ~/workshop
```

---

## 1. The two formats, in one sentence each

- **DICOM** (`.dcm`) — what the **scanner** produces: typically **one file per
  slice**, each carrying a large header of metadata (patient, scanner, geometry).
- **NIfTI** (`.nii` / `.nii.gz`) — what **research and ML** use: the **whole
  volume in one file**, with a compact header and an *affine* that places it in
  space. Our dataset ships as NIfTI.

Think of DICOM as the clinical archive format and NIfTI as the analysis format.
Converting DICOM → NIfTI is a routine first step (tools like `dcm2niix`).

---

## 2. Get a real CT + label to look at

We'll pull one case from the workshop dataset on HuggingFace (a fused case with
both spine and pelvis labelled):

```bash
BASE="https://huggingface.co/datasets/anonymous-mlhc/CTSpinoPelvic1K/resolve/v2"
curl -L -o ct.nii.gz    "$BASE/ct/0010_ct.nii.gz"
curl -L -o label.nii.gz "$BASE/labels/0010_label.nii.gz"
```

---

## 3. Open a NIfTI and read its anatomy

**The three things every volume has:** the *array* (the numbers), the *affine*
(where it sits in the body), and the *header* (metadata). Run:

```bash
python - <<'PY'
import nibabel as nib, numpy as np
img = nib.load("ct.nii.gz")
arr = np.asarray(img.dataobj)            # the 3-D array of intensities

print("shape (voxels):", arr.shape)      # e.g. (512, 512, 480) = columns, rows, slices
print("dtype          :", arr.dtype)     # how each number is stored (int16 for CT)
print("voxel size (mm):", img.header.get_zooms()[:3])   # physical size of one voxel
print("intensity range:", int(arr.min()), "to", int(arr.max()))
print("\naffine (voxel -> world mm):\n", np.round(img.affine, 2))
print("orientation    :", nib.aff2axcodes(img.affine))  # e.g. ('L','A','S')
PY
```

**What you are seeing:**
- **shape** — the volume is `columns × rows × slices` of voxels (3-D pixels).
- **voxel size** — each voxel is a real physical box (e.g. `0.8 × 0.8 × 1.0` mm).
- **affine** — a 4×4 matrix that converts a voxel index `(i, j, k)` into a
  millimetre position in the patient. It encodes spacing **and orientation**.
- **orientation codes** (e.g. `('L','A','S')`) — which anatomical direction each
  axis points. This is the single most important thing to get right when
  combining datasets: two scans of the *same* patient saved by different tools
  can have **flipped axes**, which silently mirrors left/right if you ignore the
  affine. (This exact bug — a Y-axis flip between our two source datasets — is a
  finding in the workshop's own paper.)

---

## 4. Hounsfield Units: what the CT numbers mean

CT intensities are **Hounsfield Units (HU)**, a calibrated scale:

| Tissue        | Approx. HU      |
|---------------|-----------------|
| Air           | −1000           |
| Fat           | −100 to −50     |
| Water         | 0               |
| Soft tissue   | +30 to +80      |
| **Bone**      | **+200 and up** |

This is why a simple rule like "voxel > 200 HU = bone" works — and it's exactly
how our pipeline finds the right CT for each mask. Check it:

```bash
python - <<'PY'
import nibabel as nib, numpy as np
ct = np.asarray(nib.load("ct.nii.gz").dataobj)
print("fraction of voxels that are bone (>200 HU): %.3f" % (ct > 200).mean())
print("fraction that are air (<-500 HU)          : %.3f" % (ct < -500).mean())
PY
```

Because HU spans −1000…+2000 but a screen shows ~256 grey levels, you **window**:
pick a centre and width and map that range to black→white. A typical *soft-tissue*
window is centre 40 / width 400; a *bone* window is centre 400 / width 1800.

---

## 5. Open the label and overlay it

A **segmentation label** is a NIfTI on the *same grid* as the CT, where each
voxel holds a **class number** instead of an intensity. Our 10-class scheme:

```
0 = background   1..5 = L1..L5   6 = L6 (transitional)   7 = sacrum
8 = left hip     9 = right hip
```

```bash
python - <<'PY'
import nibabel as nib, numpy as np
ct  = nib.load("ct.nii.gz")
lab = nib.load("label.nii.gz")
a, l = np.asarray(ct.dataobj), np.asarray(lab.dataobj)

assert a.shape == l.shape, "CT and label must share the same grid!"
names = {0:"background",1:"L1",2:"L2",3:"L3",4:"L4",5:"L5",
         6:"L6",7:"sacrum",8:"left_hip",9:"right_hip"}
for v in np.unique(l):
    print(f"  class {int(v):>2} {names.get(int(v),'?'):<10} {int((l==v).sum()):>10} voxels")
PY
```

The CT and its label **must be the same shape and affine** — that is what lets
you overlay them voxel-for-voxel. (When two files disagree, you `resample` one
onto the other's grid using SimpleITK — a Tutorial-5 topic.)

---

## 6. Make a picture: a windowed slice with the label on top

This renders one axial slice through the middle of the volume, CT in greyscale
with the segmentation coloured on top, and saves it as a PNG:

```bash
python - <<'PY'
import nibabel as nib, numpy as np
import matplotlib; matplotlib.use("Agg")
import matplotlib.pyplot as plt

ct  = np.asarray(nib.load("ct.nii.gz").dataobj)
lab = np.asarray(nib.load("label.nii.gz").dataobj)
k = ct.shape[2] // 2                                  # middle slice index

def window(img, center=40, width=400):                # soft-tissue window -> [0,1]
    lo, hi = center - width/2, center + width/2
    return np.clip((img - lo) / (hi - lo), 0, 1)

fig, ax = plt.subplots(figsize=(6, 6))
ax.imshow(window(ct[:, :, k]).T, cmap="gray", origin="lower")
masked = np.ma.masked_where(lab[:, :, k] == 0, lab[:, :, k])
ax.imshow(masked.T, cmap="tab10", alpha=0.5, origin="lower", vmin=0, vmax=9)
ax.set_title(f"axial slice {k}"); ax.axis("off")
fig.savefig("slice.png", dpi=120, bbox_inches="tight")
print("wrote slice.png")
PY
```

Open `slice.png` (download it to your laptop, or view it in VS Code) — you should
see the lumbar vertebrae, sacrum, and hips coloured over the bone.

---

## 7. (Optional) Peek inside a DICOM

If you have a `.dcm` file, this is how you'd read its metadata and pixels and
convert to HU (DICOM stores raw values that need a rescale slope/intercept):

```bash
python - <<'PY'
import pydicom, numpy as np
ds = pydicom.dcmread("yourfile.dcm")          # one slice
print("Patient ID  :", ds.get("PatientID"))
print("Modality    :", ds.get("Modality"))
print("Rows x Cols :", ds.Rows, "x", ds.Columns)
hu = ds.pixel_array * float(ds.RescaleSlope) + float(ds.RescaleIntercept)
print("HU range    :", int(hu.min()), "to", int(hu.max()))
PY
```

Note the **PatientID** tag — it survives into filenames and is how our pipeline
groups masks by patient, while the per-scan **SeriesInstanceUID** is what gets
lost in conversion (the alignment problem in the paper).

---

## Recap

- Medical images are **arrays + an affine** (geometry), not pictures.
- **DICOM** = scanner format (per-slice + rich metadata); **NIfTI** = analysis
  format (one volume + affine). Our data is NIfTI.
- **HU** make tissue identifiable by number; **windowing** makes it viewable.
- A **label** is a same-grid NIfTI of class ids (0–9 here).
- Always respect the **affine/orientation** — it's where silent left/right and
  alignment bugs hide.

**Next:** *Inference with a pretrained nnU-Net* — run a trained model on `ct.nii.gz`
and produce a label like the one you just inspected.
