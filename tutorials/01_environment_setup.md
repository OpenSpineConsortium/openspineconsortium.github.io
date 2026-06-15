# Tutorial 1 — Setting Up Your Environment

*AI Imaging Workshop · WSUSOM · the 9:30 AM "Python / SLURM / Good Programming
Practices" block.*

By the end of this tutorial you will have, on the WSU grid (and/or your own
laptop):

1. **Miniforge** — Python plus **`mamba`**, a fast package manager that keeps
   each project's software isolated and reproducible.
2. An **imaging environment** with the libraries we use to read and manipulate
   CT scans and segmentation labels (`nibabel`, `SimpleITK`, `pydicom`, …).
3. **Nextflow** — the tool we use to run reproducible, parallel pipelines on
   the SLURM cluster.

You only do this once. Everything is copy-paste; read the one-line explanation
above each block so you know *what* you are running, not just *that* it runs.

> **No grid account? Use your laptop — it all works the same.** Every step below
> runs identically on your own machine; you just install Miniforge locally
> instead of on the grid. The *only* thing that changes per-platform is the
> **installer file** in Step 1 (Linux / macOS / Windows-WSL), which we call out
> there. If you *do* have a grid account, install on the grid so your
> environment sits right next to the GPUs you'll use in Tutorial 5.

---

## 0. Open a terminal

Everything below is typed into a **terminal** (a text window where you run
commands).

**On the WSU grid** (replace `youraccessid` with your WSU AccessID):

```bash
ssh youraccessid@grid.wayne.edu
```

You know you are in the right place when each line starts with a prompt like
`[youraccessid@warrior ~]$`.

**On your own laptop** (no grid account needed):

- **macOS** — open the **Terminal** app (Applications → Utilities → Terminal).
- **Linux** — open your terminal app.
- **Windows** — install **WSL** (Windows Subsystem for Linux) once: open
  **PowerShell** and run `wsl --install`, reboot if asked, then open the
  **Ubuntu** app. That gives you a Linux terminal where every command below
  works unchanged.

---

## 1. Install Miniforge (Python + mamba)

**What it is:** Miniforge bundles Python and **`mamba`** — a fast, drop-in
replacement for `conda` that downloads software libraries and keeps them in
self-contained "environments" so two projects can never break each other's
dependencies. It defaults to the open `conda-forge` channel, so there's nothing
extra to configure. (`mamba` and `conda` are interchangeable and share the same
environments; we use `mamba` because it resolves dependencies much faster.)

**Download the installer** (Linux x86-64 — this is the grid and most laptops):

```bash
cd ~
curl -L -o miniforge.sh \
  https://github.com/conda-forge/miniforge/releases/latest/download/Miniforge3-Linux-x86_64.sh
```

> **On a Mac**, swap the installer for your chip:
> - Apple Silicon (M1/M2/M3/M4): `Miniforge3-MacOSX-arm64.sh`
> - Intel Mac: `Miniforge3-MacOSX-x86_64.sh`
>
> (Same URL prefix, just change the filename at the end. On **Windows**, you're
> inside WSL/Ubuntu, so use the **Linux** installer above.)

**Run the installer** (`-b` = accept defaults, `-p` = where to put it):

```bash
bash miniforge.sh -b -p ~/miniforge3
rm miniforge.sh                     # tidy up the installer
```

**Turn it on** so your shell knows where to find `mamba`, now and in every
future session:

```bash
~/miniforge3/bin/conda init bash
source ~/.bashrc                    # reload the shell so 'mamba' works now
```

You should now see `(base)` at the start of your prompt — that is the default
environment, telling you it is active.

---

## 2. Create the imaging environment

**Why a separate environment:** we keep the workshop's libraries in their own
named space (`imaging`) so that installing or upgrading something later never
disturbs anything else. Activating it is how you "enter" that space.

**Create it with Python 3.11:**

```bash
mamba create -n imaging python=3.11 -y
mamba activate imaging
```

Your prompt now shows `(imaging)` instead of `(base)` — you are inside the new
environment. (Run `mamba activate imaging` at the start of any future session.)

**Install the imaging libraries** — these are the tools for reading and editing
CT scans and label maps:

```bash
mamba install -y \
  numpy scipy pandas matplotlib \
  nibabel pydicom simpleitk scikit-image
```

What each one is for:

| Package        | What you use it for                                              |
|----------------|-----------------------------------------------------------------|
| `numpy`        | the array — every CT volume and label map is a 3-D NumPy array  |
| `scipy`        | image operations: connected components, morphology, resampling  |
| `nibabel`      | read/write **NIfTI** (`.nii.gz`) — the format our labels ship in |
| `pydicom`      | read **DICOM** — the raw format scanners produce                |
| `SimpleITK`    | resampling, registration, format conversion (DICOM ↔ NIfTI)     |
| `scikit-image` | extra image analysis (region labelling, measurements)           |
| `pandas`       | tables — reading the dataset manifest / writing results to CSV  |
| `matplotlib`   | plotting slices and figures                                     |

---

## 3. Install Nextflow (for running pipelines on SLURM)

**What it is:** Nextflow runs multi-step analysis pipelines and submits the work
to the SLURM scheduler for you — in parallel, and reproducibly (the same command
gives the same result, on your laptop or the cluster). Nextflow needs **Java**,
which mamba installs alongside it:

```bash
mamba install -y -c bioconda nextflow
```

That single command pulls in both Nextflow and a compatible Java runtime into
your `imaging` environment.

---

## 4. Check that everything works

**Python libraries** — this prints the version of each and a final "OK":

```bash
python - <<'PY'
import numpy, scipy, pandas, matplotlib, nibabel, pydicom, SimpleITK, skimage
print("numpy     ", numpy.__version__)
print("scipy     ", scipy.__version__)
print("nibabel   ", nibabel.__version__)
print("pydicom   ", pydicom.__version__)
print("SimpleITK ", SimpleITK.__version__)
print("skimage   ", skimage.__version__)
print("ALL IMPORTS OK")
PY
```

**Nextflow and Java:**

```bash
nextflow -version
java -version
```

If you see version numbers and `ALL IMPORTS OK`, your environment is ready.

**A 30-second real test** — make a tiny 3-D volume, save it as NIfTI, read it
back. This is exactly the read/write loop you'll use on real scans:

```bash
python - <<'PY'
import numpy as np, nibabel as nib
vol = np.random.randint(0, 100, size=(8, 8, 8)).astype(np.int16)   # fake volume
nib.save(nib.Nifti1Image(vol, affine=np.eye(4)), "test.nii.gz")    # write
back = np.asarray(nib.load("test.nii.gz").dataobj)                 # read
print("round-trip identical:", np.array_equal(vol, back))
PY
rm -f test.nii.gz
```

`round-trip identical: True` means you can load, edit, and save medical images.

---

## 5. Everyday use (after today)

Each time you log in and want to work, just activate the environment:

```bash
mamba activate imaging
```

To leave it:

```bash
mamba deactivate
```

To see your environments, or remove one and start over:

```bash
mamba env list                      # list all environments
mamba env remove -n imaging         # delete 'imaging' if you want a clean redo
```

---

## Troubleshooting

- **`mamba: command not found`** after Step 1 → you missed `source ~/.bashrc`,
  or open a fresh terminal. As a fallback: `source ~/miniforge3/bin/activate`.
- **`mamba activate` says "run mamba init first"** → run
  `~/miniforge3/bin/conda init bash` then `source ~/.bashrc`. (`conda init` sets
  up the shell hook that both `mamba` and `conda` use.)
- **A package can't be found** → it may live on another channel; add it for that
  one install, e.g. `mamba install -y -c bioconda <pkg>` (as we do for Nextflow).
- **`nextflow: command not found`** → make sure `imaging` is active
  (`mamba activate imaging`); Nextflow was installed *into* that environment.
- **Out of disk space in your home directory on the grid** → environments are
  large. Ask whether to place `~/miniforge3` on a project/scratch filesystem
  instead of home. (On a laptop this is rarely an issue.)

---

**Next tutorial:** *DICOM vs. NIfTI — what's actually inside a medical image
file*, where we open a real CT scan and its segmentation with the tools you just
installed.
