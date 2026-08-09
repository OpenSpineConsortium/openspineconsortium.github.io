"""Measure the X-ray tab on a REAL GPU.

test_page.py runs headless, where Chromium falls back to SwiftShader and every timing
it reports is a CPU timing -- useful for correctness, worthless for latency. This
launches a headed Chromium against the actual adapter, confirms the page selected the
WebGPU execution provider rather than quietly dropping to WASM, and times repeated
inferences so the number excludes shader compilation.

    python pacs/tools/test_webgpu.py <image.jpg> [--runs 5]
"""
import sys, os, threading, http.server, socketserver, functools, pathlib, statistics, tempfile

ROOT = pathlib.Path(__file__).resolve().parents[2]
PORT = 8732


def main():
    img = pathlib.Path(sys.argv[1])
    runs = int(sys.argv[sys.argv.index("--runs") + 1]) if "--runs" in sys.argv else 5
    h = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(ROOT))
    socketserver.TCPServer.allow_reuse_address = True
    srv = socketserver.TCPServer(("127.0.0.1", PORT), h)
    threading.Thread(target=srv.serve_forever, daemon=True).start()

    from playwright.sync_api import sync_playwright
    with sync_playwright() as p:
        extra = os.environ.get("CHROME_ARGS", "").split()
        br = p.chromium.launch(headless=False, args=extra)
        pg = br.new_page(viewport={"width": 1600, "height": 950})
        pg.goto(f"http://127.0.0.1:{PORT}/pacs/", wait_until="networkidle")

        adapter = pg.evaluate("""async () => {
            if (!navigator.gpu) return null;
            const a = await navigator.gpu.requestAdapter();
            if (!a) return "no adapter";
            const i = a.info || (a.requestAdapterInfo ? await a.requestAdapterInfo() : {});
            return `${i.vendor || "?"} / ${i.architecture || i.description || "?"}`;
        }""")
        print(f"  navigator.gpu adapter : {adapter}")

        pg.set_input_files("#fileInput", str(img))
        pg.wait_for_function(
            "document.querySelectorAll('#uoverlay .lm__hit').length > 0", timeout=240000)
        backend = pg.inner_text("#engineBadge")
        print(f"  execution provider    : {backend}")
        print(f"  first inference       : {pg.inner_text('#timing')}")

        # Re-run through the page's own path so the timing is the one users see.
        times = []
        for _ in range(runs):
            pg.evaluate("document.getElementById('confRange')"
                        ".dispatchEvent(new Event('change'))")
            pg.wait_for_timeout(150)
            pg.wait_for_selector("#uloading[hidden]", state="attached", timeout=120000)
            t = pg.inner_text("#timing").split(" ms")[0]
            times.append(float(t))
        print(f"  steady state ({runs} runs)  : median {statistics.median(times):.0f} ms"
              f"  min {min(times):.0f}  max {max(times):.0f}")
        print(f"  metrics               : {pg.inner_text('#metricBtns')[:60]!r}")
        pg.screenshot(path=str(pathlib.Path(tempfile.gettempdir()) / "xrshots" / "webgpu.png"))
        br.close()
    srv.shutdown()
    if "webgpu" not in backend.lower():
        print("\n  NOTE: the page did NOT get WebGPU -- the timing above is a CPU number.")


if __name__ == "__main__":
    main()
