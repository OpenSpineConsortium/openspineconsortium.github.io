# OpenSpineConsortium — Website

The public website for the **OpenSpineConsortium**, served by GitHub Pages at
https://openspineconsortium.com. Static HTML, CSS and vanilla JS; no framework, no
external scripts.

**One command regenerates every page:**

```bash
python -X utf8 tools/build_site.py              # build, stamp, check
python -X utf8 tools/build_site.py --external   # also ask every outside link for its status
python -X utf8 tools/build_site.py --check-only # write nothing; check what is on disk
```

It exits non-zero and names the page when a check fails. Commit what it wrote.

## Publishing (read this before every push)

1. **Rebuild once, then push once.** `python -X utf8 tools/build_site.py` rewrites every
   page, stamps every stylesheet, script, image, video and document reference with one new
   `?v=<yyyymmddHHMM>` (UTC), and runs its checks. Push the whole tree it wrote in one commit,
   so no page on the live site carries a stamp from a different build. The stamp is what busts
   the browser and CDN caches for everything a page loads.
2. **HTML itself is cached for up to ten minutes.** GitHub Pages serves every page with
   `Cache-Control: max-age=600`, so for up to ten minutes after the deploy a visitor (and the
   CDN) may still get the previous HTML, which points at the previous, still-present assets.
   Nothing to do but wait; a hard reload shows the new page at once.
3. **`/ashley/` is legacy and stays as it is.** It holds the pages and service files of the
   product's earlier name: the agreement, privacy, support, request and admin pages, the
   `services.json` and withdrawn-keys list that installed extension builds 4.0.0 to 6.0.0
   still fetch, and `/ashley/bridge/`, which now redirects to `/beethoven/`. The build does
   not template, stamp, check or list them in the sitemap, and nothing here edits them.
   Remove them only when no installed build older than 7.0.0 is left.
4. The old one-page site is not kept as a file here (everything in this repository is
   published); it is in git: `git show 28d2cee:index.html`.

## Page bodies: `tools/pages/` (the convention every page follows)

Every page on the site is one **body fragment** wrapped in one **shared shell**.
The shell (head, header, section strip, breadcrumb, footer, scripts) is written by
`tools/build_site.py` from the site map at the top of that script, so no two pages
can disagree about navigation. You never write a `<header>` or a `<footer>` by hand.

**Where a body lives.** Take the page's output file, drop `.html`, and put
`body.html` in that folder under `tools/pages/`:

| URL | output file | body file |
|---|---|---|
| `/` | `index.html` | `tools/pages/index/body.html` |
| `/beethoven/` | `beethoven/index.html` | `tools/pages/beethoven/index/body.html` (if absent, the home body is used) |
| `/onboarding/` | `onboarding/index.html` | `tools/pages/onboarding/index/body.html` |
| `/research/conferences/` | `research/conferences/index.html` | `tools/pages/research/conferences/index/body.html` |
| `/beethoven/request.html` | `beethoven/request.html` | `tools/pages/beethoven/request/body.html` |

**What a body file contains.** A few lines of front matter between two `---`
lines, then the HTML that goes inside `<main id="main">`:

```html
---
title: Beethoven · OpenSpineConsortium
description: One sentence for search results and link previews.
css: /onboarding/onboarding.css
js: /assets/js/deck.js module
canonical: https://openspineconsortium.com/beethoven/
body_class: page-home
strip: no
breadcrumb: no
---
<section class="section">
  …
</section>
<script>/* inline scripts are allowed and kept as written */</script>
```

| key | required | meaning |
|---|---|---|
| `title` | yes | the `<title>` |
| `description` | yes | `<meta name="description">` and the link preview |
| `css` | no | extra stylesheets, comma separated, root-absolute |
| `js` | no | extra scripts, comma separated, root-absolute; add ` module` after a path for `type="module"` |
| `canonical` | no | `<link rel="canonical">` (default: the page's own address) |
| `body_class` | no | classes on `<body>` |
| `strip` | no | `no` hides the section strip on this page |
| `breadcrumb` | no | `no` hides the breadcrumb (the home page has none anyway) |

**Directives** a body may use; the build fills them in:

| directive | becomes |
|---|---|
| `<!-- build:request-form services=<url> -->` | the access-request form and its script (`tools/templates/request-form.html`); `services` is where it reads the access service's address (default `/beethoven/services.json`; `request.html` passes `services.json`, relative, as it always has, and the build checks that it still does) |
| `<!-- build:request-form services=<url> fine=short -->` | the same form and the same script without the three hints under the fields and with one line of fine print that links the privacy statement (`request.html` keeps the full "What this page sends" text). The home page uses it so it stays under 120 words outside the form's labels |
| `<!-- build:browsers -->` | the four browser cards: the store button once `store_url` is set in `BROWSERS`, else "Direct download" of `/beethoven/downloads/beethoven-<version>-<browser>.zip` |
| `<!-- build:section-index -->` | on a tab's landing page (`/research/`, `/data/`), a list of the pages one level below its children (the six tutorials, the Spine MRI parts), made from `SITE`, so every page is at most two clicks from the header |
| `<!-- build:license-title -->`, `<!-- build:license-toc -->`, `<!-- build:license-text -->` | the Trial Edition License Agreement, rendered from the Beethoven repository's `LICENSE.txt` |
| `<!-- build:privacy-title -->`, `<!-- build:privacy-text -->` | the privacy statement, rendered from its `PRIVACY.md` with pandoc |
| `{{version}}`, `{{license_version}}`, `{{privacy_version}}` | the extension's version and the two texts' version numbers |

Rules for bodies:

- Link with **root-absolute** paths (`/beethoven/terms.html`, `/assets/img/…`).
- Do **not** add `?v=`: the build stamps every local stylesheet, script, image,
  video and document reference with `?v=<yyyymmddHHMM>` (UTC) on every run.
- The shell always loads `/assets/css/style.css`, `/assets/css/site.css` and
  `/assets/js/main.js` (the menu, the `.reveal` animation, the People and Goals
  renderers). Anything with class `reveal` stays invisible until `main.js` runs.
- A body file whose page is not in the site map is an error: add the page to
  `SITE` in `tools/build_site.py` first.

## The site map

`SITE` at the top of `tools/build_site.py` is the only place navigation is defined:
five tabs (Home, Onboarding, Research, Data & Tools, People), the "Get Involved"
button (to `/beethoven/request.html`), and their children. From it the build writes

- the **header**: byte-identical on every page except `aria-current` on the tab you
  are in; one row down to 721px, a menu under 720px (`#navToggle`, handled by `main.js`);
- the **section strip** under the header: the section's name and its pages as pills;
- the **breadcrumb** above the footer (Home › section › page), as apple.com places it;
- the **footer**: a directory of every page, the same on every page;
- `sitemap.xml` (canonical addresses only: `/` declares `/beethoven/` as its canonical and is left out) and `robots.txt`.

Adding a page: add a `node(...)` to `SITE`, write its body file, run the build.
`kind="page"` is generated from a body; `kind="sub"` is a page that keeps its own
HTML (the atlas, the Spine MRI series, the tutorials, Celebrate Life) and receives
the shell between `<!-- site:head -->`, `<!-- site:header -->` and
`<!-- site:footer -->` markers, so a second run replaces rather than adds;
`kind="app"` (the PACS demo) receives the header only, in the page flow, because
the viewer fills the screen. The sub-sites' content is never touched; the build
removes only their old header, their inline menu script and links to the retired
one-page anchors (`../index.html#datasets` becomes `/data/datasets/`).

The tutorials are generated by `tutorials/_build.py` from Markdown: after running
it, run `tools/build_site.py` to put the shell back.

## Where the old one-page site went

| old anchor | page |
|---|---|
| `#home` (hero), `#project` | `/research/` |
| `#datasets` | `/data/datasets/` (plus "Use the datasets" from `#join`) |
| `#people` | `/people/` |
| `#organization` | `/people/organization/` |
| `#education` | `/people/education/` |
| `#workshop` | `/research/workshop/` (the tutorials hang under it) |
| `#goals` | `/research/goals/` |
| `#conferences` | `/research/conferences/` |
| `#gallery` (the 3-D specimens) | `/data/gallery/` |
| `#hardware` | `/data/hardware/` |
| `#outside` | `/research/outside/` |
| `#join` | `/onboarding/` ("Other ways to get involved") |

The last committed one-page site is `git show 28d2cee:index.html`.
`/data/` is a landing page of tiles for its children, and `/atlas/` is listed under
Data & Tools.

## Beethoven

`/` and `/beethoven/` are the Beethoven product page (the extension's homepage is
`/beethoven/`). The agreement and the privacy statement are rendered on every build
from the Beethoven repository, `../ashley-bridge/` by default (set `BEETHOVEN_REPO`
to change it), and checked word for word against their sources. The build also
copies the four browser packages from that repository's `release/<version>/` into
`beethoven/downloads/` with a `SHA256SUMS.txt`, and refuses to copy a package whose
hash does not match the release's list. `BEETHOVEN_VERSION` and the store addresses
(`BROWSERS[*]["store_url"]`, `None` until a store approves a listing) are at the top
of `tools/build_site.py`.

**Retired:** the Beethoven repository's `tools/site_beethoven_build.py` no longer
builds pages for this site; running it would overwrite the themed pages. It also
used to write `/ashley/bridge/index.html` and a line in `/ashley/index.html`; those
legacy files stay as they are and nothing here edits them.

Never edited by hand or by the build: `beethoven/services.json`,
`beethoven/killlist.json` (the extension fetches both), anything under `/ashley/`
(legacy copies and redirects for extension builds 4.0.0 to 6.0.0), and
`googlec3911e7fb095977e.html`.

## Caching

GitHub Pages serves HTML with `max-age=600`, so a visitor can see the previous HTML
for up to ten minutes after a deploy (see Publishing above). Everything the HTML loads carries a new
`?v=<yyyymmddHHMM>` from every build, so the new HTML never pairs with an old
stylesheet or script. ES-module imports inside scripts (`gallery.js` → `viewer.js` →
`three.js`; `xr.js` → `infer.js`, `remote.js`) carry content hashes instead, which the
build recomputes (`MODULE_EDGES`); a stamp on the entry script alone would not make
a browser refetch what it imports. `tools/stamp_assets.py` did this for the one-page
site and is superseded by the build. Data files (`contributions/manifest.json`,
`meded/survey-summary.json`, `beethoven/services.json`) are fetched with
revalidation and need no stamp.

## People and Education data

The People grid (`/people/`) and the CNS 2026 list (`/research/goals/`) render at
load time from `contributions/manifest.json`; the Education Outcomes chart
(`/people/education/`) from `meded/survey-summary.json`. Edit those files, not the
markup. To add a person, append to `people` (copy an existing entry); headshots go in
`headshots/` as `lastname,firstname[,mi].ext` (see `headshots/README.md`); people
without a photo get an initials avatar. Bump `HEADSHOT_V` in `assets/js/main.js` when
a portrait is replaced. **Never commit the raw survey CSV**: it holds names and
demographics and is excluded by `.gitignore`; `meded/README.md` says how to regenerate
the summary.

## Local preview

```bash
python -m http.server 8000     # from the repository root
# then open http://localhost:8000
```

Paths are root-absolute, so open the site through the server, not as `file://`.
The request form cannot send from localhost (the access service answers only
`https://openspineconsortium.com`); test a submission on the live site.

## Deploy

GitHub Pages, branch `master`, folder `/`, custom domain in `CNAME`. Tick **Enforce
HTTPS** in Settings → Pages: until then `http://openspineconsortium.com/` is served
without a redirect, and the access service refuses a request from an `http://`
page. Every generated page upgrades itself to https as a fallback.

## License

Site content © OpenSpineConsortium. Datasets referenced here are redistributed under
the terms of their original source licenses; each dataset card says where the data
comes from and how it is licensed.
