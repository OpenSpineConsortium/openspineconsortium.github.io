"""Drive the live PACS page in a real browser and report the backend it actually uses.

Every number given about this page before this script existed was scaled from a native-CPU
measurement or from a comment recorded at a different input size. That is guesswork wearing
a decimal point. The page already computes the truth -- backend, adapter, thread count, and
a per-inference millisecond figure -- and prints it into the DOM; this opens the page, feeds
it a film, and reads those values back.

IT ENTERS THROUGH THE GITHUB.IO HOST ON PURPOSE. That host 301s to the apex domain over
plain http, and both of this page's fast paths are secure-context-only: navigator.gpu is
undefined over http and a service worker cannot register, so coi-serviceworker never applies
COOP/COEP and onnxruntime-web is capped at one wasm thread. Entering at the https apex
directly would test a path most visitors never take and would have hidden the 40-second
failure entirely.

The page's own service worker reloads it once to gain isolation, which discards anything
already typed or attached; the upload therefore waits for crossOriginIsolated to settle
before touching the form.

WHAT IT PROVES AND WHAT IT DOES NOT. It measures THIS machine -- its GPU, driver, and
Chrome. Another visitor may get another backend. What it establishes for everyone is whether
the WebGPU path starts at all, whether the service worker wins its threads, and what the
model costs once loaded.

    python pacs/measure_live.py --film FILM.png [--url ...] [--headed] [--channel chrome]
"""
from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

ENTRY = "https://openspineconsortium.github.io/pacs/"
TIMING = re.compile(r"(\d+)\s*ms\s*[·|]\s*(GPU|CPU)")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--film", required=True)
    ap.add_argument("--url", default=ENTRY)
    ap.add_argument("--headed", action="store_true")
    ap.add_argument("--channel", default=None, help="e.g. chrome, for a build with WebGPU")
    ap.add_argument("--timeout", type=int, default=420_000)
    a = ap.parse_args()

    film = Path(a.film)
    if not film.exists():
        print(f"no such film: {film}", file=sys.stderr)
        return 2

    with sync_playwright() as pw:
        launch = {"headless": not a.headed,
                  "args": ["--enable-unsafe-webgpu", "--enable-features=Vulkan"]}
        if a.channel:
            launch["channel"] = a.channel
        browser = pw.chromium.launch(**launch)
        page = browser.new_context().new_page()
        logs: list[str] = []
        page.on("console", lambda m: logs.append(m.text))
        page.on("pageerror", lambda e: logs.append(f"pageerror: {e}"))

        print(f"entering at {a.url}")
        page.goto(a.url, wait_until="load", timeout=a.timeout)

        # the coi service worker reloads once into isolation; let that settle first
        for _ in range(6):
            if page.evaluate("() => !!self.crossOriginIsolated"):
                break
            page.wait_for_timeout(2500)
        page.wait_for_timeout(2500)

        st = page.evaluate("""async () => {
            let ad = null;
            if (navigator.gpu) {
                const g = await navigator.gpu.requestAdapter({powerPreference:'high-performance'});
                if (g) { const i = g.info || {};
                    ad = [i.vendor, i.architecture, i.device].filter(Boolean).join(' ') || 'unnamed'; }
            }
            return {url: location.href, proto: location.protocol,
                    iso: !!self.crossOriginIsolated, gpu: !!navigator.gpu, adapter: ad,
                    sw: !!(navigator.serviceWorker && navigator.serviceWorker.controller)};
        }""")
        print(f"  landed on           : {st['url']}")
        print(f"  crossOriginIsolated : {st['iso']}   (false => wasm is single-threaded)")
        print(f"  service worker ctl  : {st['sw']}")
        print(f"  navigator.gpu       : {st['gpu']}")
        print(f"  WebGPU adapter      : {st['adapter']}")

        inputs = page.query_selector_all("input[type=file]")
        if not inputs:
            print("no file input on the page", file=sys.stderr)
            browser.close()
            return 3
        print(f"\nuploading {film.name} ...")
        inputs[0].set_input_files(str(film.resolve()))

        try:
            page.wait_for_function(
                "() => /\\d+\\s*ms\\s*[·|]\\s*(GPU|CPU)/.test(document.body.innerText)",
                timeout=a.timeout)
        except Exception:
            print("\nno timing text appeared. visible text:", file=sys.stderr)
            body = page.inner_text("body")
            for line in [l for l in body.split("\n") if l.strip()][:20]:
                print("   ", line, file=sys.stderr)
            for l in logs[-20:]:
                print("   log:", l[:160], file=sys.stderr)
            browser.close()
            return 4

        m = TIMING.search(page.inner_text("body"))
        print("\n  ==================================================")
        print(f"   PAGE REPORTS : {int(m.group(1)):,} ms on the {m.group(2)}")
        print("  ==================================================")

        det = re.search(r"(\d+)\s*vertebr\w*", page.inner_text("body"), re.I)
        if det:
            print(f"  detections   : {det.group(0)}")
        for l in logs:
            if "falling back" in l or "webgpu" in l.lower():
                print(f"  note         : {l[:150]}")
        browser.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
