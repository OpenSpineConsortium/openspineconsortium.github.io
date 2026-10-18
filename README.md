# OpenSpineConsortium — Website

The public website for the **OpenSpineConsortium**, served by GitHub Pages at
https://openspineconsortium.com. Static HTML, CSS and vanilla JS; no framework, no
external scripts.

**One command regenerates every page:**

```bash
python -X utf8 tools/build_site.py              # build, stamp, check
python -X utf8 tools/build_site.py --external   # also ask every outside link for its status
python -X utf8 tools/build_site.py --check-only # write nothing; check what is on disk
python -X utf8 tools/build_site.py --out DIR    # copy the site to DIR (new or empty, outside this
                                                # folder) and build and check there instead
```

It exits non-zero and names the page when a check fails. Commit what it wrote. `--out` is the
dry run: it touches nothing here, and `diff -r` against DIR shows what a real build would change.

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
3. **`/ashley/` is the product's old address, and two tables in `tools/build_site.py` say
   what every file there is.** `REDIRECTS` (old file -> new address): the build writes each
   as a two-line page that sends the visitor on with the query and the fragment
   (`/ashley/request.html?access_id=ab1234` lands on `/beethoven/request.html?access_id=ab1234`)
   and a meta refresh for a browser without scripts. `KEPT_FILES`: files installed builds
   read by address, or the exact texts people accepted, kept byte for byte with their
   SHA-256 pinned (`services.json`, which Ashley for VS Code 3.0.0 and Beethoven 4.0.0 to
   6.0.0 read; `bridge-killlist.json`; the version 4 `license.txt`, `license-full.txt` and
   `privacy.html`; `bridge/privacy.html` and `bridge/terms.html`). The build never writes a
   kept file, fails if one changes, and fails on any file under `/ashley/` that is in
   neither table. Remove an entry only when no installed build that reads it is left.
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
| `/beethoven/` | `beethoven/index.html` | `tools/pages/beethoven/index/body.html` |
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
| `robots` | no | `<meta name="robots">`, e.g. `noindex` (the admin page) |
| `body_class` | no | classes on `<body>` |
| `strip` | no | `no` hides the section strip on this page |
| `breadcrumb` | no | `no` hides the breadcrumb (the home page has none anyway) |

**Directives** a body may use; the build fills them in:

| directive | becomes |
|---|---|
| `<!-- build:request-form services=<url> -->` | the access-request form and its script (`tools/templates/request-form.html`); `services` is where it reads the access service's address (default `/beethoven/services.json`; `request.html` passes `services.json`, relative, as it always has, and the build checks that it still does) |
| `<!-- build:request-form services=<url> fine=short -->` | the same form and the same script without the three plain hints under the fields and without the "What this page sends" paragraph (`request.html` keeps it). The CV box and the consent line, which links the privacy statement, stay in both (the Google account's line, `<small class="why">`, left with the field on 2026-10-13). The home page uses it |
| `<!-- build:browsers -->` | the one install card: Chrome, "On the Chrome Web Store, with no invitation needed" (`BROWSERS`, `LISTING_NOTE`; the listing is public since Beethoven 20.0.0, 2026-10-13). No button while `store_url` is `None`; set it to the listing's `https://chromewebstore.google.com/...` address only if the card should link it. Nothing is downloaded from this site |
| `<!-- build:section-index -->` | on a tab's landing page (`/research/`, `/data/`), a list of the pages one level below its children (the six tutorials, the Spine MRI parts), made from `SITE`, so every page is at most two clicks from the header |
| `<!-- build:docs-products -->`, `<!-- build:docs-pages -->`, `<!-- build:docs-buttons -->`, `<!-- build:docs-history -->`, `<!-- build:docs-live-repos -->`, `<!-- build:docs-built -->` | the Docs tab's generated parts (below, "The Docs tab") |
| `<!-- build:vscode-install -->` | the one install card of Beethoven for VS Code: the Marketplace button once `VSCODE_STORE_URL` is set, else "listing pending" |
| `<!-- build:license-title -->`, `<!-- build:license-toc -->`, `<!-- build:license-text -->` | the browser edition's Trial Edition License Agreement, rendered from its repository's `LICENSE.txt` |
| `<!-- build:privacy-title -->`, `<!-- build:privacy-text -->` | the browser edition's privacy statement, rendered from its `PRIVACY.md` with pandoc |
| `<!-- build:vscode-license-… -->`, `<!-- build:vscode-full-… -->` (`-title`, `-toc`, `-text`) | Beethoven for VS Code's Trial and Full Edition License Agreements, from its repository's `extension/LICENSE.txt` and `LICENSE-FULL.txt` |
| `<!-- build:vscode-privacy-… -->`, `<!-- build:vscode-third-party-… -->` (`-title`, `-text`) | its `extension/PRIVACY.md` and `extension/THIRD_PARTY_NOTICES.md`, with pandoc |
| `<!-- build:symphony-privacy-… -->` (`-title`, `-text`) | Symphony for Chrome's privacy statement, from its repository's `PRIVACY.md`, with pandoc |
| `{{version}}`, `{{vscode_version}}`, `{{license_version}}`, `{{privacy_version}}`, `{{vscode_license_version}}`, `{{vscode_full_version}}`, `{{vscode_privacy_version}}`, `{{symphony_privacy_version}}` | the two editions' versions and the texts' version numbers |

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
eight tabs (Home, Symphony, Beethoven, Onboarding, Research, Data & Tools, People, Docs), the
"Get Involved" button (to `/beethoven/request.html`), and their children. Home is the
lab page and has no children, so it gets no strip and no footer column; its two figures
are drawn by `tools/home_figures.py` (below). From it the build writes

- the **header**: byte-identical on every page except `aria-current` on the tab you
  are in; one row down to 721px, a menu under 720px (`#navToggle`, handled by `main.js`);
- the **section strip** under the header: the section's name and its pages as pills;
- the **breadcrumb** above the footer (Home › section › page), as apple.com places it;
- the **footer**: a directory of every page, the same on every page;
- `sitemap.xml` (canonical addresses only: a page whose canonical is elsewhere is left out) and `robots.txt`.

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


## The Docs tab: `/docs/`, written by every build

The Docs tab keeps itself up to date: the build writes it from what it already reads, so a page,
a button or a version that goes live is in the docs in the same build, with nothing to edit by
hand. `PRODUCTS` and `LIVE_REPOS` in `tools/build_site.py` (THE DOCS SECTION) are the only lists
in it, and a new product is one entry there.

- **`/docs/`**: each product in `PRODUCTS`, what it is, its version (read from its repository at
  build time, or from GitHub in the browser for the protocol and the plugin) and where to start;
  then every page in `SITE`, hidden ones included, with its front matter's description and a tag
  for a page that signs in, one reached only by a link and one kept out of search. Since the Docs
  tab lists every page, the build fails when a page in `SITE` is more than two clicks from the
  header and footer, hidden or not, and when an `.html` file is on disk but not in `SITE`.
- **`/docs/buttons.html`**: every `<button>` and `.btn` link on every page, read from the page's
  body (or, for a page that keeps its own HTML, its file without the shell), and the buttons its
  own scripts make through a `btn('...')` helper, marked "when there is something to act on".
- **`/docs/changes.html`**: the pull requests merged in the last 30 days in the public
  repositories of `LIVE_REPOS`, read by `assets/js/docs.js` from GitHub's public API with no
  token (60 reads an hour from one address, so each answer is kept in the tab for ten minutes),
  then each product's own change notes: the "Version N ..." paragraphs of the privacy statement
  it ships with, newest first. Private and internal repositories stay out of `LIVE_REPOS`,
  since the site is public.

A hidden page (`hidden=True`) is left out of the menus, the strip, the footer and the sitemap and
still listed on `/docs/`; a page whose front matter says `robots: noindex` stays out of the
sitemap whether hidden or not.

## The home page's figures: `tools/home_figures.py`

The lab diagram and the git graph on `/` are SVG drawn from coordinates in that script, each in
a wide layout and a phone layout, because their labels are SVG text and scale with the drawing.
`python -X utf8 tools/home_figures.py` rewrites them between `<!-- lab:start -->` ...
`<!-- lab:end -->` and `<!-- graph:start -->` ... `<!-- graph:end -->` in
`tools/pages/index/body.html`, and the keyframes whose timing comes from the coordinates
between the two `generated by tools/home_figures.py` comments in `assets/css/lab.css`. Change
the drawing there and run it, then the build; the prose around the figures and the rest of
`lab.css` are written by hand.

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

Beethoven has two editions, and both live under `/beethoven/`:

- **The browser extension.** `/` and `/beethoven/` are its product page (its homepage
  is `/beethoven/`), with its agreement, privacy statement, support, request and
  reviewers pages beside it. The texts come from its repository (`../beethoven/`, or
  `../ashley-bridge/` until the folder is renamed; `BEETHOVEN_REPO` overrides), and its
  version from that repository's `extension/package.json`. It is for Chrome only and is
  distributed only through its **Chrome Web Store listing**, public since 20.0.0
  (2026-10-13; until 19.0.0 a private one whose testers were the lab's Google Group, the
  request form asking for each student's Google account). The site offers no package:
  `beethoven/downloads/` is gone, and the build fails if that folder, a package file
  (`beethoven-*.zip`, `.crx`, `.xpi`) or a link to one comes back, or if a page names
  another browser (the names are `OTHER_BROWSERS` in the script; a text rendered from the
  browser repository that names one is reported as a note, because the change belongs in
  that file).
  The 7.0.0 packages are still in this repository's git history (commit `816e9c4`);
  removing them from history would be a rewrite and is the maintainer's decision.
- **The request form** (`tools/templates/request-form.html`) posts `v: 2` to the access
  service's `/request`: `access_id`, `name`, `email` (the AccessID at `wayne.edu`),
  `google_account`, `purpose` (required, 500 characters at most), `product: 'bridge'`
  and, if one was added, `cv: {name, type, base64}`: a PDF or Word file of at most 5 MB
  (5 × 1024 × 1024 bytes, checked in the page before sending), dropped on the box or
  chosen with the file dialog, whose type is taken from its first bytes, never from the
  browser's guess. What the page says after sending depends on the answer: 202 with
  `mailbox: 'confirm'` means the service first e-mailed a confirmation link to the
  student's Wayne State address ("Sent. Check your Wayne State mail for a confirmation
  link."); any other 202 means the lab lead hears at once ("Sent. You hear from the lab
  lead."). The service must be deployed with `v: 2` before the site, because the form no
  longer sends the old body.
- **Beethoven for VS Code**, `/beethoven/vscode/` (the "For VS Code" pill): its product
  page, `terms.html` (Trial Edition), `terms-full.html` (Full Edition), `privacy.html`
  and `third-party.html`, rendered from its repository's `extension/` texts
  (`../beethoven-vscode/`, or `../ashley/` until the folder is renamed;
  `BEETHOVEN_VSCODE_REPO` overrides), plus `beethoven/vscode-license.txt` and
  `vscode-license-full.txt`, byte-for-byte copies of the two agreements. Its version is
  read from its `extension/package.json`. The other spellings `beethoven/vscode-privacy.html`
  and `beethoven/third_party_notices.html` are redirects in `REDIRECTS`.
- **Symphony**, `/symphony/` (its own tab): the GitHub App that sets a team of Claude Code
  teammates up on a repository, and Symphony for Chrome, the extension that puts its install
  one click away on github.com. The page is in the Beethoven home's style with the promo film
  (`symphony/symphony-promo.webm`, `.mp4`, `poster.jpg`) in the diagram's place; the
  extension's privacy statement, `/symphony/privacy.html` (the address its Chrome Web Store
  listing names), is rendered from its repository's `PRIVACY.md` (`../symphony-extension/`;
  `SYMPHONY_REPO` overrides) and checked word for word, like the Beethoven texts.
- **The Symphony control panel**, `/symphony/control/` (in the Symphony strip and the footer
  beside the Tokens page, and kept out of search by its `noindex`): drives a Symphony repository through GitHub's REST API as the signed-in
  person, from the browser. "Sign in with GitHub" is the way in, SymphonyBoard's user token
  through the stateless sign-in service in symphony-app, pressable once `SIGNIN_SERVICE` and
  `CLIENT_ID` at the top of `assets/js/symphony-panel.js` name the deployed service (until then
  the button shows unpressable, with a line saying why); a fine-grained token kept in the browser
  is the fallback, folded under "Use a fine-grained token instead". It shows the board (STATE.md
  on the branch `board`, rendered by a small Markdown renderer of its own), the open issues by the
  protocol's labels, the worker registry, the open pull requests with their checks and the Actions
  runs; it queues a task, gives an issue to a worker, opens the "Add a worker" issue, asks Claude
  (an issue or a comment mentioning @claude), asks the assistant (a question as a comment on an
  issue "Assistant: <login>" labelled `assistant`, opened once per repository and person with
  write access, whose read-only answer from the Claude workflow the page polls for with an ETag
  and renders, acting only on the few lines of its `symphony` block: focus, open, filter, show),
  starts the workers, the board, the checks and the
  metrics by hand, merges a green pull request (the token needs Contents: Read and write for that), and gives the two presses that set Symphony up on
  a repository named without the topic `symphony`. Every state is written in words and every action
  is a named button, so a browsing Claude can drive it; `?repo=OWNER/NAME` lands on one
  repository. **`/symphony/cost.html`** beside it reads `METRICS.json` on the branch `metrics` of
  the chosen repository and prices the same tokens under the other ways of running coding agents
  on GitHub, with a calculator; every price names its source. Both pages share the script and
  `assets/css/control.css`, which ride on the admin page's `.admin` styles.
- **`/beethoven/admin.html`**, the maintainer's approval page, is generated like any page
  but `hidden`: no navigation leads to it, it carries `noindex` and it is not in the
  sitemap. It reads the access service's address from `beethoven/services.json`
  (`beethoven-access`).

One approval covers both editions; `/beethoven/request.html` is the one request form.
Every text is checked word for word against its source, and the old product name may
appear on a page only inside a person's name or one of the `KEPT` identifiers (the key
prefixes `ASHLEY1.`/`ASHLEYREV1`, the folders `~/.ashley`, `~/.ashley-local` and
`/shared/ashley`, the old settings `ashley.*`, the old Marketplace id and service name),
which stay because renaming them would break an installed copy. `VSCODE_STORE_URL`,
`BROWSERS` (Chrome only; `store_url` the listing's address, or `None`) and `LISTING_NOTE` are at the top of
`tools/build_site.py`.

**Retired:** the browser repository's `tools/site_beethoven_build.py` and the VS Code
repository's `tools/site_build.py` and `docs/site/` no longer build pages for this site;
everything is generated here.

Never edited by hand: `beethoven/services.json` and `beethoven/killlist.json` (both
editions fetch them; the build checks that `services.json` names every route both read,
on `beethoven-access`, and never writes either), the `KEPT_FILES` under `/ashley/`, and
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
