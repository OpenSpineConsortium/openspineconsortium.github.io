# OpenSpineConsortium — Website

The public website for the **OpenSpineConsortium**: an open research initiative
building openly licensed datasets and reproducible benchmarks for spine and
pelvis medical imaging.

This is a dependency-free static site (HTML / CSS / vanilla JS) designed to be
hosted on **GitHub Pages**.

```
.
├── index.html              # single-page site
├── assets/
│   ├── css/style.css       # all styling
│   └── js/main.js          # nav, scroll-reveal, manifest + survey rendering
├── contributions/
│   └── manifest.json       # contributors + their scholarly contributions
├── headshots/              # contributor photos (see headshots/README.md)
├── meded/
│   ├── survey-summary.json # de-identified Education Outcomes data
│   └── summarize_survey.py # regenerates the summary from a raw export
├── .nojekyll               # tells GitHub Pages to skip Jekyll processing
└── README.md
```

## Education Outcomes section

The **Education Outcomes** section renders from `meded/survey-summary.json` — a
de-identified aggregate of the OSC participation survey (before/after competence
means, headline stats, hand-picked quotes). See `meded/README.md` to regenerate
it. **Never commit the raw survey CSV** — it contains names and demographics and
is excluded by `.gitignore`.

## Contributors & contributions

The **People** section and the **CNS 2026** outputs list are generated at load
time from `contributions/manifest.json` — you never edit the People markup in
`index.html` directly.

The manifest has two parts:

- **`abstracts`** — every project, keyed by id. CNS submissions use their real
  CNS abstract number; in-preparation projects use an `osc-…` id.
- **`people`** — one entry per contributor. The `contributions` array lists the
  abstract ids that person worked on; the renderer resolves each id against the
  `abstracts` table and prints the title, venue, and status under their name.

To **add or correct a contribution**, edit a person's `contributions` array. To
**add a person**, append an object to `people` (copy an existing one). To **add
a headshot**, drop an image in `headshots/` — see `headshots/README.md` for the
`lastname,firstname[,mi].ext` naming. People without a photo automatically get
an initials avatar.

> Student **roles** and **affiliations** in the manifest are placeholders
> (`"Student Researcher"`, empty affiliation). Fill these in before publishing.
> Abstract titles are verbatim from the CNS submission list.

## Deploy on GitHub Pages

### Option A — project site (quickest)

1. Create a repository, e.g. `openspineconsortium.github.io` (for a clean URL)
   or any name like `website`.
2. Push these files to the default branch:
   ```bash
   git init
   git add .
   git commit -m "Initial site"
   git branch -M main
   git remote add origin https://github.com/OpenSpineConsortium/<repo>.git
   git push -u origin main
   ```
3. In the repo: **Settings → Pages → Build and deployment**
   → Source: **Deploy from a branch** → Branch: **main** / **/(root)** → Save.
4. The site goes live within a minute or two at
   `https://OpenSpineConsortium.github.io/<repo>/`
   (or `https://OpenSpineConsortium.github.io/` if you used the
   `*.github.io` repo name).

### Option B — custom domain

Add a file named `CNAME` at the repo root containing only your domain
(e.g. `openspineconsortium.org`), then configure the domain under
**Settings → Pages → Custom domain**.

## Before you publish — review the placeholders

A few items are marked `[VERIFY]` in `index.html` and should be confirmed or
replaced with real values before going live:

- **Contributors** — student **roles** and **affiliations** in
  `contributions/manifest.json` are placeholders; fill them in. Names and
  contribution mappings come from the CNS list and the projects spreadsheet.
- **Dataset details** — volume counts, licensing terms, and the HuggingFace link.
- **Contact** — the email address (`contact@openspineconsortium.org`) and the
  GitHub organization URL (`https://github.com/OpenSpineConsortium`).

Search `index.html` for `[VERIFY]` and review `contributions/manifest.json`.

## Updating the site (important — caching)

Browsers and the GitHub Pages CDN cache `style.css` and `main.js`. After you
push a change to either file, **bump the `?v=` number** on both references near
the top and bottom of `index.html` (e.g. `?v=20260519` → `?v=20260520`).
Changing the number forces every visitor to fetch the new file instead of a
stale cached copy. If you ever see an old version of the site, this is why —
bump `?v=` and hard-refresh (`Ctrl/Cmd+Shift+R`).

Data files (`contributions/manifest.json`, `meded/survey-summary.json`) are
fetched with revalidation, so they refresh on their own — only the CSS/JS need
the `?v=` bump.

## Editing

Everything lives in `index.html`. To add a section, copy an existing
`<section class="section">…</section>` block, give it a new `id`, and add a
matching link in both the header `<nav>` and the footer nav. The `reveal` class
on an element opts it into the scroll-in animation.

## Local preview

```bash
python3 -m http.server 8000
# then open http://localhost:8000
```

## License

Site content © OpenSpineConsortium. Datasets referenced here are redistributed
under the terms of their original source licenses; see each dataset card for
provenance and licensing details.
