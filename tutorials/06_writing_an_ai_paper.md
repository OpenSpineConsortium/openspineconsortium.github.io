# Tutorial 6 — Writing an AI Imaging Paper

*AI Imaging Workshop · the 11:30 AM "Writing an AI paper (datasets, evaluations,
clinical paper, scoping review)" block.*

You've installed the tools, looked inside the data, run a model, annotated, and
trained. This tutorial is about turning that into a **publishable contribution** —
the four paper types you'll write, how each is structured, and the evaluation and
reproducibility standards reviewers actually enforce. Examples are drawn from the
workshop's own `CTSpinoPelvic1K` benchmark and its real peer review.

---

## 1. Four kinds of AI imaging paper

| Type                 | Core question it answers                          | This workshop's example |
|----------------------|---------------------------------------------------|-------------------------|
| **Dataset / benchmark** | "Here is data + a way to measure progress."   | CTSpinoPelvic1K         |
| **Method**           | "Here is a model/algorithm that does X better."   | a new segmentation net  |
| **Clinical**         | "Does this AI change a patient-relevant outcome?" | LSTV detection in practice |
| **Scoping review**   | "What does the literature cover, and where are the gaps?" | "ML for LSTV: a scoping review" |

Pick the type **before** you write — each has a different reviewer, structure, and
bar.

---

## 2. The dataset/benchmark paper (what you're building)

A dataset paper is judged on **rigor of construction**, **clarity of evaluation**,
and **usability**. Structure:

1. **Motivation / gap** — what clinical or ML problem is unmet. (Ours: no CT
   benchmark for transitional anatomy at the lumbosacral junction.)
2. **Construction** — exactly how the data was assembled, including the hard parts
   and the failure modes. Reproducible = a reader could rebuild it.
3. **The labels** — the schema (our 10 classes), who annotated, inter-rater
   agreement, and how uncertainty is handled.
4. **Splits** — train/val/test, **stratified** by the rare subgroup so it appears
   in every split, and **patient-grouped** so a patient never spans splits.
5. **A baseline + evaluation** — at minimum one model's numbers so the benchmark's
   difficulty is concrete.
6. **Accounting** — one authoritative table of counts (patients, scans, masks,
   volumes, per-class), because counts reported at different granularities are the
   #1 source of reviewer confusion.
7. **Release** — data + code + (ideally) trained checkpoints, under a clear
   licence.

**Documentation matters as much as the data.** A *datasheet* (motivation,
composition, collection, preprocessing, uses, distribution) is increasingly
expected.

---

## 3. Evaluation you can defend

Most rejections are about evaluation, not ideas. The essentials:

- **Right metrics.** Segmentation: **Dice** (overlap) and **HD95**
  (boundary error). Report **per class**, not just an average — averages hide
  failure on the class that matters.
- **Stratified reporting.** Break results out by the clinically important
  subgroup (e.g. normal vs. each LSTV phenotype). A 19-point Dice drop at the
  junction is invisible in a global mean.
- **No leakage.** Never evaluate a model on a case it trained on. With
  cross-validation, score **out-of-fold**. State explicitly that train/test are
  disjoint at the **patient** level.
- **Score only against what exists.** With partial labels, compute a metric only
  where ground truth is present — never against an unobserved region.
- **Honest baselines.** A zero-shot off-the-shelf model is a fair, informative
  baseline *if* you don't overclaim it ("a widely used open-source model," not
  "the standard of care").
- **Uncertainty / disagreement is signal.** Where expert annotators legitimately
  disagree, report it rather than hiding it behind a single adjudicated label.

---

## 4. The clinical paper

Different audience, different bar:

- Lead with the **clinical question and outcome**, not the architecture.
- **IRB / ethics** statement, even for public de-identified data.
- **Patient-level** performance with confidence intervals; relate errors to
  **clinical consequence** (e.g. wrong-level surgery), with citations rather than
  assertions.
- State the **deployment gap**: validation cohort vs. intended-use population
  (scanner, protocol, demographics).

---

## 5. The scoping review

Maps a field's literature and gaps (broader than a systematic review):

- Follow **PRISMA-ScR** (the reporting checklist for scoping reviews).
- Predefine the **search strategy** (databases, terms, dates) and
  inclusion/exclusion criteria; report counts in a **PRISMA flow diagram**.
- **Charting**: extract a consistent set of fields from each paper into a table.
- Output: a synthesis of what's covered and an explicit **gap statement** —
  which often motivates the dataset or method paper you write next.

---

## 6. What reviewers will push on (learned the hard way)

From this benchmark's actual review, the recurring asks — write to pre-empt them:

- **"Provide a trained baseline."** A benchmark without at least one model run is
  hard to assess. Include it, even a single fold.
- **"Your counts don't reconcile."** Patients ≠ scans ≠ masks ≠ volumes. Put one
  source-of-truth accounting table in the paper and make every number match it.
- **"Motivate the problem for non-experts."** Don't assume the reader knows your
  data's quirks (e.g. why a file can't be linked to its scan). One concrete
  motivating paragraph per non-obvious problem.
- **"Don't overclaim scope."** If you have N=53 of the rare class, position the
  data as enabling **stratified benchmarking**, not robust **training** of that
  class — and say so explicitly.
- **"Cut irrelevant related work."** Only cite what's actually adjacent to your
  contribution.
- **Fix the small errors.** A wrong caption or stale number costs credibility out
  of proportion to its size.

---

## 7. Reproducibility checklist (attach to any submission)

- [ ] Code public (preprocessing, training, **evaluation/scoring**).
- [ ] Data + splits public (or access procedure stated); `splits_final.json`
      versioned.
- [ ] Trained checkpoints released.
- [ ] Exact environment pinned (`environment.yml`), seeds fixed.
- [ ] One authoritative counts table; every in-text number matches it.
- [ ] Metrics defined precisely (window size, what's included/excluded).
- [ ] Licence and data-use terms stated; IRB/de-identification noted.

---

## Recap

- **Choose the paper type first**; each has its own structure and reviewer.
- For a dataset paper, **construction + evaluation + accounting + release** are
  the contribution — the model is secondary but a baseline is expected.
- **Evaluation rigor** (per-class, stratified, out-of-fold, no leakage) is where
  papers are won or lost.
- Write to **pre-empt the standard reviewer asks**; release everything.

*This concludes the AI Imaging Workshop tutorial series. You can now set up an
environment, read medical images, run and train segmentation models on the grid,
annotate with AI, and frame the result as a paper.*
