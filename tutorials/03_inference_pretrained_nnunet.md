# Tutorial 3 — Inference with a Pretrained nnU-Net

*AI Imaging Workshop · the 10:15 AM "CNNs, nnU-Net, Inference using a pre-trained
model" block.*
*Prerequisites: Tutorials 1–2 (you have the `imaging` env and the `ct.nii.gz`
you downloaded).*

You will run a **trained** spinopelvic segmentation model on a CT scan and get
back a 10-class label map — no training, just prediction ("inference").

---

## 1. The idea in 90 seconds

A **convolutional neural network (CNN)** for segmentation takes the 3-D CT volume
and outputs, for **every voxel**, a predicted class (background, L1, …, right
hip). It learned this by seeing many CT-and-label pairs during *training*.

**nnU-Net** is not a single network — it is a framework that **auto-configures**
a U-Net (the standard segmentation architecture) to your data: it picks the patch
size, spacing, and normalization for you. That is why it's the default baseline
in medical imaging. We use **nnU-Net v2**.

Two phases, never mix them up:
- **Training** — fit the model on labelled data (Tutorial 5, hours on a GPU).
- **Inference** — apply the finished model to a new scan (this tutorial, seconds
  to minutes).

---

## 2. Install nnU-Net v2 and PyTorch

nnU-Net runs on **PyTorch**. Install into the `imaging` env:

```bash
conda activate imaging

# PyTorch — GPU build if you have an NVIDIA GPU, else CPU build:
pip install torch --index-url https://download.pytorch.org/whl/cu121   # NVIDIA GPU
# pip install torch                                                    # CPU only

pip install nnunetv2
```

Check the GPU is visible (prints `True` on a GPU machine/node; `False` is fine,
it just runs slower on CPU):

```bash
python -c "import torch; print('GPU available:', torch.cuda.is_available())"
```

> On the WSU grid you must be **on a GPU node** for `True` — you'll request one
> with SLURM in Tutorial 5. For now, CPU inference on one scan is fine.

---

## 3. Tell nnU-Net where things live

nnU-Net finds models through three environment variables. Create the folders and
point at them:

```bash
mkdir -p ~/workshop/nnunet/{raw,preprocessed,results}
export nnUNet_raw=~/workshop/nnunet/raw
export nnUNet_preprocessed=~/workshop/nnunet/preprocessed
export nnUNet_results=~/workshop/nnunet/results
```

(Put those four `export` lines in your `~/.bashrc` so you don't retype them.)

---

## 4. Download the pretrained model

The workshop's trained 5-fold checkpoints are public. Pull them with the
HuggingFace CLI into `nnUNet_results`:

```bash
pip install -U "huggingface_hub[cli]"
hf download anonymous-mlhc/spinopelvic-seg-checkpoints \
  --local-dir "$nnUNet_results" --repo-type model
```

After this, `$nnUNet_results` contains a `Dataset.../nnUNetTrainer...` folder —
that is the trained model nnU-Net will load. (If the layout differs, the model
repo's README gives the exact `Dataset` id and folder to use below.)

---

## 5. Prepare the input

nnU-Net expects input files named `<case>_0000.nii.gz` (the `_0000` means
"channel 0" — CT is a single-channel modality). Set up an input and output
folder:

```bash
mkdir -p ~/workshop/infer_in ~/workshop/infer_out
cp ~/workshop/ct.nii.gz ~/workshop/infer_in/case_0000.nii.gz
```

---

## 6. Run inference

`nnUNetv2_predict` does everything (resample → predict → resample back). Fill in
the dataset id / configuration from the model README (typical values shown):

```bash
nnUNetv2_predict \
  -i ~/workshop/infer_in \
  -o ~/workshop/infer_out \
  -d 1 \
  -c 3d_fullres \
  -f 0
```

- `-i` / `-o` — input and output folders
- `-d` — dataset id of the trained model
- `-c 3d_fullres` — the configuration (full-resolution 3-D)
- `-f 0` — use fold 0 of the cross-validation (use `-f 0 1 2 3 4` to ensemble all
  five for the best result, at 5× the time)

When it finishes, `~/workshop/infer_out/case.nii.gz` is your predicted 10-class
label.

---

## 7. Look at the prediction

Reuse the inspection from Tutorial 2 — print the classes the model produced:

```bash
python - <<'PY'
import nibabel as nib, numpy as np
p = np.asarray(nib.load("/root/workshop/infer_out/case.nii.gz".replace("/root", __import__("os").path.expanduser("~"))).dataobj)
names = {0:"background",1:"L1",2:"L2",3:"L3",4:"L4",5:"L5",
         6:"L6",7:"sacrum",8:"left_hip",9:"right_hip"}
for v in np.unique(p):
    print(f"  class {int(v):>2} {names.get(int(v),'?'):<10} {int((p==v).sum()):>10} voxels")
PY
```

Then render it over the CT with the **same plotting code from Tutorial 2,
section 6** (point it at `infer_out/case.nii.gz` instead of `label.nii.gz`). You
now have a model-made segmentation you can compare to the ground-truth label.

---

## 8. Did it work well? A first metric

The standard segmentation score is the **Dice coefficient**: overlap between
prediction and ground truth, from 0 (none) to 1 (perfect). Per class:

```bash
python - <<'PY'
import nibabel as nib, numpy as np, os
gt   = np.asarray(nib.load(os.path.expanduser("~/workshop/label.nii.gz")).dataobj)
pred = np.asarray(nib.load(os.path.expanduser("~/workshop/infer_out/case.nii.gz")).dataobj)
for c in range(1, 10):
    g, p = gt == c, pred == c
    denom = g.sum() + p.sum()
    dice = 2 * (g & p).sum() / denom if denom else float("nan")
    print(f"  class {c}: Dice = {dice:.3f}")
PY
```

Dice near 0.9 is strong for vertebrae; lower at the L5/S1 junction is exactly the
hard region the benchmark studies.

---

## Recap & gotchas

- **Inference = applying a finished model**; nnU-Net auto-configures a U-Net.
- The three `nnUNet_*` env vars + the `_0000` filename convention are the two
  things that trip everyone up.
- CPU works for a single scan; real throughput needs a **GPU node** (Tutorial 5).
- Score with **Dice**, per class, and watch the **junction**.

**Next:** *AI-powered annotation in ITK-SNAP* — when there's no model for your
structure yet, segment interactively with an AI assistant.
