"""tools/stamp_assets.py — put a content hash on every asset URL, including module imports.

WHY THIS IS A SCRIPT AND NOT A HABIT. Doing it by hand failed twice in one session: once
by bumping the hashes and forgetting to commit the files they described, and once by
missing an asset that has no URL in any HTML file at all.

THE ASSET WITH NO URL IN THE HTML. gallery.js imports viewer.js as a bare relative path.
Bumping `gallery.js?v=` makes the browser refetch gallery.js, but `./viewer.js` resolves
to the same URL every time, so a phone that cached the old module keeps serving it and
the page looks unchanged no matter how many times you deploy. A module graph needs
stamping at every edge, not only at the entry point.

ORDER MATTERS AND IS EASY TO GET WRONG. Stamping viewer's hash INTO gallery.js changes
gallery.js, so gallery's own hash has to be computed afterwards. Leaves first, then the
files that import them, then the HTML.

    python tools/stamp_assets.py            # stamp and report
    python tools/stamp_assets.py --check    # fail if anything is unstamped (for CI)
"""
from __future__ import annotations

import argparse
import hashlib
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# (importer, imported) — the importer's source is rewritten to carry the imported
# file's hash. Ordered leaves-first: anything appearing as an importer must not appear
# as an imported file later in the list.
MODULE_EDGES = [
    ("assets/js/viewer.js", "assets/js/vendor/three.module.js"),
    ("assets/js/viewer.js", "assets/js/vendor/OrbitControls.js"),
    ("assets/js/gallery.js", "assets/js/viewer.js"),
]

# (html file, asset) — every <script src> and <link href> that should carry a hash
HTML_REFS = [
    ("index.html", "assets/js/gallery.js"),
    ("index.html", "assets/css/gallery.css"),
    ("index.html", "assets/js/deck.js"),
    ("index.html", "assets/css/deck.css"),
    ("spine-mri/index.html", "assets/js/deck.js"),
    ("spine-mri/index.html", "assets/css/deck.css"),
]


def h(path: Path) -> str:
    return hashlib.sha1(path.read_bytes()).hexdigest()[:8]


def stamp_import(importer: Path, target_rel: str, digest: str) -> bool:
    """Rewrite `from "<...>/name.ext"` to carry ?v=<digest>. Returns True if changed."""
    src = importer.read_text(encoding="utf-8")
    name = Path(target_rel).name
    # match the specifier however it is spelled relatively, with or without an existing ?v=
    pat = re.compile(r'(["\'])((?:\./|\.\./)[^"\']*?' + re.escape(name) + r')(?:\?v=[0-9a-f]+)?\1')
    new, n = pat.subn(lambda m: f'{m.group(1)}{m.group(2)}?v={digest}{m.group(1)}', src)
    if n and new != src:
        importer.write_text(new, encoding="utf-8")
        return True
    return False


def stamp_html(html: Path, asset_rel: str, digest: str) -> bool:
    src = html.read_text(encoding="utf-8")
    name = Path(asset_rel).name
    pat = re.compile(r'((?:src|href)=")([^"]*?' + re.escape(name) + r')(?:\?v=[0-9a-f]+)?(")')
    new, n = pat.subn(lambda m: f'{m.group(1)}{m.group(2)}?v={digest}{m.group(3)}', src)
    if n and new != src:
        html.write_text(new, encoding="utf-8")
        return True
    return False


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true",
                    help="do not write; exit 2 if any stamp is out of date")
    a = ap.parse_args()

    changed: list[str] = []
    missing: list[str] = []

    # 1. module graph, leaves first
    for importer_rel, target_rel in MODULE_EDGES:
        importer, target = ROOT / importer_rel, ROOT / target_rel
        if not importer.exists() or not target.exists():
            missing.append(f"{importer_rel} -> {target_rel}")
            continue
        d = h(target)
        before = importer.read_text(encoding="utf-8")
        if a.check:
            if f"?v={d}" not in before:
                changed.append(f"{importer_rel} imports stale {target_rel}")
            continue
        if stamp_import(importer, target_rel, d):
            changed.append(f"{importer_rel} -> {Path(target_rel).name}?v={d}")

    # 2. HTML references, after the module graph has settled
    for html_rel, asset_rel in HTML_REFS:
        html, asset = ROOT / html_rel, ROOT / asset_rel
        if not html.exists() or not asset.exists():
            missing.append(f"{html_rel} -> {asset_rel}")
            continue
        d = h(asset)
        if a.check:
            if f"{Path(asset_rel).name}?v={d}" not in html.read_text(encoding="utf-8"):
                changed.append(f"{html_rel} references stale {asset_rel}")
            continue
        if stamp_html(html, asset_rel, d):
            changed.append(f"{html_rel} -> {Path(asset_rel).name}?v={d}")

    for m in missing:
        print(f"  ! missing: {m}")
    if a.check:
        if changed:
            print("STALE:")
            for c in changed:
                print(f"  {c}")
            return 2
        print("  all asset stamps current")
        return 0
    for c in changed:
        print(f"  {c}")
    print(f"\n  {len(changed)} stamp(s) updated")
    return 1 if missing else 0


if __name__ == "__main__":
    sys.exit(main())
