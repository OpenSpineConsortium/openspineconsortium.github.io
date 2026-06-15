# AI Imaging Workshop — Tutorials

Hands-on tutorials for the **AI Imaging Workshop** (WSUSOM). Work through them in
order; each builds on the last. Everything is copy-paste, written for a clinical/
research audience — read the explanation above each command.

| # | Tutorial | Agenda block |
|---|----------|--------------|
| 1 | [Environment setup](01_environment_setup.md) — Miniforge / mamba, imaging packages, Nextflow | 9:30 Python / SLURM |
| 2 | [DICOM vs. NIfTI](02_dicom_vs_nifti.md) — what's inside a medical image | 10:00 DICOM/NIfTI |
| 3 | [Inference with a pretrained nnU-Net](03_inference_pretrained_nnunet.md) | 10:15 CNNs / nnU-Net |
| 4 | [AI-powered annotation in ITK-SNAP](04_itksnap_ai_annotation.md) | 10:45 ITK-SNAP |
| 5 | [Training on the WSU grid (SLURM)](05_training_on_the_grid.md) | 11:00 Training |
| 6 | [Writing an AI paper](06_writing_an_ai_paper.md) | 11:30 Writing |

**Before the workshop:** bring a laptop and, if you can, finish **Tutorial 1** so
your environment is ready. Setup videos: the
[OpenSpineConsortium](https://www.youtube.com/@OpenSpineConsortium) channel.

**Resources used throughout**
- Dataset: <https://huggingface.co/datasets/anonymous-mlhc/CTSpinoPelvic1K>
- Trained checkpoints: <https://huggingface.co/anonymous-mlhc/spinopelvic-seg-checkpoints>
- ITK-SNAP: <http://www.itksnap.org>
