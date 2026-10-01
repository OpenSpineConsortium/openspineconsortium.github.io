"""tools/build_site.py: write every page of openspineconsortium.com from one site map.

    python -X utf8 tools/build_site.py              # build, stamp, check
    python -X utf8 tools/build_site.py --external   # also ask every outside link for a status
    python -X utf8 tools/build_site.py --check-only # write nothing; check what is on disk
    python -X utf8 tools/build_site.py --out DIR    # copy the site to DIR (new or empty, outside
                                                    # the site) and build and check there instead

WHAT IT DOES, IN ORDER

 1. Reads SITE below: every page, its label, its address and its children. The header, the
    section strip, the breadcrumb and the footer of every page are made from this one map, so no
    page can disagree with another about where anything is.
 2. Writes each generated page from its body file, tools/pages/<output file minus .html>/body.html
    (front matter + the HTML inside <main>; README.md has the convention), wrapped in
    tools/templates/page.html. Directives in a body file are filled in here:
        <!-- build:<text>-title -->  <!-- build:<text>-toc -->  <!-- build:<text>-text -->
            for each <text> in TEXTS: license, privacy (the browser edition), vscode-license,
            vscode-full, vscode-privacy, vscode-third-party (Beethoven for VS Code); -toc only
            for the agreements
        <!-- build:request-form services=<url> [fine=short] -->   the access form and its script
        <!-- build:browsers -->                      the one install card: Chrome, the private listing
        <!-- build:vscode-install -->                the Beethoven for VS Code install card
        <!-- build:section-index -->                 on a tab's landing page, the pages one level
                                                     below its children (tutorials, Spine MRI parts)
        {{version}} {{vscode_version}} and {{<text>_version}} for each versioned text
        ({{license_version}}, {{privacy_version}}, {{vscode_license_version}}, ...)
    The agreements, the privacy statements and the VS Code edition's third-party notices are
    rendered from the two Beethoven repositories' own texts (TEXTS below) on every run, and checked
    word for word against them.
 3. Gives the pages that are not generated (the atlas, the Spine MRI series, the tutorials,
    Celebrate Life, the PACS demo) the same header and footer, between <!-- site:... --> markers,
    so a second run replaces rather than adds. Their content is not touched; only the old header,
    the old inline menu script and links to the retired one-page anchors are replaced.
 4. Stamps every local stylesheet, script, image, video and document reference in every page
    with ?v=<yyyymmddHHMM> (UTC), and keeps content hashes on ES-module import edges, because a new
    stamp on gallery.js does not make a browser refetch the ./viewer.js it imports.
 5. Writes sitemap.xml (canonical addresses only, so / is left to /beethoven/) and robots.txt.
 6. Writes the moved pages in REDIRECTS (old address -> new address): a two-line page that sends
    the visitor on, with the query and the fragment (an installed build opens
    /ashley/request.html?access_id=...), and a meta refresh for a browser without scripts. It
    also writes TEXT_COPIES, the plain-text agreements, byte for byte from their sources.
 7. Checks: every page parses and its tags balance; the header is byte-identical on every page
    except the mark on the current tab; the footer is identical everywhere; every internal link and
    asset resolves to a file; every page is reachable; the banned word and the old product name are
    absent (outside a person's name and the KEPT identifiers); every file under /ashley/ is either
    a redirect in REDIRECTS or a file in KEPT_FILES with the same bytes as before (installed
    builds read those by address); /beethoven/services.json names every route both editions read;
    the browser edition is offered only through its private Chrome listing (check_private_listing:
    no package of it in the site, no link to one, no other browser named on a page).
    A failed check exits non-zero and says which page and why.

THE BROWSER EDITION IS NOT DOWNLOADED FROM THIS SITE. It is on a private Chrome Web Store listing
whose testers are the lab's Google Group; the maintainer adds each approved student's Google account
(the request form asks for it). The site used to copy the packages into beethoven/downloads/; that
step and the folder are gone, and the check fails if either comes back.

/ASHLEY/ is the product's old address. Nothing there is edited by hand: every file is either in
REDIRECTS (written here) or in KEPT_FILES (never written; its SHA-256 is pinned below, so a change
fails the check). A file under /ashley/ in neither table is a failure.

WHAT IT NEVER TOUCHES: the KEPT_FILES, /beethoven/services.json and /beethoven/killlist.json (the
extensions fetch them; the build only checks them), the Google verification file, pacs/xr.html
(a redirect), and the untracked folders under pacs/. It stages and commits nothing.

This replaces the browser repository's tools/site_beethoven_build.py and the VS Code repository's
tools/site_build.py (with its docs/site/ pages) for pages: both are retired and must not be run
against this site again (they would overwrite the themed pages and the redirects).
"""
from __future__ import annotations

import argparse
import concurrent.futures
import datetime as _dt
import hashlib
import html
import json
import os
import re
import shutil
import subprocess
import sys
import urllib.error
import urllib.request
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import unquote, urljoin, urlparse

# ============================================================
# CONFIGURATION
# ============================================================
ROOT = Path(__file__).resolve().parent.parent
PAGES = ROOT / "tools" / "pages"
TEMPLATES = ROOT / "tools" / "templates"
ORIGIN = "https://openspineconsortium.com"
# Where pages are written and checked: the site itself, or the copy that --out makes. Sources
# (tools/pages, tools/templates) are always read from ROOT.
OUT = ROOT


def sibling_repo(env, names, marker):
    """A repository beside this one: $env if set, else the first of `names` holding `marker`.
    The folders are renamed after 2026-09-30 (ashley-bridge -> beethoven, ashley ->
    beethoven-vscode); the old names stay in the list so the build works on either side of that."""
    if os.environ.get(env):
        return Path(os.environ[env])
    for name in names:
        if (ROOT.parent / name / marker).exists():
            return ROOT.parent / name
    return ROOT.parent / names[-1]


# The browser edition's repository (override with BEETHOVEN_REPO)
BEETHOVEN_REPO = sibling_repo("BEETHOVEN_REPO", ("beethoven", "ashley-bridge"), "extension/src/licensing")
# its version ({{version}}) is read from its extension/package.json on every run; the site offers no
# package of it (see BROWSERS)
BEETHOVEN_EXT = BEETHOVEN_REPO / "extension"
# Beethoven for VS Code's repository (override with BEETHOVEN_VSCODE_REPO); its version is read from
# its extension/package.json on every run
VSCODE_REPO = sibling_repo("BEETHOVEN_VSCODE_REPO", ("beethoven-vscode", "ashley"), "extension/LICENSE-FULL.txt")
VSCODE_EXT = VSCODE_REPO / "extension"
# The Marketplace listing's address once it is published under OpenSpineConsortium.beethoven; None
# shows "Listing pending" (the maintainer uploads the new id by hand)
VSCODE_STORE_URL = None

# The texts rendered onto pages, checked word for word against their sources. kind: agreement
# (hard-wrapped plain text), markdown (pandoc). page: where it is rendered (the body file places it).
TEXTS = {
    "license": {"src": BEETHOVEN_REPO / "LICENSE.txt", "kind": "agreement", "page": "beethoven/terms.html"},
    "privacy": {"src": BEETHOVEN_REPO / "PRIVACY.md", "kind": "markdown", "page": "beethoven/privacy.html"},
    "vscode-license": {"src": VSCODE_EXT / "LICENSE.txt", "kind": "agreement", "page": "beethoven/vscode/terms.html"},
    "vscode-full": {"src": VSCODE_EXT / "LICENSE-FULL.txt", "kind": "agreement",
                    "page": "beethoven/vscode/terms-full.html"},
    "vscode-privacy": {"src": VSCODE_EXT / "PRIVACY.md", "kind": "markdown", "page": "beethoven/vscode/privacy.html"},
    "vscode-third-party": {"src": VSCODE_EXT / "THIRD_PARTY_NOTICES.md", "kind": "markdown", "versioned": False,
                           "page": "beethoven/vscode/third-party.html"},
}
# The agreements as plain text too, byte for byte (the VS Code edition's README and Marketplace
# listing link a .txt, as /ashley/license.txt was)
TEXT_COPIES = {
    "beethoven/vscode-license.txt": "vscode-license",
    "beethoven/vscode-license-full.txt": "vscode-full",
}
# The browser edition has one listing: the Chrome Web Store, Private visibility, open only to the Google
# accounts in the lab's Google Group of testers (the maintainer adds each approved student's Google
# account, which the request form asks for). No other store, and no package on this site.
# store_url: None shows no button, only how the invitation comes. Set it to the listing's address only
# if the card should link it; the listing still opens only for the invited accounts.
BROWSERS = [
    {"key": "chrome", "name": "Chrome", "store": "Chrome Web Store", "store_url": None},
]
PRIVATE_LISTING = ("Private listing, by invitation: after approval you receive an invitation at the Google "
                   "account you gave.")
# What check_private_listing refuses: a package of the extension in the site or a link to one, and
# another browser named in a page's text (case matters: "edge cases" is not the browser)
OLD_DOWNLOADS = "beethoven/downloads"
PACKAGE_FILE = re.compile(r"^beethoven[-_].*\.(?:zip|crx|xpi)$", re.I)
PACKAGE_LINK = re.compile(r"/beethoven/downloads\b|beethoven[-_][^\"'\s/]*\.(?:zip|crx|xpi)\b", re.I)
OTHER_BROWSERS = re.compile(r"\b(?:Edge|Firefox|Safari|Opera|Brave|Vivaldi)\b")
PANDOC = shutil.which("pandoc") or r"C:\Program Files\Pandoc\pandoc.exe"
FONTS = ("https://fonts.googleapis.com/css2?family=Newsreader:ital,opsz,wght@0,6..72,400;0,6..72,500;"
         "0,6..72,600;1,6..72,400;1,6..72,500&family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:"
         "wght@400;500;600&display=swap")
ICON = ("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 28 28'%3E%3Cg fill='none' "
        "stroke='%230E5F58' stroke-width='2' stroke-linecap='round'%3E%3Cpath d='M14 3.5 C 10 6, 18 9, 14 12.5 "
        "C 10 16, 18 19, 14 24.5'/%3E%3Cline x1='8.5' y1='6.2' x2='19.5' y2='6.2'/%3E%3Cline x1='8.5' y1='12.5' "
        "x2='19.5' y2='12.5'/%3E%3Cline x1='8.5' y1='18.8' x2='19.5' y2='18.8'/%3E%3C/g%3E%3C/svg%3E")
STAMP = _dt.datetime.now(_dt.timezone.utc).strftime("%Y%m%d%H%M")
NOTICE = "NOTICE ADDRESS TO BE PUBLISHED BY THE LICENSOR BEFORE ANY MARKETPLACE LISTING OR PAID KEY"

# ES-module import edges, leaves first: (importer, imported). The importer carries the imported
# file's content hash; see the note in step 5 above.
MODULE_EDGES = [
    ("assets/js/viewer.js", "assets/js/vendor/three.module.js"),
    ("assets/js/viewer.js", "assets/js/vendor/OrbitControls.js"),
    ("assets/js/gallery.js", "assets/js/viewer.js"),
    ("pacs/xr.js", "pacs/infer.js"),
    ("pacs/xr.js", "pacs/remote.js"),
]

# Nothing under these is templated, stamped or checked as a page. (/ashley/ is not here: every file
# there is in REDIRECTS or KEPT_FILES below, and check_legacy checks both.)
EXCLUDE_DIRS = ("tools/", "pacs/sllp/", "pacs/testimgs/", "pacs/webtest/", "node_modules/", ".git/")
EXCLUDE_FILES = ("googlec3911e7fb095977e.html", "pacs/xr.html")

# Moved pages: old file -> new address. Each old file becomes a two-line page that sends the visitor
# on (redirect_page). The product was called Ashley until 2026-09-30; installed copies and old links
# still open these addresses.
REDIRECTS = {
    "ashley/index.html": "/beethoven/vscode/",            # Ashley for VS Code 3.0.0's homepage
    "ashley/request.html": "/beethoven/request.html",     # opened with ?access_id= by Beethoven 4-6 and the old /trial 403
    "ashley/support.html": "/beethoven/support.html",     # 3.0.0's bugs/qna address; #notice and the other anchors carry over
    "ashley/admin.html": "/beethoven/admin.html",         # the old access service's decide pages link it
    "ashley/third_party_notices.html": "/beethoven/vscode/third-party.html",
    "ashley/bridge/index.html": "/beethoven/",            # Beethoven 4.0.0 to 6.0.0's homepage
    # the second spellings of the VS Code edition's pages, so either set of links works
    "beethoven/vscode-privacy.html": "/beethoven/vscode/privacy.html",
    "beethoven/third_party_notices.html": "/beethoven/vscode/third-party.html",
}
# Old files kept byte for byte, because installed builds read them by address (or they are the
# exact texts people accepted). The build never writes them; a different SHA-256 is a failure.
# Remove one only when no installed build that reads it is left.
KEPT_FILES = {
    # Ashley for VS Code 3.0.0 reads it (servicesUrl default); Beethoven 4.0.0 to 6.0.0 read access_check from it.
    # Changed once, on 2026-10-01: the allowlist key is gone (the approved list is not published; with no list
    # address 3.0.0 lets /trial decide), every other byte as it was
    "ashley/services.json": "efebb91ed0c7f219f608b6ecc80acee5f564f916a62209e3e4a18d90d02ae5b1",
    # Beethoven 4.0.0 to 6.0.0's withdrawn-versions list (ASHLEYREV1; never re-signed)
    "ashley/bridge-killlist.json": "f7ec6b8b0774bb52352791ba4960386e6df77cd6c0528b0ff4af3c3535142a81",
    # the VS Code edition's agreements and privacy statement, version 4, as 3.0.0 users accepted them
    "ashley/license.txt": "40388c173ac66a6a82f939b76b99162fada519f653f8698efea1c9727ad818f4",
    "ashley/license-full.txt": "e28d9e94bdd3ed0be61fe10cec67d235569533f6bbfd26674f958e54bff2801d",
    "ashley/privacy.html": "97b533bf34584483f9ad0b8bde2cd0cae1814b4a752691c7a55355701d62458b",
    # the browser edition's texts as Beethoven 4.0.0 to 6.0.0 users accepted them
    "ashley/bridge/privacy.html": "c764803a5aac56eb0ce660165e2ac34a882a08b1cc0129e571fa48d761eeed2f",
    "ashley/bridge/terms.html": "8baff1eee8ac62949e41ab93550b243db092bb7ff2c315f5a62ede845e1f06ef",
}
LEGACY = set(REDIRECTS) | set(KEPT_FILES)
# The routes the two editions read from /beethoven/services.json: the browser edition's
# access_check, request and revocation, and the VS Code edition's license_service, revocation and
# report; both show request_page and support_page. No allowlist since 2026-10-01: the access service no
# longer publishes the approved AccessIDs (the browser edition's privacy statement, version 8, says it
# answers about one account and nothing about anyone else), and with no list address both VS Code
# builds let /trial decide. NO_SERVICES_KEYS must not come back in either services file.
SERVICES_KEYS = ("access_check", "request", "revocation", "license_service", "report",
                 "request_page", "support_page")
NO_SERVICES_KEYS = ("allowlist",)
SERVICE_HOST = "beethoven-access.openspineconsortium.workers.dev"

# The retired one-page anchors, for links in the sub-sites that pointed at them.
LEGACY_ANCHORS = {
    "": "/", "home": "/research/", "project": "/research/", "datasets": "/data/datasets/",
    "people": "/people/", "organization": "/people/organization/", "education": "/people/education/",
    "workshop": "/research/workshop/", "goals": "/research/goals/", "conferences": "/research/conferences/",
    "gallery": "/data/gallery/", "hardware": "/data/hardware/", "outside": "/research/outside/",
    "join": "/onboarding/",
}

BANNED = re.compile(r"prov[a-z]*enance", re.I)
OLD_NAME = re.compile(r"ashley", re.I)
# the person keeps her name; these are the only places the letters may appear outside /ashley/
PERSON = re.compile(r"Ashley Schehr|Ashley and Razanne|Schehr,\s*Ashley|schehr-ashley", re.I)
# Identifiers that keep the old letters because renaming them would break an installed copy; a
# text may name them (the VS Code edition's agreement says what its access key begins with and
# where its files are). Case matters: "Ashley" as a name is never one of these.
KEPT = re.compile(
    r"\bASHLEY(?:REV)?1\b"                      # key and withdrawn-list prefixes still issued and accepted
    r"|\bASHLEY-RELEASE1\b"                     # the release-signature domain
    r"|(?:~|\$HOME|%USERPROFILE%)[/\\]\.ashley(?:-local|-vendor)?\b"  # folders kept or linked
    r"|/shared/ashley\b"                        # the shared grid folder's old name, kept as a link
    r"|\bashley\.\*"                            # the old settings, still read
    r"|\b[Oo]pen[Ss]pine[Cc]onsortium\.ashley\b"  # the old Marketplace id
    r"|\bashley-service\b"                      # the access service's old name, still deployed
    r"|\bashley-cli\.js\b"                      # a bundled file name
)


def old_name_left(text):
    """The old product name outside a person's name and the KEPT identifiers, with some context."""
    stripped = KEPT.sub("", PERSON.sub("", text))
    return sorted(set(m.group(0) for m in re.finditer(r".{0,30}ashley.{0,30}", stripped, re.I)))


# ============================================================
# THE SITE MAP
# kind: page (generated from tools/pages), sub (a page of its own; gets the shell injected),
#       app (full-screen; gets the header only)
# hidden=True: generated and checked like any page, but left out of the strip, the footer, the
#       section index, the reachability check and the sitemap (a maintainer's page)
# ============================================================
def node(label, path, kind="page", children=(), **kw):
    n = {"label": label, "path": path, "kind": kind, "children": list(children)}
    n.update(kw)
    return n


TUTORIALS = [
    ("1. Environment setup", "01_environment_setup.html"),
    ("2. DICOM vs. NIfTI", "02_dicom_vs_nifti.html"),
    ("3. Inference (pretrained nnU-Net)", "03_inference_pretrained_nnunet.html"),
    ("4. AI annotation (ITK-SNAP)", "04_itksnap_ai_annotation.html"),
    ("5. Training on the WSU grid", "05_training_on_the_grid.html"),
    ("6. Writing an AI paper", "06_writing_an_ai_paper.html"),
]
SPINE_MRI = [
    ("Timelines", "timeline.html"),
    ("Part 1 · Cervical cord compression", "01-cervical-cord-compression.html"),
    ("Part 2 · Lumbar central stenosis", "02-lumbar-central-stenosis.html"),
    ("Part 3 · Nerve root and foramen", "03-nerve-root-and-foramen.html"),
    ("Part 4 · Anatomic checkpoints", "04-anatomic-checkpoints.html"),
]

SITE = [
    node("Home", "/", strip="Beethoven", strip_path="/beethoven/", footer="Beethoven", children=[
        node("Product", "/beethoven/", crumb="Beethoven", same_as="/"),
        node("Agreement", "/beethoven/terms.html"),
        node("Privacy", "/beethoven/privacy.html"),
        node("Support", "/beethoven/support.html"),
        node("Ask for access", "/beethoven/request.html"),
        node("Reviewers", "/beethoven/reviewers.html", crumb="For reviewers and security offices"),
        node("For VS Code", "/beethoven/vscode/", crumb="Beethoven for VS Code", children=[
            node("Trial agreement", "/beethoven/vscode/terms.html"),
            node("Full agreement", "/beethoven/vscode/terms-full.html"),
            node("Privacy", "/beethoven/vscode/privacy.html"),
            node("Third-party notices", "/beethoven/vscode/third-party.html"),
        ]),
        # the maintainer's page: generated and checked, never in the navigation or the sitemap
        node("Access admin", "/beethoven/admin.html", hidden=True),
    ]),
    node("Onboarding", "/onboarding/", overview="Start here", children=[
        node("By hand", "/onboarding/by-hand.html", optional=True),
    ]),
    node("Research", "/research/", overview="Overview", children=[
        node("Conferences", "/research/conferences/"),
        node("Workshop", "/research/workshop/", children=[
            node("Tutorials", "/tutorials/", kind="sub", in_footer=True, children=[
                node(label, "/tutorials/" + f, kind="sub") for label, f in TUTORIALS]),
        ]),
        node("Goals", "/research/goals/"),
        node("Outside work", "/research/outside/"),
    ]),
    node("Data & Tools", "/data/", overview="Overview", children=[
        node("Datasets", "/data/datasets/"),
        node("Atlas", "/atlas/", kind="sub"),
        node("Gallery", "/data/gallery/"),
        node("Hardware", "/data/hardware/"),
        node("Spine MRI", "/spine-mri/", kind="sub", children=[
            node(label, "/spine-mri/" + f, kind="sub") for label, f in SPINE_MRI]),
        node("CT", "/pacs/ct.html", kind="app"),
        node("X-ray", "/pacs/", kind="app"),
    ]),
    node("People", "/people/", overview="Team", children=[
        node("Organization", "/people/organization/"),
        node("Education", "/people/education/"),
        node("Celebrate Life", "/celebrate-life/", kind="sub"),
    ]),
]
CTA = {"label": "Get Involved", "path": "/beethoven/request.html"}


def walk(nodes, parents=()):
    for n in nodes:
        yield n, parents
        yield from walk(n["children"], parents + (n,))


def out_file(path):
    """/ -> index.html, /a/ -> a/index.html, /a/b.html -> a/b.html"""
    p = path.lstrip("/")
    return p + "index.html" if (p == "" or p.endswith("/")) else p


def body_file(path):
    return PAGES / out_file(path)[: -len(".html")] / "body.html"


# ============================================================
# SMALL HELPERS
# ============================================================
def read(p):
    return Path(p).read_bytes().decode("utf-8")


def write(p, text, crlf=False):
    """Write UTF-8; LF unless the file was CRLF before (a sub-site page keeps its own endings)."""
    p = Path(p)
    p.parent.mkdir(parents=True, exist_ok=True)
    data = text.replace("\r\n", "\n")
    if crlf:
        data = data.replace("\n", "\r\n")
    b = data.encode("utf-8")
    if p.exists() and p.read_bytes() == b:
        return False
    p.write_bytes(b)
    return True


def is_crlf(text):
    return text.count("\r\n") > text.count("\n") / 2


def fill(template, values, where):
    def sub(m):
        k = m.group(1)
        if k not in values:
            raise SystemExit(f"{where}: no value for {{{{{k}}}}}")
        return values[k]
    return re.sub(r"\{\{(\w+)\}\}", sub, template)


def template(name):
    return read(TEMPLATES / name)


def esc(s):
    return html.escape(s, quote=True)


# ============================================================
# NAVIGATION: header, strip, breadcrumb, footer
# ============================================================
def lookup(path):
    for n, parents in walk(SITE):
        if n["path"] == path:
            return n, parents
    return None, ()


def exists(n):
    if n.get("optional"):
        return body_file(n["path"]).exists() or (OUT / out_file(n["path"])).exists()
    return True


def listed(n):
    """In the navigation: exists and is not a hidden page."""
    return exists(n) and not n.get("hidden")


def header(current):
    """The header; `current` is the page's path. Only aria-current differs between pages."""
    n, parents = lookup(current)
    chain = [p["path"] for p in parents] + ([n["path"]] if n else [])
    same = n.get("same_as") if n else None
    lines = []
    for tab in SITE:
        mark = ""
        if tab["path"] == current or tab["path"] == same:
            mark = ' aria-current="page"'
        elif tab["path"] in chain:
            mark = ' aria-current="true"'
        lines.append(f'    <a href="{tab["path"]}"{mark}>{esc(tab["label"])}</a>')
    cta = ' aria-current="page"' if current == CTA["path"] else ""
    lines.append(f'    <a href="{CTA["path"]}" class="nav__cta"{cta}>{esc(CTA["label"])}</a>')
    return fill(template("header.html"), {"links": "\n".join(lines)}, "header.html")


def section_of(path):
    n, parents = lookup(path)
    if not n:
        return None
    return parents[0] if parents else n


def strip(current):
    """The section strip: the section's name, then its landing page and its children."""
    tab = section_of(current)
    if not tab:
        return ""
    kids = [c for c in tab["children"] if listed(c)]
    if not kids:
        return ""
    n, parents = lookup(current)
    chain = {p["path"] for p in parents} | {current}
    if n and n.get("same_as"):
        chain.add(n["same_as"])
    items = []
    if tab.get("overview"):
        items.append((tab["overview"], tab["path"]))
    items += [(c["label"], c["path"]) for c in kids]
    pills = []
    for label, path in items:
        c, _ = lookup(path)
        mark = ""
        if path == current or (c and c.get("same_as") == current):
            mark = ' aria-current="page"'
        elif path in chain and path != tab["path"]:
            mark = ' aria-current="true"'
        pills.append(f'<a class="subnav__pill" href="{path}"{mark}>{esc(label)}</a>')
    title = tab.get("strip", tab["label"])
    title_path = tab.get("strip_path", tab["path"])
    return (f'<nav class="subnav" aria-label="{esc(title)}">\n  <div class="subnav__in">\n'
            f'    <a class="subnav__title" href="{title_path}">{esc(title)}</a>\n'
            f'    <div class="subnav__pills">{"".join(pills)}</div>\n  </div>\n</nav>')


def crumbs(current):
    """Home › section › … › this page, shown above the footer."""
    n, parents = lookup(current)
    if not n or current == "/":
        return ""
    trail = [("Home", "/")]
    for p in parents:
        if p["path"] == "/":
            continue
        trail.append((p.get("crumb", p["label"]), p["path"]))
    trail.append((n.get("crumb", n["label"]), n["path"]))
    items = []
    for i, (label, path) in enumerate(trail):
        if i == len(trail) - 1:
            items.append(f'<li><span aria-current="page">{esc(label)}</span></li>')
        else:
            items.append(f'<li><a href="{path}">{esc(label)}</a></li>')
    return ('<div class="crumbs-band"><nav class="crumbs" aria-label="Breadcrumb"><ol>'
            + "".join(items) + "</ol></nav></div>")


def footer():
    cols = []
    for tab in SITE:
        title = tab.get("footer", tab["label"])
        head_path = tab.get("strip_path", tab["path"])
        items = []
        if tab.get("overview"):
            items.append((tab["overview"], tab["path"]))
        for c in tab["children"]:
            if not listed(c):
                continue
            items.append((c["label"], c["path"]))
            for g in c["children"]:
                if g.get("in_footer") and listed(g):
                    items.append((g["label"], g["path"]))
        lis = "".join(f'<li><a href="{p}">{esc(l)}</a></li>' for l, p in items)
        cols.append(f'    <div class="footer__col"><h2><a href="{head_path}">{esc(title)}</a></h2><ul>{lis}</ul></div>')
    return fill(template("footer.html"), {"directory": "\n".join(cols)}, "footer.html")


def header_block(current, with_strip=True):
    parts = ["<!-- site:header -->", header(current)]
    s = strip(current) if with_strip else ""
    if s:
        parts.append(s)
    parts.append("<!-- /site:header -->")
    return "\n".join(parts)


def footer_block(current, app=False):
    parts = ["<!-- site:footer -->"]
    if not app:
        c = crumbs(current)
        if c:
            parts.append(c)
        parts.append(footer())
    parts.append('<script src="/assets/js/main.js"></script>')
    parts.append("<!-- /site:footer -->")
    return "\n".join(parts)


# ============================================================
# THE BEETHOVEN TEXTS
# ============================================================
HEADING = re.compile(r"^\d{1,2}\.\s+\S")  # "12. NO WARRANTY"
ITEM = re.compile(r"^\([a-z]\)\s")  # "(b) distribute, ..."


def version_of(text, name):
    m = re.search(r"^Version (\d+), (\d{4}-\d{2}-\d{2})", text, re.M)
    if not m:
        raise SystemExit(f"{name}: no 'Version N, YYYY-MM-DD' line")
    return m.group(1), m.group(2)


def license_parts(text):
    """LICENSE.txt is hard-wrapped plain text (ported from the Beethoven repository's builder).
    Blocks are separated by blank lines; the first block is the title; a one-line all-caps block
    starting "N." is a section heading; a line starting "(a) " begins a sub-item of its own; an
    indented line continues the line before it. Every word is kept; the check proves it.
    Returns (title html, table of contents html, text html)."""
    blocks = re.split(r"\n\s*\n", text.replace("\r\n", "\n").strip("\n"))
    title, out, toc = "", [], []
    for i, block in enumerate(blocks):
        lines = block.split("\n")
        if i == 0 and len(lines) == 1:
            title = f"<h1>{esc(lines[0].strip())}</h1>"
            continue
        if len(lines) == 1 and HEADING.match(lines[0]) and lines[0] == lines[0].upper():
            head = lines[0].strip()
            num = head.split(".", 1)[0]
            out.append(f'<h2 id="s{num}">{esc(head)}</h2>')
            name = head.split(".", 1)[1].strip().capitalize()
            for proper in ("Beethoven", "Michigan", "Anthropic", "Claude", "Licensor", "VS Code", "Microsoft",
                           "GitHub", "Hugging Face", "Wayne State"):
                name = re.sub(r"\b" + proper.lower() + r"\b", proper, name)
            toc.append(f'<li><a href="#s{num}">{esc(num)}. {esc(name)}</a></li>')
            continue
        paras = []
        for line in lines:
            s = line.strip()
            if not s:
                continue
            if paras and not line[:1].isspace() and ITEM.match(s):
                paras.append(s)
            elif paras:
                paras[-1] += " " + s
            else:
                paras.append(s)
        out.extend(f"<p>{esc(p)}</p>" for p in paras)
    toc_html = '<nav class="toc" aria-label="Sections"><p>Sections</p><ol>' + "".join(toc) + "</ol></nav>"
    return title, toc_html, "\n".join(out)


def markdown_parts(md_path):
    """A Markdown text (a privacy statement, the third-party notices) through pandoc.
    Returns (title html, text html)."""
    r = subprocess.run([PANDOC, str(md_path), "-f", "markdown+pipe_tables", "-t", "html5", "--wrap=none"],
                       check=True, capture_output=True)
    frag = r.stdout.decode("utf-8").replace("\r\n", "\n").strip()
    # a wide table scrolls inside its own box, never the page
    frag = re.sub(r"<table>", '<div class="table-scroll"><table>', frag)
    frag = frag.replace("</table>", "</table></div>")
    m = re.match(r"(<h1[^>]*>.*?</h1>)\s*(.*)", frag, re.S)
    if not m:
        raise SystemExit(f"{md_path}: pandoc output does not start with a heading")
    return m.group(1), m.group(2)


def load_texts(problems):
    """Render every text in TEXTS; check each word for word against its source. Returns the values
    the directives and placeholders take: <key>-title, <key>-toc, <key>-text, <key>_version."""
    values, rendered = {}, {}
    for key, t in TEXTS.items():
        src = t["src"]
        name = f"{src.parent.name}/{src.name}"
        if not src.exists():
            raise SystemExit(f"{src}: not there (set BEETHOVEN_REPO or BEETHOVEN_VSCODE_REPO)")
        text = read(src)
        if BANNED.search(text):
            raise SystemExit(f"{src}: the banned word is in the source text")
        if key in ("license", "privacy"):
            # the browser edition's texts never carried the old name and must not start to
            if OLD_NAME.search(PERSON.sub("", text)):
                raise SystemExit(f"{src}: the source text carries the old product name")
        else:
            left = old_name_left(text)
            if left:
                problems.append(f"{src}: the source text carries the old product name outside the kept "
                                f"identifiers: {left[:4]}")
        if t.get("versioned", True):
            v, d = version_of(text, name)
            values[key.replace("-", "_") + "_version"] = v
            t["version"], t["date"] = v, d
        if t["kind"] == "agreement":
            title, toc, body = license_parts(text)
            values[key + "-toc"] = toc
            check_words(name, text, title + "\n" + body, problems)
        else:
            title, body = markdown_parts(src)
            check_words(name, re.sub(r"`", "", text), title + "\n" + body, problems)
            # a pipe-table row wrapped onto a second line renders as split or empty cells, sometimes
            # with a paragraph of raw pipes after the table; every word is still there, so check_words
            # cannot see it. These texts write every row on one line, from "|" to "|".
            lines = text.splitlines()
            for i, line in enumerate(lines):
                in_table = line.startswith("|") or (i and lines[i - 1].startswith("|") and line.strip())
                if in_table and not (line.startswith("|") and line.rstrip().endswith("|")):
                    problems.append(f"{src}:{i + 1}: a table row is wrapped onto more than one line "
                                    f"(pandoc renders it as broken cells): {line.strip()[:60]!r}")
                    break
            stray = [q for q in re.findall(r"<p>(.*?)</p>", body, re.S) if q.count(" | ") >= 2]
            if stray:
                problems.append(f"{src}: a table did not render (a row wrapped onto a second line?): "
                                f"{html.unescape(re.sub(r'<[^>]+>', '', stray[0]))[:80]!r}")
        values[key + "-title"], values[key + "-text"] = title, body
        rendered[key] = (text, title, body)
    return values, rendered


class Text(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts, self.skip = [], 0

    def handle_starttag(self, tag, attrs):
        if tag in ("script", "style"):
            self.skip += 1

    def handle_endtag(self, tag):
        if tag in ("script", "style"):
            self.skip -= 1

    def handle_data(self, data):
        if not self.skip:
            self.parts.append(data)


def text_of(fragment):
    t = Text()
    t.feed(fragment)
    t.close()
    return "".join(t.parts)


def words(s):
    s = s.replace("\u2019", "'").replace("\u2018", "'")
    return re.findall(r"[A-Za-z0-9']+", s)


def check_words(name, source_text, rendered_html, problems):
    want, have = " ".join(words(source_text)), " ".join(words(text_of(rendered_html)))
    if want not in have:
        w, h = want.split(), have.split()
        k = next((i for i in range(min(len(w), len(h))) if w[i] != h[i]), min(len(w), len(h)))
        problems.append(f"{name}: the page does not carry every word of its source in order; first difference near "
                        f"word {k}: source '{' '.join(w[max(0, k - 4):k + 4])}' vs page '{' '.join(h[max(0, k - 4):k + 4])}'")


# ============================================================
# BODY FILES
# ============================================================
FRONT_KEYS = {"title", "description", "css", "js", "canonical", "body_class", "strip", "breadcrumb", "robots"}


def parse_body(p):
    raw = read(p).replace("\r\n", "\n")
    if not raw.startswith("---\n"):
        raise SystemExit(f"{p}: no front matter (a first line of three dashes)")
    end = raw.find("\n---\n", 4)
    if end < 0:
        raise SystemExit(f"{p}: the front matter is not closed with a line of three dashes")
    meta = {}
    for line in raw[4:end].split("\n"):
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        k, sep, v = line.partition(":")
        k = k.strip()
        if not sep or k not in FRONT_KEYS:
            raise SystemExit(f"{p}: front matter line '{line}' is not one of {sorted(FRONT_KEYS)}")
        meta[k] = v.strip()
    for k in ("title", "description"):
        if not meta.get(k):
            raise SystemExit(f"{p}: front matter has no {k}")
    return meta, raw[end + 5:]


def browsers_html():
    """The install card: Chrome, the private listing. There is nothing to download here; with
    store_url set, the card also links the listing (it opens only for the invited accounts)."""
    cards = []
    card = template("browser-card.html")
    for b in BROWSERS:
        action = ""
        if b["store_url"]:
            if not b["store_url"].startswith("https://chromewebstore.google.com/"):
                raise SystemExit(f"BROWSERS: {b['store_url']} is not a Chrome Web Store address")
            action = (f'    <a class="btn btn--solid" href="{esc(b["store_url"])}" target="_blank" rel="noopener">'
                      "Open the private listing</a>\n")
        cards.append(fill(card, {"key": b["key"], "name": esc(b["name"]), "action": action,
                                 "note": esc(PRIVATE_LISTING)}, "browser-card.html").rstrip("\n"))
    one = " browsers--one" if len(cards) == 1 else ""
    return f'<div class="browsers{one}">\n' + "\n".join(cards) + "\n</div>"


def vscode_install_html(version):
    """The one install card for Beethoven for VS Code: the Marketplace button once VSCODE_STORE_URL
    is set, else a note that the listing is pending (there is no direct download of this edition)."""
    if VSCODE_STORE_URL:
        action = (f'<a class="btn btn--solid" href="{esc(VSCODE_STORE_URL)}" target="_blank" rel="noopener">'
                  'Get it on the Visual Studio Code Marketplace</a>')
        note = f"Version {version}. In VS Code, Extensions, search for Beethoven for VS Code."
    else:
        action = ""
        note = "Marketplace listing pending review. Until it is up, your lab lead has the installer."
    return ('<div class="browsers vsc-get">\n<article class="browser">\n'
            '  <h3 class="browser__name">Visual Studio Code</h3>\n'
            + (f"  {action}\n" if action else "")
            + f'  <p class="browser__note">{esc(note)}</p>\n</article>\n</div>')


# The home page's copy of the form is the short one: same fields, same script, same CV box and the same
# consent line (which links the privacy statement), without the three plain hints under the fields (the
# placeholders and the script's own messages carry them) and without the "What this page sends"
# paragraph, which request.html keeps. The Google account's one line, <small class="why">, stays in
# both: without it nobody knows why a Google account is asked for.


def request_form(services, fine):
    out = fill(template("request-form.html"), {"services": services}, "request-form.html")
    for must in ('<small class="why"', 'class="consent"', 'id="cv"', "google_account", "purpose"):
        if must not in out:
            raise SystemExit(f"request-form.html: '{must}' is gone (the form's v2 fields, the Google account's "
                             "line and the consent line are part of the form everywhere it appears)")
    if fine == "short":
        out, n_hints = re.subn(r"\n  <small>.*?</small>", "", out)
        out, n_fine = re.subn(r'\n*<p class="fineprint">.*?</p>', "", out, flags=re.S)
        if n_hints != 3 or n_fine != 1:
            raise SystemExit("request-form.html: the short form expects three plain <small> hints and one "
                             f"fine-print paragraph, found {n_hints} and {n_fine}")
    elif fine != "full":
        raise SystemExit(f"build:request-form: fine={fine} is not 'full' or 'short'")
    return out


def section_index(path):
    """The lessons one level further down, listed on a tab's landing page, so every page is at most
    two clicks from the header: the tab, then the page."""
    tab = section_of(path)
    if not tab:
        return ""
    groups = []
    for c in tab["children"]:
        if not listed(c):
            continue
        kids = []
        for g, _ in walk(c["children"]):
            if listed(g):
                kids.append(g)
        if not kids:
            continue
        lis = "".join(f'<li><a href="{g["path"]}">{esc(g["label"])}</a></li>' for g in kids)
        groups.append(f'  <div class="sindex__group"><h3><a href="{c["path"]}">{esc(c["label"])}</a></h3>'
                      f'<ul>{lis}</ul></div>')
    if not groups:
        return ""
    return (f'<nav class="sindex" aria-label="Every lesson in {esc(tab["label"])}">\n'
            + "\n".join(groups) + "\n</nav>")


def expand(body, texts, where, path=None):
    def form(m):
        args = dict(a.split("=", 1) for a in m.group(1).split())
        unknown = set(args) - {"services", "fine"}
        if unknown:
            raise SystemExit(f"{where}: build:request-form does not take {sorted(unknown)}")
        return request_form(args.get("services", "/beethoven/services.json"), args.get("fine", "full"))
    body = re.sub(r"<!--\s*build:request-form((?:\s+\w+=\S+?)*)\s*-->", form, body)
    body = body.replace("<!-- build:browsers -->", browsers_html())
    if "<!-- build:vscode-install -->" in body:
        body = body.replace("<!-- build:vscode-install -->", vscode_install_html(texts["vscode_version"]))
    if "<!-- build:section-index -->" in body:
        body = body.replace("<!-- build:section-index -->", section_index(path) if path else "")
    # placeholders first, then the texts, so a "{{" inside a text is never read as a placeholder
    if "{{" in body:
        body = fill(body, {"version": texts["version"],
                           **{k: v for k, v in texts.items() if k.endswith("_version")}}, where)

    def text(m):
        if m.group(1) not in texts:
            raise SystemExit(f"{where}: unknown directive <!-- build:{m.group(1)} -->")
        return texts[m.group(1)]
    body = re.sub(r"<!-- build:([\w-]+-(?:title|toc|text)) -->", text, body)
    left = re.findall(r"<!--\s*build:[^>]*-->", body)
    if left:
        raise SystemExit(f"{where}: unknown directive(s) {left}")
    return body


def render_page(n, texts):
    path = n["path"]
    src = body_file(path)
    if not src.exists() and n.get("same_as"):
        src = body_file(n["same_as"])
    meta, body = parse_body(src)
    body = expand(body, texts, str(src.relative_to(ROOT)), path)
    css = "".join(f'\n<link rel="stylesheet" href="{c.strip()}">' for c in meta.get("css", "").split(",") if c.strip())
    robots = meta.get("robots", "").strip()
    head = fill(template("head.html"), {
        "title": esc(meta["title"]), "description": esc(meta["description"]),
        "robots": f'\n<meta name="robots" content="{esc(robots)}">' if robots else "",
        "canonical": esc(meta.get("canonical") or ORIGIN + path), "icon": ICON, "fonts": esc(FONTS),
        "extra_css": css}, "head.html")
    scripts = []
    for j in meta.get("js", "").split(","):
        j = j.strip()
        if not j:
            continue
        parts = j.split()
        mod = ' type="module"' if len(parts) > 1 and parts[1] == "module" else ""
        scripts.append(f'<script{mod} src="{parts[0]}"></script>')
    show_strip = meta.get("strip", "yes").lower() != "no"
    fb = footer_block(path)
    if meta.get("breadcrumb", "yes").lower() == "no":
        fb = fb.replace(crumbs(path) + "\n", "") if crumbs(path) else fb
    cls = meta.get("body_class", "").strip()
    page = fill(template("page.html"), {
        "source": str(src.relative_to(ROOT)).replace("\\", "/"), "head": head,
        "body_class": f' class="{esc(cls)}"' if cls else "",
        "header_block": header_block(path, show_strip), "body": body.strip("\n"),
        "footer_block": fb, "scripts": "\n".join(scripts)}, "page.html")
    return page, src


# ============================================================
# SUB-SITES AND APP PAGES: inject between markers
# ============================================================
def replace_block(text, name, block, fallback):
    """Replace <!-- site:name --> … <!-- /site:name -->, or else apply fallback(text, block)."""
    pat = re.compile(r"<!-- site:" + name + r" -->.*?<!-- /site:" + name + r" -->", re.S)
    if pat.search(text):
        return pat.sub(lambda m: block, text, count=1)
    return fallback(text, block)


def outside_blocks(text, fn):
    """Apply fn to the parts of text that are not inside a <!-- site:… --> block."""
    parts = re.split(r"(<!-- site:(\w+) -->.*?<!-- /site:\2 -->)", text, flags=re.S)
    out = []
    i = 0
    while i < len(parts):
        out.append(fn(parts[i]))
        if i + 1 < len(parts):
            out.append(parts[i + 1])
        i += 3
    return "".join(out)


NAV_SCRIPT = re.compile(r"[ \t]*<script>\s*\(function\s*\(\)\s*\{(?:(?!</script>).)*?navToggle(?:(?!</script>).)*?</script>\n?", re.S)
MAIN_JS = re.compile(r'[ \t]*<script src="(?:\.\./)*assets/js/main\.js[^"]*"></script>\n?')
OLD_HEADERS = [
    re.compile(r'<header class="nav" id="nav">.*?</header>', re.S),
    re.compile(r'<header class="tut__top">.*?</header>', re.S),
]
FONT_LINK = re.compile(r'<link href="https://fonts\.googleapis\.com/css2\?[^"]*" rel="stylesheet"\s*/?>')


def legacy_links(text):
    def sub(m):
        anchor = m.group(3) or ""
        target = LEGACY_ANCHORS.get(anchor)
        return f'{m.group(1)}{target}"' if target else m.group(0)
    return re.sub(r'(href=")((?:\.\./)+)index\.html(?:#([\w-]+))?"', sub, text)


def inject(n):
    rel = out_file(n["path"])
    p = OUT / rel
    raw = read(p)
    crlf = is_crlf(raw)
    text = raw.replace("\r\n", "\n")
    app = n["kind"] == "app"
    path = n["path"]

    outside_head = re.sub(r"<!-- site:head -->.*?<!-- /site:head -->", "", text, flags=re.S)
    head_lines = ["<!-- site:head -->"]
    if 'location.protocol === "http:"' not in outside_head:
        head_lines.append(re.search(r"<script>.*?</script>", template("head.html"), re.S).group(0))
    if not FONT_LINK.search(outside_head):
        # the header's faces; the tutorials never loaded them
        head_lines += ['<link rel="preconnect" href="https://fonts.googleapis.com">',
                       '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>',
                       f'<link href="{esc(FONTS)}" rel="stylesheet">']
    head_lines += ['<link rel="icon" href="' + ICON + '">', '<link rel="stylesheet" href="/assets/css/site.css">',
                   "<!-- /site:head -->"]
    text = replace_block(text, "head", "\n".join(head_lines), lambda t, b: t.replace("</head>", b + "\n</head>", 1))

    def add_header(t, b):
        for pat in OLD_HEADERS:
            if pat.search(t):
                return pat.sub(lambda m: b, t, count=1)
        return re.sub(r"(<body[^>]*>\n?)", lambda m: m.group(1) + b + "\n", t, count=1)
    text = replace_block(text, "header", header_block(path, with_strip=not app), add_header)
    text = replace_block(text, "footer", footer_block(path, app=app),
                         lambda t, b: t[: t.rfind("</body>")].rstrip("\n") + "\n" + b + "\n" + t[t.rfind("</body>"):])

    shell = "app" if app else "sub"

    def body_attr(m):
        tag = re.sub(r'\sdata-shell="[^"]*"', "", m.group(0))
        return tag[:-1] + f' data-shell="{shell}">'
    text = re.sub(r"<body[^>]*>", body_attr, text, count=1)

    def clean(part):
        part = NAV_SCRIPT.sub("", part)
        part = MAIN_JS.sub("", part)
        part = FONT_LINK.sub(f'<link href="{esc(FONTS)}" rel="stylesheet">', part)
        return legacy_links(part)
    text = outside_blocks(text, clean)
    return rel, text, crlf


# ============================================================
# STAMPS
# ============================================================
ASSET_EXT = {"css", "js", "mjs", "png", "jpg", "jpeg", "gif", "svg", "webp", "avif", "ico", "mp4", "webm",
             "mov", "pdf", "pptx", "zip", "csv", "txt", "json", "woff", "woff2", "bin", "gz"}
ATTR = re.compile(r'(\s(?:src|href|poster)=)(["\'])([^"\']*)\2')


def is_local(url):
    return url and not re.match(r"^(?:[a-z][a-z0-9+.-]*:|//|#)", url, re.I) and not url.startswith("{{")


def stamp_url(url):
    if not is_local(url):
        return url
    base, hashpart = (url.split("#", 1) + [""])[:2]
    pathpart, _, query = base.partition("?")
    ext = pathpart.rsplit(".", 1)[-1].lower() if "." in pathpart.rsplit("/", 1)[-1] else ""
    if ext not in ASSET_EXT:
        return url
    q = [kv for kv in query.split("&") if kv and not kv.startswith("v=")]
    q.append("v=" + STAMP)
    return pathpart + "?" + "&".join(q) + ("#" + hashpart if hashpart else "")


def stamp_html(text):
    def sub(m):
        return m.group(1) + m.group(2) + stamp_url(m.group(3)) + m.group(2)
    out = ATTR.sub(sub, text)

    def srcset(m):
        items = [s.strip() for s in m.group(2).split(",")]
        new = []
        for it in items:
            bits = it.split()
            if bits:
                bits[0] = stamp_url(bits[0])
            new.append(" ".join(bits))
        return m.group(1) + ", ".join(new) + m.group(3)
    return re.sub(r'(\ssrcset=")([^"]*)(")', srcset, out)


def stamp_modules():
    changed = []
    for importer, imported in MODULE_EDGES:
        ip, tp = OUT / importer, OUT / imported
        if not ip.exists() or not tp.exists():
            continue
        digest = hashlib.sha1(tp.read_bytes()).hexdigest()[:8]
        src = ip.read_bytes()
        name = re.escape(Path(imported).name.encode())
        pat = re.compile(rb'(["\'])((?:\./|\.\./)[^"\']*?' + name + rb')(?:\?v=[0-9A-Za-z]+)?\1')
        new = pat.sub(lambda m: m.group(1) + m.group(2) + b"?v=" + digest.encode() + m.group(1), src)
        if new != src:
            ip.write_bytes(new)
            changed.append(f"{importer} -> {imported}?v={digest}")
    return changed


# ============================================================
# SITEMAP, ROBOTS
# ============================================================
def write_sitemap(pages):
    today = _dt.date.today().isoformat()
    urls = "".join(f"  <url><loc>{esc(ORIGIN + p)}</loc><lastmod>{today}</lastmod></url>\n" for p in pages)
    write(OUT / "sitemap.xml", '<?xml version="1.0" encoding="UTF-8"?>\n'
          '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' + urls + "</urlset>\n")
    write(OUT / "robots.txt", "User-agent: *\nAllow: /\nDisallow: /tools/\n\nSitemap: " + ORIGIN + "/sitemap.xml\n")


# ============================================================
# MOVED PAGES, KEPT FILES, TEXT COPIES
# ============================================================
def lf(b):
    """Bytes as git stores them: this repository has core.autocrlf, so a checkout may carry CRLF
    that the committed (and served) file does not."""
    return b.replace(b"\r\n", b"\n")


def redirect_page(target):
    """The two-line page left at a moved address. The script keeps the query and the fragment
    (?access_id= on the request page, #notice on the support page); the meta refresh is for a
    browser without scripts."""
    u, full = esc(target), esc(ORIGIN + target)
    return ('<!doctype html><html lang="en"><head><meta charset="utf-8">'
            '<meta name="viewport" content="width=device-width, initial-scale=1">'
            f"<script>location.replace({json.dumps(target)} + location.search + location.hash)</script>"
            f'<meta http-equiv="refresh" content="0; url={u}"><link rel="canonical" href="{full}">'
            "<title>Beethoven</title></head>\n"
            f'<body><p>This page has moved to <a href="{u}">{full}</a>.</p></body></html>\n')


def write_legacy():
    """Write every REDIRECTS page and every TEXT_COPIES file. KEPT_FILES are never written."""
    changed = []
    for rel, target in REDIRECTS.items():
        if write(OUT / rel, redirect_page(target)):
            changed.append(rel)
    for rel, key in TEXT_COPIES.items():
        src, dest = lf(TEXTS[key]["src"].read_bytes()), OUT / rel
        if not dest.exists() or lf(dest.read_bytes()) != src:
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_bytes(src)
            changed.append(rel)
    return changed


def check_legacy(problems):
    """Every moved page is the redirect this build writes and lands on a real page; every kept file
    has its pinned bytes; nothing else is under /ashley/; the plain-text copies match their sources."""
    for rel, target in REDIRECTS.items():
        p = OUT / rel
        if not p.exists():
            problems.append(f"{rel}: missing (the redirect to {target})")
            continue
        text = read(p).replace("\r\n", "\n")
        if text != redirect_page(target):
            problems.append(f"{rel}: not the redirect to {target} that this build writes (edited by hand?)")
        pg = parse(text)
        if pg.errors or pg.stack:
            problems.append(f"{rel}: tags do not balance: {pg.errors[:2]}")
        f, _ = resolve(rel, target)
        if not (OUT / f).exists():
            problems.append(f"{rel}: its target {target} ({f}) does not exist")
        elif f in LEGACY:
            problems.append(f"{rel}: its target {target} is itself a moved or kept file")
        if BANNED.search(text) or old_name_left(text):
            problems.append(f"{rel}: the banned word or the old product name is on the redirect page")
    for rel, digest in KEPT_FILES.items():
        p = OUT / rel
        if not p.exists():
            problems.append(f"{rel}: missing (installed builds read it by address)")
        elif hashlib.sha256(lf(p.read_bytes())).hexdigest() != digest:
            problems.append(f"{rel}: its bytes changed (installed builds read it by address, so it stays exactly as it "
                            f"was; SHA-256 pinned in KEPT_FILES)")
        elif BANNED.search(p.read_bytes().decode("utf-8", "replace")):
            problems.append(f"{rel}: the banned word is in a kept file")
    old = OUT / "ashley"
    for p in sorted(old.rglob("*")) if old.is_dir() else []:
        rel = p.relative_to(OUT).as_posix()
        if p.is_file() and rel not in LEGACY:
            problems.append(f"{rel}: under /ashley/ but in neither REDIRECTS nor KEPT_FILES")
    for rel, key in TEXT_COPIES.items():
        p = OUT / rel
        if not p.exists() or lf(p.read_bytes()) != lf(TEXTS[key]["src"].read_bytes()):
            problems.append(f"{rel}: not a byte-for-byte copy of {TEXTS[key]['src']}")
        elif old_name_left(read(p)):
            problems.append(f"{rel}: the old product name is in the text: {old_name_left(read(p))[:3]}")


def check_services(problems):
    """/beethoven/services.json carries every route both editions read, on the access service, and
    neither services file names the approved list."""
    for rel in ("beethoven/services.json", "ashley/services.json"):
        g = OUT / rel
        try:
            keys = json.loads(read(g)) if g.exists() else {}
        except ValueError:
            keys = {}
        for k in NO_SERVICES_KEYS:
            if k in keys:
                problems.append(f"{rel}: names '{k}', which is not published (since 2026-10-01 the access "
                                f"service gives no list of approved AccessIDs)")
    f = OUT / "beethoven/services.json"
    if not f.exists():
        problems.append("beethoven/services.json: missing (both editions fetch it)")
        return
    try:
        s = json.loads(read(f))
    except ValueError as e:
        problems.append(f"beethoven/services.json: not JSON ({e})")
        return
    for k in SERVICES_KEYS:
        v = s.get(k)
        if not isinstance(v, str) or not v.startswith("https://"):
            problems.append(f"beethoven/services.json: no https address for '{k}'")
        elif k.endswith("_page"):
            if not v.startswith(ORIGIN + "/beethoven/"):
                problems.append(f"beethoven/services.json: '{k}' is {v}, not a page under {ORIGIN}/beethoven/")
            elif not (OUT / urlparse(v).path.lstrip("/")).exists():
                problems.append(f"beethoven/services.json: '{k}' names {v}, which is not in the site")
        elif urlparse(v).hostname != SERVICE_HOST:
            problems.append(f"beethoven/services.json: '{k}' is {v}, not on {SERVICE_HOST}")


def check_private_listing(parsed, rendered, problems, notes):
    """The browser edition is offered only through its private Chrome listing: no package of it in the
    site, no link to one, and no other browser named in a page's text. /ashley/ is not checked (its
    kept files are the exact texts people accepted, pinned byte for byte). A page that carries a text
    from TEXTS is checked without that text, and the text at its source instead: the page renders it
    word for word, so a browser named there is changed in that repository's file; that is a note, and
    it stays on every run until the file changes."""
    if (OUT / OLD_DOWNLOADS).exists():
        problems.append(f"{OLD_DOWNLOADS}/: still in the site; the browser edition is offered only through its "
                        "private Chrome listing (delete the folder)")
    for top, dirs, files in os.walk(OUT):
        dirs[:] = [d for d in dirs if d not in (".git", "node_modules")]
        for f in files:
            if PACKAGE_FILE.match(f):
                rel = (Path(top) / f).relative_to(OUT).as_posix()
                if not rel.startswith(EXCLUDE_DIRS):
                    problems.append(f"{rel}: a package of the browser edition in the site (it is offered only "
                                    "through its private Chrome listing)")
    unstamp = lambda s: re.sub(r"\?v=\d{12}\b", "", s)  # noqa: E731 (the check-only run has another stamp)
    for rel, (text, pg) in parsed.items():
        for tag, attr, ref, line in pg.refs:
            if PACKAGE_LINK.search(ref):
                problems.append(f"{rel}:{line}: {attr}='{ref}' points at a package of the browser edition")
        page = unstamp(text)
        for key, t in TEXTS.items():
            if t["page"] == rel and key in rendered:
                for piece in rendered[key][1:]:
                    page = page.replace(unstamp(piece), "")
        body = text_of(page)
        named = list(OTHER_BROWSERS.finditer(body))
        if named:
            where =["'" + " ".join(body[max(0, m.start() - 40):m.end() + 40].split()) + "'" for m in named[:3]]
            problems.append(f"{rel}: names another browser ({', '.join(sorted({m.group(0) for m in named}))}); "
                            f"the browser edition is for Chrome only: {'; '.join(where)}")
    for key, t in TEXTS.items():
        src = t["src"]
        if not src.exists():
            continue
        lines = [i + 1 for i, line in enumerate(read(src).splitlines()) if OTHER_BROWSERS.search(line)]
        if lines:
            which = sorted(set(OTHER_BROWSERS.findall(read(src))))
            notes.append(f"{src}: names {', '.join(which)} on line(s) {', '.join(map(str, lines))}; {t['page']} "
                         "renders this text word for word, so the change belongs in that file")


# ============================================================
# CHECKS
# ============================================================
class Page(HTMLParser):
    VOID = {"area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"}
    OPTIONAL_END = {"p", "li", "dt", "dd", "tr", "td", "th", "thead", "tbody", "tfoot", "option", "colgroup"}

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.stack, self.errors, self.refs, self.ids = [], [], [], set()

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if "id" in a and a["id"]:
            self.ids.add(a["id"])
        for k in ("href", "src", "poster"):
            v = a.get(k)
            if v is None:
                continue
            if tag == "link" and not set((a.get("rel") or "").split()) & {"stylesheet", "icon", "preload", "modulepreload"}:
                continue  # canonical, preconnect: addresses, not things this page loads
            self.refs.append((tag, k, v, self.getpos()[0]))
        if a.get("srcset"):
            for it in a["srcset"].split(","):
                if it.strip():
                    self.refs.append((tag, "srcset", it.split()[0], self.getpos()[0]))
        if tag not in self.VOID:
            self.stack.append((tag, self.getpos()[0]))

    def handle_startendtag(self, tag, attrs):
        self.handle_starttag(tag, attrs)
        if tag not in self.VOID and self.stack and self.stack[-1][0] == tag:
            self.stack.pop()

    def handle_endtag(self, tag):
        if tag in self.VOID:
            return
        while self.stack and self.stack[-1][0] != tag and self.stack[-1][0] in self.OPTIONAL_END:
            self.stack.pop()
        if not self.stack or self.stack[-1][0] != tag:
            self.errors.append(f"</{tag}> at line {self.getpos()[0]} closes <{self.stack[-1][0] if self.stack else 'nothing'}>")
            return
        self.stack.pop()


def parse(text):
    p = Page()
    p.feed(text)
    p.close()
    while p.stack and p.stack[-1][0] in Page.OPTIONAL_END:
        p.stack.pop()
    return p


def all_pages():
    for p in sorted(OUT.rglob("*.html")):
        rel = p.relative_to(OUT).as_posix()
        if rel.startswith(EXCLUDE_DIRS) or rel in EXCLUDE_FILES or rel in LEGACY:
            continue
        yield rel


def url_of(rel):
    if rel == "index.html":
        return "/"
    if rel.endswith("/index.html"):
        return "/" + rel[: -len("index.html")]
    return "/" + rel


def resolve(page_rel, ref):
    """A local reference on a page -> (file relative to OUT, fragment)."""
    base = ORIGIN + url_of(page_rel)
    u = urlparse(urljoin(base, ref))
    path = unquote(u.path)
    f = path.lstrip("/")
    if f == "" or f.endswith("/"):
        f += "index.html"
    return f, u.fragment


def check_site(pages_written, problems, notes, external=False):
    canonical_header = re.sub(r' aria-current="(?:page|true)"', "", header("/"))
    canonical_footer = footer()
    parsed, ext_urls = {}, {}
    for rel in all_pages():
        text = read(OUT / rel).replace("\r\n", "\n")
        pg = parse(text)
        parsed[rel] = (text, pg)
        generated = rel in pages_written
        if pg.errors or pg.stack:
            msg = f"{rel}: tags do not balance: {(pg.errors + [f'<{t}> from line {l} never closed' for t, l in pg.stack])[:4]}"
            (problems if generated else notes).append(msg)
        # header identical except the mark
        hs = re.findall(r'<header class="nav" id="nav">.*?</header>', text, re.S)
        if len(hs) != 1:
            problems.append(f"{rel}: {len(hs)} site headers (want exactly 1)")
        elif re.sub(r' aria-current="(?:page|true)"', "", hs[0]) != canonical_header:
            problems.append(f"{rel}: the header differs from the site's header")
        n, _ = lookup(url_of(rel))
        app = bool(n and n["kind"] == "app")
        fs = re.findall(r'<footer class="footer">.*?</footer>', text, re.S)
        if not app:
            if len(fs) != 1:
                problems.append(f"{rel}: {len(fs)} site footers (want exactly 1)")
            elif fs[0] != canonical_footer:
                problems.append(f"{rel}: the footer differs from the site's footer")
            if n and n["path"] != "/" and "crumbs" not in text:
                problems.append(f"{rel}: no breadcrumb back to its parent")
        if BANNED.search(text):
            problems.append(f"{rel}: the banned word is on the page")
        left = old_name_left(text)
        if left:
            problems.append(f"{rel}: the old product name is on the page: {left[:3]}")
        # every local reference resolves; every local asset is stamped
        for tag, attr, ref, line in pg.refs:
            if not ref or ref.startswith(("mailto:", "tel:", "javascript:", "data:")):
                continue
            if ref.startswith(("http://", "https://", "//")):
                if tag == "a":
                    ext_urls.setdefault(ref if not ref.startswith("//") else "https:" + ref, set()).add(rel)
                continue
            if ref.startswith("#"):
                if ref[1:] and ref[1:] not in pg.ids:
                    (problems if generated else notes).append(f"{rel}:{line}: '{ref}' names no element on the page")
                continue
            if "{{" in ref or "${" in ref:
                continue
            f, frag = resolve(rel, ref)
            target = OUT / f
            if not target.exists():
                problems.append(f"{rel}:{line}: {attr}='{ref}' resolves to {f}, which does not exist")
                continue
            if f.rsplit(".", 1)[-1].lower() in ASSET_EXT and not re.search(r"[?&]v=", ref):
                problems.append(f"{rel}:{line}: {attr}='{ref}' is not stamped")
            if frag and f.endswith(".html") and f in parsed:
                if frag not in parsed[f][1].ids:
                    (problems if generated else notes).append(f"{rel}:{line}: '{ref}': {f} has no id '{frag}'")
    # anchors on pages parsed after the linking page
    for rel, (text, pg) in parsed.items():
        for tag, attr, ref, line in pg.refs:
            if tag == "a" and is_local(ref) and "#" in ref and not ref.startswith("#"):
                f, frag = resolve(rel, ref)
                if f.endswith(".html") and f in parsed and frag and frag not in parsed[f][1].ids:
                    msg = f"{rel}:{line}: '{ref}': {f} has no id '{frag}'"
                    bucket = problems if rel in pages_written else notes
                    if msg not in bucket:
                        bucket.append(msg)
    # reachability: from the header (tabs), then one more click; and with the footer counted
    def links_from(rel):
        if rel not in parsed:
            return set()
        out = set()
        for tag, attr, ref, _ in parsed[rel][1].refs:
            if tag == "a" and is_local(ref):
                f, _ = resolve(rel, ref)
                if f.endswith(".html"):
                    out.add(f)
        return out
    tabs = {out_file(t["path"]) for t in SITE} | {out_file(CTA["path"])}
    two = set(tabs)
    for t in tabs:
        two |= links_from(t)
    footer_links = {out_file(p) for p in re.findall(r'href="([^"]+)"', canonical_footer) if p.startswith("/")}
    two_f = set(tabs) | footer_links
    for t in set(two_f):
        two_f |= links_from(t)
    site_pages = [out_file(n["path"]) for n, _ in walk(SITE) if listed(n)]
    far = [p for p in site_pages if p not in two]
    far_f = [p for p in site_pages if p not in two_f]
    if far_f:
        problems.append(f"more than two clicks from the header and footer: {far_f}")
    if far:
        notes.append(f"{len(far)} page(s) are three clicks from the header alone (two through the footer): {far}")
    in_map = {out_file(n["path"]) for n, _ in walk(SITE) if exists(n)}
    for rel in parsed:
        if rel not in in_map:
            notes.append(f"{rel}: on disk but not in the site map (no navigation leads to it)")
    if external:
        check_external(ext_urls, problems, notes)
    return parsed


KNOWN_BLOCKED = {"claude.ai": "403 bot check (opens in a browser)", "zenodo.org": "403 bot check (opens in a browser)",
                 "www.cureus.com": "403 bot check (opens in a browser)", "cureus.com": "403 bot check (opens in a browser)",
                 "ondemand.grid.wayne.edu": "answers only on the Wayne State VPN",
                 "www.instagram.com": "login wall for scripts", "instagram.com": "login wall for scripts"}


def check_external(urls, problems, notes):
    def ask(url):
        headers = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129 Safari/537.36",
                   "Accept": "text/html,*/*"}
        for method in ("HEAD", "GET"):
            try:
                req = urllib.request.Request(url, method=method, headers=headers)
                with urllib.request.urlopen(req, timeout=20) as r:
                    return r.status, r.geturl()
            except urllib.error.HTTPError as e:
                if method == "HEAD" and e.code in (403, 404, 405, 429, 500, 501):
                    continue
                return e.code, (e.geturl() or url)
            except Exception as e:  # noqa: BLE001 - a network failure is a result here
                if method == "HEAD":
                    continue
                return 0, f"{type(e).__name__}: {e}"
        return 0, "no answer"
    with concurrent.futures.ThreadPoolExecutor(max_workers=12) as ex:
        results = dict(zip(urls, ex.map(ask, list(urls))))
    for url in sorted(urls):
        status, final = results[url]
        host = urlparse(url).hostname or ""
        known = next((why for h, why in KNOWN_BLOCKED.items() if host == h or host.endswith("." + h)), None)
        final_host = urlparse(final).hostname or "" if isinstance(final, str) and final.startswith("http") else ""
        known = known or next((why for h, why in KNOWN_BLOCKED.items() if final_host == h), None)
        line = f"external {status or 'no answer'}  {url}" + (f"  -> {final}" if final != url else "") + f"  (on {', '.join(sorted(urls[url])[:2])})"
        if 200 <= status < 400:
            notes.append(line)
        elif known:
            notes.append(line + f"  [expected: {known}]")
        else:
            problems.append(line)


# ============================================================
# MAIN
# ============================================================
def prepare_out(out, check_only):
    """--out: build into a copy of the site. The folder must be outside the site and new or empty
    (nothing is ever deleted); the site is copied there first, without .git."""
    global OUT
    out = Path(out).resolve()
    if out == ROOT or ROOT in out.parents:
        raise SystemExit(f"--out {out}: inside the site; give a folder outside it")
    if check_only:
        if not out.is_dir():
            raise SystemExit(f"--out {out}: not there to check")
    else:
        if out.exists() and any(out.iterdir()):
            raise SystemExit(f"--out {out}: not empty; give a new or empty folder")
        shutil.copytree(ROOT, out, ignore=shutil.ignore_patterns(".git", "node_modules"), dirs_exist_ok=True)
    OUT = out


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--check-only", action="store_true", help="write nothing; check the pages on disk")
    ap.add_argument("--external", action="store_true", help="also request every outside link and record its status")
    ap.add_argument("--quiet", action="store_true", help="print only problems and the summary")
    ap.add_argument("--out", metavar="DIR", help="copy the site into DIR (new or empty, outside the site) and build "
                    "and check there; with --check-only, check DIR as it is")
    a = ap.parse_args()
    if a.out:
        prepare_out(a.out, a.check_only)

    problems, notes, written = [], [], {}
    # the texts of both editions, rendered and checked word for word against their sources
    texts, rendered = load_texts(problems)
    pj = VSCODE_EXT / "package.json"
    texts["vscode_version"] = json.loads(read(pj))["version"]
    pj = BEETHOVEN_EXT / "package.json"
    if not pj.exists():
        raise SystemExit(f"{pj}: not there (set BEETHOVEN_REPO)")
    texts["version"] = json.loads(read(pj))["version"]

    # body files that no page claims
    claimed = {body_file(n["path"]) for n, _ in walk(SITE)}
    for b in PAGES.rglob("body.html"):
        if b not in claimed:
            problems.append(f"{b.relative_to(ROOT)}: no page in SITE uses this body file (add the page to SITE)")

    if not a.check_only:
        for c in stamp_modules():
            notes.append("module stamp: " + c)
        sitemap = []
        for n, parents in walk(SITE):
            if not exists(n):
                continue
            rel = out_file(n["path"])
            if n["kind"] == "page":
                src = body_file(n["path"])
                if not src.exists() and not (n.get("same_as") and body_file(n["same_as"]).exists()):
                    notes.append(f"{rel}: no body file ({src.relative_to(ROOT)}); the page on disk was left as it is")
                    if (OUT / rel).exists() and not n.get("hidden"):
                        sitemap.append(n["path"])
                    continue
                page, used = render_page(n, texts)
                page = stamp_html(page)
                changed = write(OUT / rel, page)
                written[rel] = used
                if n.get("hidden"):
                    if not a.quiet:
                        print(f"{'wrote' if changed else 'same '}  {rel}  (hidden; not in sitemap.xml)")
                    continue
                if f'<link rel="canonical" href="{esc(ORIGIN + n["path"])}">' not in page:
                    # a sitemap lists canonical addresses only: / declares /beethoven/ as its canonical
                    if not a.quiet:
                        print(f"{'wrote' if changed else 'same '}  {rel}  (canonical elsewhere; not in sitemap.xml)")
                    continue
            else:
                if not (OUT / rel).exists():
                    problems.append(f"{rel}: in the site map but not on disk")
                    continue
                rel, text, crlf = inject(n)
                text = stamp_html(text)
                changed = write(OUT / rel, text, crlf=crlf)
                written[rel] = None
            sitemap.append(n["path"])
            if not a.quiet:
                print(f"{'wrote' if changed else 'same '}  {rel}")
        write_sitemap(sitemap)
        for rel in write_legacy():
            if not a.quiet:
                print(f"wrote  {rel}  (moved page or text copy)")
    else:
        written = {out_file(n["path"]): None for n, _ in walk(SITE) if n["kind"] == "page" and body_file(n["path"]).exists()}

    # the legal pages carry their texts exactly, and the pages the extensions open keep their promises
    for key, t in TEXTS.items():
        rel = t["page"]
        p = OUT / rel
        if not p.exists():
            problems.append(f"{rel}: missing (it carries {t['src'].name})")
            continue
        if rel in written:
            page = read(p).replace("\r\n", "\n")
            _, title, body = rendered[key]
            for piece in (title, body):
                if stamp_html(piece) not in page:
                    problems.append(f"{rel}: the rendered text of {t['src']} is not on the page intact")
                    break
    req = OUT / "beethoven/request.html"
    if req.exists():
        r = read(req)
        for must in ("fetch('services.json'", "get('access_id')", "product: 'bridge'"):
            if must not in r:
                problems.append(f"beethoven/request.html: '{must}' is gone (the extension and the service rely on it)")
    sup = OUT / "beethoven/support.html"
    if sup.exists() and NOTICE not in read(sup):
        problems.append("beethoven/support.html: the notice address is not there word for word")
    adm = OUT / "beethoven/admin.html"
    if adm.exists():
        r = read(adm)
        for must in ("fetch('services.json'", '<meta name="robots" content="noindex">'):
            if must not in r:
                problems.append(f"beethoven/admin.html: '{must}' is gone (it finds the access service through services.json and stays out of search)")
    if not (OUT / "beethoven/killlist.json").exists():
        problems.append("beethoven/killlist.json: missing (the extension fetches it)")
    check_services(problems)
    check_legacy(problems)

    parsed = check_site(written, problems, notes, external=a.external)
    check_private_listing(parsed, rendered, problems, notes)

    for n_ in notes:
        if a.quiet and n_.startswith(("external 2", "external 3", "module stamp")):
            continue
        print("note:", n_)
    for p in problems:
        print("FAIL:", p)
    if a.check_only:
        found = sorted(set(re.findall(r"\?v=(\d{12})\b", "".join(read(OUT / r) for r in parsed))))
        did = f"nothing written, stamp on disk ?v={', '.join(found) or 'none'}"
    else:
        did = f"{len(written)} built or injected, stamp ?v={STAMP}"
    where = "" if OUT == ROOT else f" in {OUT}"
    vs = ", ".join(f"{k} v{t['version']} ({t['date']})" for k, t in TEXTS.items() if "version" in t)
    print(f"\n{len(parsed)} pages checked{where}, {did}; {len(REDIRECTS)} moved pages, {len(KEPT_FILES)} kept files; "
          f"texts: {vs}; Beethoven for VS Code {texts['vscode_version']} from {VSCODE_REPO.name}, "
          f"Beethoven {texts['version']} from {BEETHOVEN_REPO.name} (private Chrome listing; no package here); "
          f"{len(problems)} problem(s), {len(notes)} note(s)")
    sys.exit(1 if problems else 0)


if __name__ == "__main__":
    main()
