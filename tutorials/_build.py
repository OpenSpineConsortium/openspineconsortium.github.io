#!/usr/bin/env python3
"""Render the workshop tutorial .md files to styled static HTML via pandoc.

The .md files are the single source of truth; this regenerates the .html pages
(sidebar nav, prev/next, site styling). Run from this folder after editing any
tutorial:

    python _build.py
"""
import re
import subprocess
from pathlib import Path

HERE = Path(__file__).resolve().parent

# slug (no extension) -> short sidebar title, in order
TUTS = [
    ("01_environment_setup",          "Environment setup"),
    ("02_dicom_vs_nifti",             "DICOM vs. NIfTI"),
    ("03_inference_pretrained_nnunet", "Inference (pretrained nnU-Net)"),
    ("04_itksnap_ai_annotation",      "AI annotation (ITK-SNAP)"),
    ("05_training_on_the_grid",       "Training on the WSU grid"),
    ("06_writing_an_ai_paper",        "Writing an AI paper"),
]

TEMPLATE = """<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{title} &middot; OpenSpineConsortium Workshop</title>
<link rel="stylesheet" href="../assets/css/style.css">
<link rel="stylesheet" href="tutorial.css">
</head>
<body class="tut">
<header class="tut__top">
  <a href="../index.html#workshop">&larr; OpenSpineConsortium &middot; AI Imaging Workshop</a>
</header>
<div class="tut__layout">
  <nav class="tut__nav">{nav}</nav>
  <main class="tut__content">
{body}
{pager}
  </main>
</div>
</body>
</html>
"""


def md_to_html(md_path: Path) -> str:
    out = subprocess.run(
        ["pandoc", str(md_path), "-f", "gfm", "-t", "html", "--no-highlight"],
        capture_output=True, text=True, check=True)
    body = out.stdout
    body = re.sub(r'href="([0-9A-Za-z_]+)\.md"', r'href="\1.html"', body)  # md -> html
    body = body.replace('href="README.html"', 'href="index.html"')
    return body


def nav_html(current_slug: str) -> str:
    items = []
    for i, (slug, title) in enumerate(TUTS, 1):
        cls = ' class="is-current"' if slug == current_slug else ''
        items.append(f'<li><a href="{slug}.html"{cls}>{i}.&nbsp; {title}</a></li>')
    return '<p class="tut__navhead">Tutorials</p>\n<ol>' + "".join(items) + '</ol>'


def pager_html(idx: int) -> str:
    if idx > 0:
        s, t = TUTS[idx - 1]
        prev = f'<a href="{s}.html">&larr;&nbsp; {t}</a>'
    else:
        prev = '<span class="is-disabled"></span>'
    if idx < len(TUTS) - 1:
        s, t = TUTS[idx + 1]
        nxt = f'<a href="{s}.html">{t} &nbsp;&rarr;</a>'
    else:
        nxt = '<span class="is-disabled"></span>'
    return f'<div class="tut__pager">{prev}{nxt}</div>'


def main() -> None:
    for idx, (slug, title) in enumerate(TUTS):
        body = md_to_html(HERE / f"{slug}.md")
        page = TEMPLATE.format(title=title, nav=nav_html(slug),
                               body=body, pager=pager_html(idx))
        (HERE / f"{slug}.html").write_text(page, encoding="utf-8")
        print("wrote", slug + ".html")
    # landing page from README.md
    body = md_to_html(HERE / "README.md")
    page = TEMPLATE.format(title="Workshop Tutorials", nav=nav_html(""),
                           body=body, pager="")
    (HERE / "index.html").write_text(page, encoding="utf-8")
    print("wrote index.html")


if __name__ == "__main__":
    main()
