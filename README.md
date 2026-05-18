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
│   └── js/main.js          # nav + scroll-reveal interactions
├── .nojekyll               # tells GitHub Pages to skip Jekyll processing
└── README.md
```

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

- **People** — names, titles, and affiliations of collaborators. The placeholder
  cards in the *People* section are intentionally generic; confirm with each
  person before listing them publicly.
- **Dataset details** — volume counts, licensing terms, and the HuggingFace link.
- **Contact** — the email address (`contact@openspineconsortium.org`) and the
  GitHub organization URL (`https://github.com/OpenSpineConsortium`).
- **Research outputs** — submission venues and review status in the *Goals*
  section.

Search the project for `[VERIFY]` to find every spot quickly.

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
