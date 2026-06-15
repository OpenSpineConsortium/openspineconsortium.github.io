# Tutorial 5 — Training Your Own Network on the WSU Grid

*AI Imaging Workshop · the 11:00 AM "Training your own neural network using the
WSU grid" block (and the 9:30 SLURM / reproducible-computing themes).*
*Prerequisites: Tutorials 1 & 3 (the `imaging` env, nnU-Net v2 installed).*

Training needs a **GPU for hours**, so it runs on the **WSU grid** through the
**SLURM** scheduler — you write a small script describing the job, *submit* it,
and SLURM runs it when a GPU is free. This tutorial covers SLURM, a real nnU-Net
training run, and the practices that make results **reproducible**.

---

## 1. SLURM in five commands

SLURM shares the cluster's GPUs/CPUs across many users. You never run heavy work
directly on the login node — you **submit a batch job**:

| Command                     | What it does                                  |
|-----------------------------|-----------------------------------------------|
| `sbatch job.sh`             | submit a job script to the queue              |
| `squeue -u $USER`           | see your jobs (PD = pending, R = running)     |
| `scancel <jobid>`           | cancel a job                                  |
| `sacct -j <jobid>`          | history/exit status of a finished job         |
| `sinfo -s`                  | what partitions/nodes exist                   |

---

## 2. Anatomy of a job script

A SLURM script is a normal bash script with `#SBATCH` directives at the top that
request resources. Create `train.sh`:

```bash
#!/usr/bin/env bash
#SBATCH --job-name=nnunet_train
#SBATCH --partition=gpu          # the GPU partition (ask your admin for the name)
#SBATCH --gres=gpu:1             # request 1 GPU
#SBATCH --cpus-per-task=8        # CPU cores for data loading
#SBATCH --mem=64G                # RAM
#SBATCH --time=24:00:00          # max wall-clock (job is killed past this)
#SBATCH --output=logs/%x_%j.out  # %x=job-name, %j=job-id

set -euo pipefail                # stop on the first error (good practice)

# --- make the environment reproducible ---
source ~/miniconda3/etc/profile.d/conda.sh
conda activate imaging

export nnUNet_raw=~/workshop/nnunet/raw
export nnUNet_preprocessed=~/workshop/nnunet/preprocessed
export nnUNet_results=~/workshop/nnunet/results

# --- the actual work ---
nnUNetv2_train 1 3d_fullres 0          # dataset 1, config 3d_fullres, fold 0
```

Submit and watch it:

```bash
mkdir -p logs
sbatch train.sh
squeue -u $USER
tail -f logs/nnunet_train_*.out        # live log
```

**Key directives to understand:** `--gres=gpu:1` (you get nothing GPU without
it), `--time` (too short = killed mid-run; too long = harder to schedule), and
`--output` (where stdout/errors go — always read this when something fails).

---

## 3. A full nnU-Net training run

nnU-Net training is three steps. (Preparing the dataset into nnU-Net's folder
format is its own task — for the workshop we reuse the prepared
`CTSpinoPelvic1K` dataset; the conversion script lives in the `spinopelvic-seg`
repo.)

**Step 1 — plan & preprocess** (auto-configures the network to the data; run once
per dataset):

```bash
nnUNetv2_plan_and_preprocess -d 1 --verify_dataset_integrity
```

**Step 2 — train.** With 5-fold cross-validation you train five models (folds
0–4); each is a separate, hours-long GPU job. Submit them as one **array job** so
SLURM runs them in parallel as GPUs free up:

```bash
#SBATCH --array=0-4               # add this line to train.sh
# ...and change the work line to:
nnUNetv2_train 1 3d_fullres ${SLURM_ARRAY_TASK_ID}
```

`sbatch train.sh` now launches folds 0–4 together — that's **parallelism**: five
independent jobs, not one five-times-longer job.

**Step 3 — inference** with your freshly trained model is exactly Tutorial 3
(`nnUNetv2_predict`), pointing `-d`/`-f` at what you trained.

---

## 4. Reproducibility — the part reviewers check

"Reproducible" means *someone else (or future-you) runs the same command and gets
the same result.* Five habits:

1. **Pin the environment.** Record exact versions so the software can't drift:
   ```bash
   conda env export > environment.yml      # commit this file
   ```
2. **Fix the random seed.** nnU-Net seeds its splits; for your own code,
   `np.random.seed(42)` / `torch.manual_seed(42)`. Same seed → same split → same
   training.
3. **Freeze the data splits.** Save `splits_final.json` (which cases are train/
   val/test) and version it, so train/test never silently change between runs.
4. **No data leakage.** A case used in training must never appear in its own test
   evaluation. With cross-validation, score each case with the fold that did
   **not** train on it ("out-of-fold") — this is how our dataset's model-completed
   labels are made honest.
5. **Version control everything** — scripts, configs, env file — in git, and log
   the exact command + job id. The `set -euo pipefail` and `#SBATCH --output`
   lines above are part of this: fail loudly, keep the log.

---

## 5. From one GPU to a pipeline (Nextflow)

When a study is many steps × many cases (preprocess → train → infer → score),
hand-submitting `sbatch` jobs doesn't scale. **Nextflow** (installed in
Tutorial 1) describes the pipeline once and submits all the SLURM jobs for you,
re-running only what changed (`-resume`) — reproducible and parallel by
construction. A minimal example:

```groovy
process predict {
  cpus 8 ; memory '64 GB'
  input:  path ct
  output: path "pred_${ct.baseName}.nii.gz"
  script: "nnUNetv2_predict -i . -o . -d 1 -c 3d_fullres -f 0"
}
```

```bash
nextflow run pipeline.nf -profile slurm -resume
```

You don't need to master Nextflow today — just know it's how the full
`CTSpinoPelvic1K` pipeline (hundreds of cases, multiple stages) is orchestrated
on the grid.

---

## Recap

- **Never compute on the login node** — `sbatch` a job that requests a GPU
  (`--gres=gpu:1`) and a sensible `--time`.
- nnU-Net training = **plan/preprocess → train (5 folds) → infer**; run the folds
  as a SLURM **array** for parallelism.
- **Reproducibility = pinned env + fixed seeds + frozen splits + no leakage +
  version control.** This is what turns "it worked on my machine" into a result.

**Next:** *Writing an AI paper* — turning a dataset and an evaluation into a
publishable contribution.
