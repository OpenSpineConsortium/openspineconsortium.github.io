# Tutorial 4 — AI-Powered Annotation in ITK-SNAP

*AI Imaging Workshop · the 10:45 AM "Annotating using AI-powered ITK-SNAP" block.*

When **no trained model exists** for the structure you care about, you still need
labels — to evaluate, to fine-tune, or to build a new dataset. **ITK-SNAP** is the
standard free tool for viewing and hand-segmenting medical images, and its
**Distributed Segmentation Service (DLS)** lets an **AI assistant** do most of the
work interactively: you place a few clicks/scribbles, the AI fills in the 3-D
structure, you correct, repeat.

> This is a **desktop GUI** tutorial — do these steps on your **laptop**, not the
> grid. The AI backend runs separately (a notebook/server you connect to).

---

## 1. Install ITK-SNAP

Download the installer for your OS from **<http://www.itksnap.org>** (version 4.x).

- **Windows / macOS** — run the installer, open ITK-SNAP.
- **macOS note** — first launch: right-click the app → *Open* to bypass the
  unsigned-app warning.

Sanity check: *File → Open Main Image* → pick the `ct.nii.gz` from Tutorial 2.
You should see three orthogonal views (axial, sagittal, coronal) you can scroll.

---

## 2. The manual workflow (know this first)

Even with AI, the manual primitives are the foundation:

- **Main image** = the CT (greyscale). **Segmentation** = the coloured label
  layer you draw on. *Segmentation → … labels* defines your classes.
- **Window/level** — adjust contrast (Tools → Image Contrast); use a bone window
  to see vertebrae clearly.
- **Polygon / paintbrush** tools — draw on a slice; scroll and repeat.
- **Save** — *Segmentation → Save Segmentation Image* writes a NIfTI label on the
  CT's grid (exactly the format from Tutorials 2–3).

Hand-segmenting a full vertebra this way takes minutes per structure — which is
why we use AI.

---

## 3. The AI assistant: nnInteractive via the Distributed Segmentation Service

ITK-SNAP can offload segmentation to an AI model running elsewhere. We use
**nnInteractive** — an interactive segmentation model: you give it *prompts*
(a click inside the structure, a scribble, a bounding box) and it returns the
full 3-D segmentation in seconds, refining as you add prompts.

**Two pieces:**
1. The **AI server** — runs nnInteractive on a GPU (commonly a free **Google
   Colab** GPU notebook). It exposes a URL.
2. **ITK-SNAP** on your laptop — connects to that URL and sends your prompts.

**Start the server (Colab).** Open the workshop's segmentation-server notebook
(linked from the **OpenSpineConsortium** YouTube/GitHub) and run the cells. A
**known-working version pin** avoids dependency breakage:

```
itksnap-dls            # the ITK-SNAP DLS bridge
nnInteractive == 1.1.0
nnunetv2     == 2.6.2
numpy        <  2.1
```

The notebook prints a public URL (and often a forwarding tunnel) when ready.

**Connect ITK-SNAP to it:** *Tools → Distributed Segmentation Service* → add the
server URL → it appears as available. Load your CT as the main image, choose the
nnInteractive service, and start a session.

---

## 4. Annotate one vertebra with AI (the loop)

1. Scroll to a slice through the target vertebra.
2. **Drop a foreground prompt** (a click inside the bone) — the AI segments the
   whole 3-D vertebra.
3. **Refine**: add a foreground click where it missed, or a **background** click
   where it bled into a neighbour. Each prompt updates the result live.
4. When it looks right, **accept** it into a label (e.g. "L5").
5. Move to the next structure, repeat.

This turns minutes-per-structure into seconds, with you supervising — the model
does the voxels, you provide anatomy and judgement.

---

## 5. Save and reuse

*Segmentation → Save Segmentation Image* → `mylabel.nii.gz`. It is a standard
10-class-style NIfTI: load it back with `nibabel` (Tutorial 2), score it with
Dice against a model's output (Tutorial 3), or add it to a training set
(Tutorial 5).

---

## When to use what

| Situation                                   | Tool                                |
|---------------------------------------------|-------------------------------------|
| A trained model already covers the anatomy  | nnU-Net **inference** (Tutorial 3)  |
| New structure / few labels / corrections    | **ITK-SNAP + nnInteractive** (here) |
| Pure manual control on a tricky case        | ITK-SNAP polygon/paintbrush         |

**Practical tips**
- Colab GPUs disconnect after idle time — keep the tab active; re-run the server
  cell if the connection drops.
- Always confirm your saved label has the **same shape/affine** as the CT
  (Tutorial 2, section 5) before using it downstream.
- Review every AI result — interactive models are fast but not infallible,
  especially at the L5/S1 junction.

**Next:** *Training your own network on the WSU grid* — turn a folder of
annotated cases into a trained model with SLURM.
