"""The control panel's Pipelines tab (initPipelinesTab in assets/js/symphony-panel.js), run in a browser.

Playwright drives the preinstalled Chromium against the built page, served from this folder on
127.0.0.1, signed in with a token put in sessionStorage, with api.github.com stood in for by a small
fixture: a repository whose branch cards holds an index, two cards and a card page, a repository the
person may not push to, and one with no branch cards. The card page is a stand-in for Metaflow's: it
draws the data put where its marker stood and tries every way out of its frame, reporting what it
reached. Where Playwright or its browser is absent, as on the site's CI, every test skips and says so.

Run: PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers python3 -m unittest tests.test_pipelines_browser
"""

import base64
import functools
import http.server
import json
import re
import threading
import unittest
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlsplit

ROOT = Path(__file__).resolve().parent.parent

try:
    from playwright.sync_api import Error as PlaywrightError, sync_playwright
except ImportError:  # the site's CI has no Playwright: the tests below skip
    sync_playwright = None
    PlaywrightError = Exception

REPO = "acme/pipes"
READ_ONLY = "acme/readonly"
NO_CARDS = "acme/nocards"
GRID_HOME = "OpenSpineConsortium/symphony-template"
TOKEN = "github_pat_TEST_NOT_A_REAL_TOKEN"
TEMPLATE_SHA = "d" * 40
WORD = "lab-cards-demo"

# A card page as Metaflow's is made: its data is one base64 line where the marker stands, read with
# atob; it draws each component as a line, then tries to reach the panel, its storage, the network
# and a new window, and posts what it reached to its parent, the one way out a sealed frame keeps.
TEMPLATE = """<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>DemoFlow/17/train/3</title></head>
<body><div id="out"></div>
<script>window.__MF_DATA__ = {}; window.__MF_DATA__["c1"] = "__MF_PAYLOAD__";</script>
<script>
(function () {
  var data = JSON.parse(atob(window.__MF_DATA__["c1"]));
  var out = document.getElementById('out');
  (function walk(list) {
    list.forEach(function (c) {
      if (c.type === 'page' || c.type === 'section') return walk(c.contents || []);
      var p = document.createElement('p');
      p.className = 'c';
      p.textContent = c.type + ':' + c.text;
      out.appendChild(p);
    });
  })(data.components);
  var reached = { evalRan: false };
  try { reached.evalRan = eval('1 + 1') === 2; } catch (e) { reached.evalRan = false; }
  try { reached.parent = !!window.parent.document.body; } catch (e) { reached.parent = false; }
  try { localStorage.setItem('k', 'v'); reached.storage = true; } catch (e) { reached.storage = false; }
  try { reached.popup = !!window.open('https://example.com/'); } catch (e) { reached.popup = false; }
  fetch('https://api.github.com/leak').then(function () { return true; }, function () { return false; }).then(function (ok) {
    reached.fetch = ok;
    reached.drawn = out.textContent;
    window.parent.postMessage({ cardProbe: reached }, '*');
  });
})();
</script>
</body></html>
"""

INDEX = {
    "kind": "demo", "flow": "DemoFlow", "refresh": WORD,
    "runs": [{"run": "17", "updated": "2026-10-31T05:00:00Z", "cards": [
        {"step": "start", "task": "1", "name": "blank", "file": "demo/17/start-1-blank.json", "live": False},
        {"step": "train", "task": "3", "name": "blank", "file": "demo/17/train-3-blank.json", "live": True},
        {"step": "train", "task": "4", "name": "blank", "withheld": "its data names a header element"},
        # an index never names a file outside its own kind and run, nor a name that climbs out
        {"step": "train", "task": "5", "name": "blank", "file": "other/17/train-5-blank.json", "live": False},
        {"step": "..", "task": "6", "name": "blank", "file": "demo/17/x.json", "live": False},
    ]}],
}


def card(text, live_text=None):
    """A card's data as the branch holds it: the card, and the runtime update a live task wrote."""
    data = {"card": {"metadata": {}, "components": [{"type": "page", "contents": [
        {"type": "section", "contents": [{"type": "text", "id": "loss", "text": text}]}]}]},
            "runtime": None}
    if live_text is not None:
        data["runtime"] = {"reload_token": "r1", "data": {"loss": {"type": "text", "id": "loss", "text": live_text}},
                           "created_on": "2026-10-31T05:00:00Z"}
    return json.dumps(data)


FILES = {
    "template.html": TEMPLATE,
    "demo.json": json.dumps(INDEX),
    "demo/17/start-1-blank.json": card("started"),
    "demo/17/train-3-blank.json": card("loss 9.0", live_text="loss 1.5"),
    "other/17/train-5-blank.json": card("never shown"),
}


class StandIn:
    """api.github.com, answered from the fixture; every request is recorded for the assertions."""

    def __init__(self):
        self.requests = []
        self.dispatched = []
        self.grid_answer = None

    def handle(self, route, request):
        url = urlsplit(request.url)
        path, q = url.path, parse_qs(url.query)
        self.requests.append({"method": request.method, "path": path, "query": url.query})
        if request.method == "POST" and path == "/repos/%s/actions/workflows/grid-accounts.yml/dispatches" % GRID_HOME:
            body = json.loads(request.post_data or "{}")
            self.dispatched.append(body)
            inputs = body.get("inputs", {})
            self.grid_answer = {"at": "2026-10-31T06:00:00Z", "rc": 0, "request": inputs.get("request"), "what": inputs.get("job"),
                                "lines": ["HPCW-GRID-GATE lab cards", "cards demo: 2 card(s) of 1 run(s) pushed"]}
            return route.fulfill(status=204, body="")
        if request.method != "GET":
            return self.json(route, {"message": "not here"}, 405)
        if path == "/user":
            return self.json(route, {"login": "reader"})
        for repo, push in ((REPO, True), (READ_ONLY, False), (NO_CARDS, True), (GRID_HOME, True)):
            if path == "/repos/" + repo:
                return self.json(route, {"full_name": repo, "default_branch": "main", "private": True,
                                         "permissions": {"admin": push, "push": push, "pull": True}})
        if path == "/repos/%s/contents/logs/job-%s.json" % (GRID_HOME, WORD) and q.get("ref") == ["grid"] and self.grid_answer:
            return route.fulfill(status=200, content_type="application/json", body=json.dumps(self.grid_answer))
        if path == "/repos/%s/git/blobs/%s" % (REPO, TEMPLATE_SHA):
            return route.fulfill(status=200, content_type="text/html", body=TEMPLATE)
        m = re.match(r"^/repos/" + re.escape(REPO) + r"/contents/?(.*)$", path)
        if m and q.get("ref") == ["cards"]:
            target = unquote(m.group(1)).rstrip("/")
            if not target:
                return self.json(route, [{"type": "file", "name": "template.html", "path": "template.html", "sha": TEMPLATE_SHA},
                                         {"type": "file", "name": "demo.json", "path": "demo.json", "sha": "e" * 40},
                                         {"type": "dir", "name": "demo", "path": "demo", "sha": "f" * 40}])
            if target in FILES:
                return route.fulfill(status=200, content_type="application/json", body=FILES[target])
        if path.startswith("/repos/%s/contents" % NO_CARDS) and q.get("ref") == ["cards"]:
            return self.json(route, {"message": "No commit found for the ref cards"}, 404)
        return self.json(route, {"message": "Not Found"}, 404)

    def json(self, route, data, status=200):
        route.fulfill(status=status, content_type="application/json", body=json.dumps(data))

    def reads_of(self, repo):
        return [r for r in self.requests if r["path"].startswith("/repos/%s/contents" % repo) and "ref=cards" in r["query"]]


class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


INIT = """
(function () {
  if (window !== window.top) return;
  try { sessionStorage.setItem('symphony_panel_token', %s); } catch (e) { /* none in an opaque frame */ }
  window.__probes = [];
  window.addEventListener('message', function (e) {
    if (e.data && e.data.cardProbe) window.__probes.push(JSON.parse(JSON.stringify(e.data.cardProbe)));
  });
})();
"""


@unittest.skipIf(sync_playwright is None, "Playwright is not installed: pip install playwright, and point PLAYWRIGHT_BROWSERS_PATH at its browsers")
class Pipelines(unittest.TestCase):
    """The panel at /symphony/control/, signed in, on its Pipelines tab."""

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
        self.outside = []
        self.start()

    def start(self, width=1280, height=860):
        self.context = self.browser.new_context(viewport={"width": width, "height": height})
        self.context.add_init_script(INIT % json.dumps(TOKEN))
        self.context.route("**/*", self.route)
        self.page = self.context.new_page()
        self.page.on("pageerror", lambda e: self.errors.append("pageerror: " + str(e)))

    def tearDown(self):
        self.context.close()

    def route(self, route, request):
        host = urlsplit(request.url).netloc
        if host == urlsplit(self.base).netloc:
            return route.continue_()
        if host == "api.github.com":
            return self.api.handle(route, request)
        if host in ("fonts.googleapis.com", "fonts.gstatic.com"):  # the panel's own fonts
            return route.fulfill(status=200, content_type="text/css", body="")
        self.outside.append(request.url)
        route.abort()

    def open(self, repo=REPO):
        self.page.goto(self.base + "/symphony/control/?repo=" + repo + "#pipelines")
        return self.page

    def frame(self):
        """The card's frame once its page has drawn, and what the page reported it reached."""
        self.page.wait_for_selector("#pl-view iframe.pl__frame", timeout=15000)
        self.page.wait_for_function("window.__probes.length > 0", timeout=15000)
        return self.page.locator("#pl-view iframe.pl__frame"), self.page.evaluate("window.__probes[window.__probes.length - 1]")

    def test_the_newest_live_card_shows_sealed_with_its_live_data(self):
        page = self.open()
        frame, probe = self.frame()
        # the live card is shown first, its runtime update applied to the component of its id
        self.assertEqual(probe["drawn"], "text:loss 1.5")
        self.assertEqual(frame.get_attribute("sandbox"), "allow-scripts")
        self.assertEqual(frame.get_attribute("referrerpolicy"), "no-referrer")
        doc = frame.get_attribute("srcdoc")
        head = doc.index("<head>") + len("<head>")
        self.assertTrue(doc[head:].startswith('<meta http-equiv="Content-Security-Policy" content="default-src \'none\';'), doc[:300])
        self.assertNotIn("__MF_PAYLOAD__", doc)
        # the page's own scripts ran, eval among them, and reached nothing of the panel or the network
        self.assertTrue(probe["evalRan"])
        self.assertEqual((probe["parent"], probe["storage"], probe["popup"], probe["fetch"]), (False, False, False, False))
        self.assertFalse([r for r in self.api.requests if r["path"] == "/leak"])
        self.assertEqual(self.outside, [])
        # the runs: the two cards the index may name, one held back and listed as such, and none of
        # the entries that point outside their kind and run
        buttons = page.locator("#pl-runs button.pl__card")
        self.assertEqual(buttons.count(), 3)
        self.assertEqual(page.locator("#pl-runs button.pl__card:disabled").count(), 1)
        self.assertIn("held back", page.locator("#pl-runs button.pl__card:disabled").inner_text())
        self.assertEqual(page.locator("#pl-runs button.pl__card--on .pl__step").inner_text(), "train")
        self.assertFalse([r for r in self.api.requests if "other/17" in r["path"] or "x.json" in r["path"]])
        self.assertIn("live when copied", page.locator("#pl-view .pl__bar").inner_text())
        self.assertEqual(self.errors, [])

    def test_another_card_opens_in_place_and_hiding_the_runs_widens_it(self):
        page = self.open()
        self.frame()
        page.locator("#pl-runs button.pl__card", has_text="start").click()
        page.wait_for_function("window.__probes.some(function (p) { return p.drawn === 'text:started'; })", timeout=15000)
        self.assertIn("finished", page.locator("#pl-view .pl__bar").inner_text())
        before = page.locator("#pl-view iframe.pl__frame").bounding_box()["width"]
        page.locator("#pl-wide").click()
        self.assertTrue(page.locator("#pl-runs").is_hidden())
        after = page.locator("#pl-view iframe.pl__frame").bounding_box()["width"]
        self.assertGreater(after, before + 200)
        # the template is read once, by its blob, however many cards are shown
        self.assertEqual(len([r for r in self.api.requests if "/git/blobs/" in r["path"]]), 1)
        self.assertEqual(self.errors, [])

    def test_a_repository_one_may_not_push_to_runs_no_card(self):
        page = self.open(READ_ONLY)
        page.wait_for_selector("#pl-note:not([hidden])", timeout=15000)
        self.assertIn("You may not push to " + READ_ONLY, page.locator("#pl-note").inner_text())
        self.assertEqual(self.api.reads_of(READ_ONLY), [])
        self.assertEqual(page.locator("#pl-view iframe").count(), 0)
        self.assertEqual(self.errors, [])

    def test_a_repository_with_no_branch_cards_says_so(self):
        page = self.open(NO_CARDS)
        page.wait_for_selector("#pl-runs .admin__none", timeout=15000)
        page.wait_for_function("document.querySelector('#pl-runs').textContent.indexOf('has no branch cards') >= 0", timeout=15000)
        self.assertEqual(page.locator("#pl-view iframe").count(), 0)
        self.assertEqual(self.errors, [])

    def test_update_from_the_grid_sends_the_index_word_and_reads_the_branch_again(self):
        page = self.open()
        self.frame()
        reads = len([r for r in self.api.reads_of(REPO) if r["path"].endswith("/demo.json")])
        drawn = page.evaluate("window.__probes.length")
        update = page.locator("#pl-update")
        self.assertTrue(update.is_visible())
        update.click()
        self.assertEqual(update.inner_text(), "Asking the grid...")
        # the answer read, the branch is read again and the card drawn anew from what it holds now
        page.wait_for_function("window.__probes.length > %d" % drawn, timeout=20000)
        self.assertEqual(update.inner_text(), "Update from the grid")
        self.assertEqual(len(self.api.dispatched), 1)
        sent = self.api.dispatched[0]
        self.assertEqual(sent["ref"], "main")
        self.assertEqual({k: sent["inputs"][k] for k in ("action", "slot", "job")}, {"action": "job", "slot": "", "job": WORD})
        self.assertRegex(sent["inputs"]["request"], r"^p[0-9a-z]+$")
        self.assertGreater(len([r for r in self.api.reads_of(REPO) if r["path"].endswith("/demo.json")]), reads)
        self.assertEqual(self.errors, [])

    def test_no_horizontal_scroll_on_a_phone(self):
        self.context.close()
        self.start(width=390, height=844)
        page = self.open()
        self.frame()
        self.assertLessEqual(page.evaluate("document.documentElement.scrollWidth"), 390)
        self.assertEqual(self.errors, [])


class Fixture(unittest.TestCase):
    """The fixture holds what the tests take it to."""

    def test_the_template_marks_one_place_and_each_card_is_json(self):
        self.assertEqual(TEMPLATE.count("__MF_PAYLOAD__"), 1)
        for name, text in FILES.items():
            if name.endswith(".json"):
                json.loads(text)
        self.assertEqual(json.loads(base64.b64decode(base64.b64encode(FILES["demo.json"].encode())))["kind"], "demo")


if __name__ == "__main__":
    unittest.main()
