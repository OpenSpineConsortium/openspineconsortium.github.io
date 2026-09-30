"""tools/build_site.py: write every page of openspineconsortium.com from one site map.

    python -X utf8 tools/build_site.py              # build, stamp, check
    python -X utf8 tools/build_site.py --external   # also ask every outside link for a status
    python -X utf8 tools/build_site.py --check-only # write nothing; check what is on disk

WHAT IT DOES, IN ORDER

 1. Reads SITE below: every page, its label, its address and its children. The header, the
    section strip, the breadcrumb and the footer of every page are made from this one map, so no
    page can disagree with another about where anything is.
 2. Writes each generated page from its body file, tools/pages/<output file minus .html>/body.html
    (front matter + the HTML inside <main>; README.md has the convention), wrapped in
    tools/templates/page.html. Directives in a body file are filled in here:
        <!-- build:license-title -->  <!-- build:license-toc -->  <!-- build:license-text -->
        <!-- build:privacy-title -->  <!-- build:privacy-text -->
        <!-- build:request-form services=<url> [fine=short] -->   the access form and its script
        <!-- build:browsers -->                      the four browser cards
        <!-- build:section-index -->                 on a tab's landing page, the pages one level
                                                     below its children (tutorials, Spine MRI parts)
        {{version}} {{license_version}} {{privacy_version}}
    The agreement and the privacy statement are rendered from the Beethoven repository's own texts
    (LICENSE.txt, PRIVACY.md) on every run, and checked word for word against them.
 3. Gives the pages that are not generated (the atlas, the Spine MRI series, the tutorials,
    Celebrate Life, the PACS demo) the same header and footer, between <!-- site:... --> markers,
    so a second run replaces rather than adds. Their content is not touched; only the old header,
    the old inline menu script and links to the retired one-page anchors are replaced.
 4. Copies the Beethoven packages for direct download into beethoven/downloads/ when the release
    folder is there.
 5. Stamps every local stylesheet, script, image, video and document reference in every page
    with ?v=<yyyymmddHHMM> (UTC), and keeps content hashes on ES-module import edges, because a new
    stamp on gallery.js does not make a browser refetch the ./viewer.js it imports.
 6. Writes sitemap.xml (canonical addresses only, so / is left to /beethoven/) and robots.txt.
 7. Checks: every page parses and its tags balance; the header is byte-identical on every page
    except the mark on the current tab; the footer is identical everywhere; every internal link and
    asset resolves to a file; every page is reachable; the banned word and the old product name are
    absent. A failed check exits non-zero and says which page and why.

WHAT IT NEVER TOUCHES: /ashley/ (legacy copies and redirects for old extension builds),
/beethoven/services.json and /beethoven/killlist.json, the Google verification file, pacs/xr.html
(a redirect), and the untracked folders under pacs/. It stages and commits nothing.

This replaces the Beethoven repository's tools/site_beethoven_build.py for pages: that script is
retired and must not be run against this site again (it would overwrite the themed pages).
"""
from __future__ import annotations

import argparse
import concurrent.futures
import datetime as _dt
import hashlib
import html
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

# The Beethoven repository, relative to this site repository (override with BEETHOVEN_REPO)
BEETHOVEN_REPO = Path(os.environ.get("BEETHOVEN_REPO", ROOT.parent / "ashley-bridge"))
LICENSE_TXT = BEETHOVEN_REPO / "LICENSE.txt"
PRIVACY_MD = BEETHOVEN_REPO / "PRIVACY.md"
BEETHOVEN_VERSION = "7.0.0"
RELEASE_DIR = BEETHOVEN_REPO / "release" / BEETHOVEN_VERSION
DOWNLOADS = "/beethoven/downloads/"
# A store listing's address once the store has approved it; None shows "Direct download".
BROWSERS = [
    {"key": "chrome", "name": "Chrome", "store": "Chrome Web Store", "store_url": None},
    {"key": "edge", "name": "Edge", "store": "Edge Add-ons", "store_url": None},
    {"key": "firefox", "name": "Firefox", "store": "Firefox Add-ons", "store_url": None},
    {"key": "safari", "name": "Safari", "store": None, "store_url": None},
]
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

# Nothing under these is templated, stamped or checked.
EXCLUDE_DIRS = ("ashley/", "tools/", "pacs/sllp/", "pacs/testimgs/", "pacs/webtest/", "node_modules/", ".git/")
EXCLUDE_FILES = ("googlec3911e7fb095977e.html", "pacs/xr.html")

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


# ============================================================
# THE SITE MAP
# kind: page (generated from tools/pages), sub (a page of its own; gets the shell injected),
#       app (full-screen; gets the header only)
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
        return body_file(n["path"]).exists() or (ROOT / out_file(n["path"])).exists()
    return True


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
    kids = [c for c in tab["children"] if exists(c)]
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
            if not exists(c):
                continue
            items.append((c["label"], c["path"]))
            for g in c["children"]:
                if g.get("in_footer"):
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
            for proper in ("Beethoven", "Michigan", "Anthropic", "Claude", "Licensor"):
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


def privacy_parts(md_path):
    r = subprocess.run([PANDOC, str(md_path), "-f", "markdown+pipe_tables", "-t", "html5", "--wrap=none"],
                       check=True, capture_output=True)
    frag = r.stdout.decode("utf-8").replace("\r\n", "\n").strip()
    # a wide table scrolls inside its own box, never the page
    frag = re.sub(r"<table>", '<div class="table-scroll"><table>', frag)
    frag = frag.replace("</table>", "</table></div>")
    m = re.match(r"(<h1[^>]*>.*?</h1>)\s*(.*)", frag, re.S)
    if not m:
        raise SystemExit("PRIVACY.md: pandoc output does not start with a heading")
    return m.group(1), m.group(2)


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
FRONT_KEYS = {"title", "description", "css", "js", "canonical", "body_class", "strip", "breadcrumb"}


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
    cards = []
    card = template("browser-card.html")
    for b in BROWSERS:
        pkg = f"{DOWNLOADS}beethoven-{BEETHOVEN_VERSION}-{b['key']}.zip"
        if b["store_url"]:
            href, button, dl = b["store_url"], f"Get it on {b['store']}", ""
            note = f"Version {BEETHOVEN_VERSION}."
        else:
            href, button, dl = pkg, "Direct download", " download"
            # short, because the home page carries these cards and stays under 120 words
            if b["key"] == "safari":
                note = "For Apple's converter, not a direct install."
            else:
                note = "Listing pending review"
        cards.append(fill(card, {"key": b["key"], "name": esc(b["name"]), "href": href, "button": esc(button),
                                 "download": dl, "note": esc(note)}, "browser-card.html"))
    return '<div class="browsers">\n' + "\n".join(cards) + "\n</div>"


# The home page's copy of the form is the short one: same fields, same script, no hints under the
# fields (the placeholders and the script's own messages carry them) and one line of fine print that
# links the privacy statement (its "Access requests" paragraph); request.html keeps the full
# "What this page sends" text. The home page stays under
# 120 words that way, the form's labels and button aside.
SHORT_FINEPRINT = ('<p class="fineprint">Sent only to the lab\'s own access service. '
                   '<a href="/beethoven/privacy.html">Privacy</a></p>')


def request_form(services, fine):
    out = fill(template("request-form.html"), {"services": services}, "request-form.html")
    if fine == "short":
        out, n_hints = re.subn(r"\n  <small>.*?</small>", "", out)
        out, n_fine = re.subn(r'<p class="fineprint">.*?</p>', lambda m: SHORT_FINEPRINT, out, flags=re.S)
        if n_hints != 3 or n_fine != 1:
            raise SystemExit("request-form.html: the short form expects three <small> hints and one fine-print "
                             f"paragraph, found {n_hints} and {n_fine}")
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
        kids = []
        for g, _ in walk(c["children"]):
            if exists(g):
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
    if "<!-- build:section-index -->" in body:
        body = body.replace("<!-- build:section-index -->", section_index(path) if path else "")
    for key in ("license-title", "license-toc", "license-text", "privacy-title", "privacy-text"):
        body = body.replace(f"<!-- build:{key} -->", texts[key])
    left = re.findall(r"<!--\s*build:[^>]*-->", body)
    if left:
        raise SystemExit(f"{where}: unknown directive(s) {left}")
    return fill(body, {"version": BEETHOVEN_VERSION, "license_version": texts["license_version"],
                       "privacy_version": texts["privacy_version"]}, where) if "{{" in body else body


def render_page(n, texts):
    path = n["path"]
    src = body_file(path)
    if not src.exists() and n.get("same_as"):
        src = body_file(n["same_as"])
    meta, body = parse_body(src)
    body = expand(body, texts, str(src.relative_to(ROOT)), path)
    css = "".join(f'\n<link rel="stylesheet" href="{c.strip()}">' for c in meta.get("css", "").split(",") if c.strip())
    head = fill(template("head.html"), {
        "title": esc(meta["title"]), "description": esc(meta["description"]),
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
    p = ROOT / rel
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
        ip, tp = ROOT / importer, ROOT / imported
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
# DOWNLOADS, SITEMAP, ROBOTS
# ============================================================
def copy_packages(notes):
    dest = ROOT / DOWNLOADS.strip("/")
    names = [f"beethoven-{BEETHOVEN_VERSION}-{b['key']}.zip" for b in BROWSERS]
    if not RELEASE_DIR.is_dir():
        missing = [n for n in names if not (dest / n).exists()]
        if missing:
            notes.append(f"{RELEASE_DIR} is not there and {', '.join(missing)} are not in {DOWNLOADS}: the direct-download buttons will 404 until they are copied")
        return
    sums = {}
    for line in read(RELEASE_DIR / "SHA256SUMS.txt").splitlines() if (RELEASE_DIR / "SHA256SUMS.txt").exists() else []:
        bits = line.split()
        if len(bits) == 2:
            sums[bits[1].lstrip("*")] = bits[0]
    dest.mkdir(parents=True, exist_ok=True)
    lines = []
    for name in names:
        src = RELEASE_DIR / name
        if not src.exists():
            notes.append(f"{src} is missing: its download button will 404")
            continue
        digest = hashlib.sha256(src.read_bytes()).hexdigest()
        if name in sums and sums[name] != digest:
            raise SystemExit(f"{src}: SHA-256 {digest} does not match the release's SHA256SUMS.txt ({sums[name]})")
        if not (dest / name).exists() or (dest / name).read_bytes() != src.read_bytes():
            shutil.copyfile(src, dest / name)
        lines.append(f"{digest} *{name}")
    write(dest / "SHA256SUMS.txt", "\n".join(lines) + "\n")


def write_sitemap(pages):
    today = _dt.date.today().isoformat()
    urls = "".join(f"  <url><loc>{esc(ORIGIN + p)}</loc><lastmod>{today}</lastmod></url>\n" for p in pages)
    write(ROOT / "sitemap.xml", '<?xml version="1.0" encoding="UTF-8"?>\n'
          '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' + urls + "</urlset>\n")
    write(ROOT / "robots.txt", "User-agent: *\nAllow: /\nDisallow: /tools/\n\nSitemap: " + ORIGIN + "/sitemap.xml\n")


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
    for p in sorted(ROOT.rglob("*.html")):
        rel = p.relative_to(ROOT).as_posix()
        if rel.startswith(EXCLUDE_DIRS) or rel in EXCLUDE_FILES:
            continue
        yield rel


def url_of(rel):
    if rel == "index.html":
        return "/"
    if rel.endswith("/index.html"):
        return "/" + rel[: -len("index.html")]
    return "/" + rel


def resolve(page_rel, ref):
    """A local reference on a page -> (file relative to ROOT, fragment)."""
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
        text = read(ROOT / rel).replace("\r\n", "\n")
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
        stripped = PERSON.sub("", text)
        if OLD_NAME.search(stripped):
            ctx = sorted(set(m.group(0) for m in re.finditer(r".{0,30}ashley.{0,30}", stripped, re.I)))[:3]
            problems.append(f"{rel}: the old product name is on the page: {ctx}")
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
            target = ROOT / f
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
    site_pages = [out_file(n["path"]) for n, _ in walk(SITE) if exists(n)]
    far = [p for p in site_pages if p not in two]
    far_f = [p for p in site_pages if p not in two_f]
    if far_f:
        problems.append(f"more than two clicks from the header and footer: {far_f}")
    if far:
        notes.append(f"{len(far)} page(s) are three clicks from the header alone (two through the footer): {far}")
    for rel in parsed:
        if rel not in site_pages:
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
def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--check-only", action="store_true", help="write nothing; check the pages on disk")
    ap.add_argument("--external", action="store_true", help="also request every outside link and record its status")
    ap.add_argument("--quiet", action="store_true", help="print only problems and the summary")
    a = ap.parse_args()

    problems, notes, written = [], [], {}
    # the Beethoven texts
    license_txt, privacy_md = read(LICENSE_TXT), read(PRIVACY_MD)
    for name, text in (("LICENSE.txt", license_txt), ("PRIVACY.md", privacy_md)):
        if BANNED.search(text):
            raise SystemExit(f"{name}: the banned word is in the source text")
        if OLD_NAME.search(text):
            raise SystemExit(f"{name}: the source text carries the old product name")
    lv, ld = version_of(license_txt, "LICENSE.txt")
    pv, pd = version_of(privacy_md, "PRIVACY.md")
    lt, ltoc, ltext = license_parts(license_txt)
    pt, ptext = privacy_parts(PRIVACY_MD)
    texts = {"license-title": lt, "license-toc": ltoc, "license-text": ltext, "privacy-title": pt,
             "privacy-text": ptext, "license_version": lv, "privacy_version": pv}
    check_words("LICENSE.txt", license_txt, lt + "\n" + ltext, problems)
    privacy_plain = re.sub(r"`", "", privacy_md)
    check_words("PRIVACY.md", privacy_plain, pt + "\n" + ptext, problems)

    # body files that no page claims
    claimed = {body_file(n["path"]) for n, _ in walk(SITE)}
    for b in PAGES.rglob("body.html"):
        if b not in claimed:
            problems.append(f"{b.relative_to(ROOT)}: no page in SITE uses this body file (add the page to SITE)")

    if not a.check_only:
        for c in stamp_modules():
            notes.append("module stamp: " + c)
        copy_packages(notes)
        sitemap = []
        for n, parents in walk(SITE):
            if not exists(n):
                continue
            rel = out_file(n["path"])
            if n["kind"] == "page":
                src = body_file(n["path"])
                if not src.exists() and not (n.get("same_as") and body_file(n["same_as"]).exists()):
                    notes.append(f"{rel}: no body file ({src.relative_to(ROOT)}); the page on disk was left as it is")
                    if (ROOT / rel).exists():
                        sitemap.append(n["path"])
                    continue
                page, used = render_page(n, texts)
                page = stamp_html(page)
                changed = write(ROOT / rel, page)
                written[rel] = used
                if f'<link rel="canonical" href="{esc(ORIGIN + n["path"])}">' not in page:
                    # a sitemap lists canonical addresses only: / declares /beethoven/ as its canonical
                    if not a.quiet:
                        print(f"{'wrote' if changed else 'same '}  {rel}  (canonical elsewhere; not in sitemap.xml)")
                    continue
            else:
                if not (ROOT / rel).exists():
                    problems.append(f"{rel}: in the site map but not on disk")
                    continue
                rel, text, crlf = inject(n)
                text = stamp_html(text)
                changed = write(ROOT / rel, text, crlf=crlf)
                written[rel] = None
            sitemap.append(n["path"])
            if not a.quiet:
                print(f"{'wrote' if changed else 'same '}  {rel}")
        write_sitemap(sitemap)
    else:
        written = {out_file(n["path"]): None for n, _ in walk(SITE) if n["kind"] == "page" and body_file(n["path"]).exists()}

    # the legal pages carry their texts exactly, and the pages the extension opens keep their promises
    for rel, pieces in (("beethoven/terms.html", (lt, ltext)), ("beethoven/privacy.html", (pt, ptext))):
        p = ROOT / rel
        if p.exists() and rel in written:
            page = read(p).replace("\r\n", "\n")
            for piece in pieces:
                if stamp_html(piece) not in page:
                    problems.append(f"{rel}: the rendered text of its source is not on the page intact")
    req = ROOT / "beethoven/request.html"
    if req.exists():
        r = read(req)
        for must in ("fetch('services.json'", "get('access_id')", "product: 'bridge'"):
            if must not in r:
                problems.append(f"beethoven/request.html: '{must}' is gone (the extension and the service rely on it)")
    sup = ROOT / "beethoven/support.html"
    if sup.exists() and NOTICE not in read(sup):
        problems.append("beethoven/support.html: the notice address is not there word for word")
    for f in ("beethoven/services.json", "beethoven/killlist.json"):
        if not (ROOT / f).exists():
            problems.append(f"{f}: missing (the extension fetches it)")

    parsed = check_site(written, problems, notes, external=a.external)

    for n_ in notes:
        if a.quiet and n_.startswith(("external 2", "external 3", "module stamp")):
            continue
        print("note:", n_)
    for p in problems:
        print("FAIL:", p)
    if a.check_only:
        found = sorted(set(re.findall(r"\?v=(\d{12})\b", "".join(read(ROOT / r) for r in parsed))))
        did = f"nothing written, stamp on disk ?v={', '.join(found) or 'none'}"
    else:
        did = f"{len(written)} built or injected, stamp ?v={STAMP}"
    print(f"\n{len(parsed)} pages checked, {did}; "
          f"agreement version {lv} ({ld}), privacy statement version {pv} ({pd}); "
          f"{len(problems)} problem(s), {len(notes)} note(s)")
    sys.exit(1 if problems else 0)


if __name__ == "__main__":
    main()
