"""End-to-end browser test for the X-ray tab.

Drives a real Chromium over a real HTTP server: loads the page, checks the reference
pane, then exercises BOTH input paths the page promises -- a dropped/selected file and
a CLIPBOARD PASTE -- and asserts the model actually ran and produced angles in range.

The paste path is tested with a synthetic ClipboardEvent carrying a real File, which is
exactly the object shape a browser delivers when you hit Ctrl-V on a screenshot. It is
the feature most likely to be quietly broken (nothing else on the page exercises it)
and the one that cannot be checked by clicking around.

    python pacs/tools/test_page.py <image.jpg> [--headed]

Screenshots land in /tmp/xrshots for eyeballing.
"""
import sys, os, threading, http.server, socketserver, functools, pathlib, tempfile

ROOT = pathlib.Path(__file__).resolve().parents[2]
SHOTS = pathlib.Path(os.environ.get("SHOTS") or (pathlib.Path(tempfile.gettempdir())
                                                 / "xrshots"))
PORT = 8731


def serve():
    h = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(ROOT))
    socketserver.TCPServer.allow_reuse_address = True
    srv = socketserver.TCPServer(("127.0.0.1", PORT), h)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv


PASTE_JS = """
async (b64) => {
  const bin = atob(b64);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  const file = new File([buf], "pasted.jpg", { type: "image/jpeg" });
  const dt = new DataTransfer();
  dt.items.add(file);
  document.dispatchEvent(new ClipboardEvent("paste", {
    clipboardData: dt, bubbles: true, cancelable: true }));
  return true;
}
"""


def read_metrics(pg):
    return pg.evaluate("""() => {
        const o = {};
        document.querySelectorAll('#metricBtns .metric').forEach(b => {
          const k = b.querySelector('.metric__k')?.textContent;
          const v = b.querySelector('.metric__v')?.textContent;
          if (k) o[k] = v; });
        return o; }""")


def main():
    img = pathlib.Path(sys.argv[1])
    headed = "--headed" in sys.argv
    SHOTS.mkdir(exist_ok=True)
    srv = serve()
    from playwright.sync_api import sync_playwright

    fails = []
    def check(cond, what):
        print(("  ok   " if cond else "  FAIL ") + what)
        if not cond:
            fails.append(what)

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=not headed, args=[
            "--enable-unsafe-webgpu", "--enable-features=Vulkan",
            "--use-angle=swiftshader", "--use-gl=angle",
        ])
        pg = browser.new_page(viewport={"width": 1680, "height": 1000})
        errs = []
        pg.on("pageerror", lambda e: errs.append(str(e)))
        pg.on("console", lambda m: errs.append(f"console.{m.type}: {m.text}")
              if m.type == "error" else None)

        print("\n[1] reference pane")
        pg.goto(f"http://127.0.0.1:{PORT}/pacs/", wait_until="networkidle")
        pg.wait_for_selector("#xrimg[src]", timeout=15000)
        pg.wait_for_function("document.querySelectorAll('#overlay .lm__hit').length > 0",
                             timeout=15000)
        n_lm = pg.eval_on_selector_all("#overlay .lm__hit", "els => els.length")
        n_btn = pg.eval_on_selector_all("#metricBtns .metric", "els => els.length")
        rows = pg.eval_on_selector_all("#lmList .lmrow", "els => els.length")
        check(n_lm == 13, f"13 landmark markers drawn (got {n_lm})")
        check(n_btn == 4, f"4 metric buttons: PI/SS/PT/LL (got {n_btn})")
        check(rows == 13, f"13 landmark rows in panel (got {rows})")

        # The two modality tabs must carry the SAME disclaimer. The X-ray tab shipped
        # with a shortened one, which is the wrong direction: it is the tab that accepts
        # a film the user supplies.
        disc = " ".join(pg.inner_text(".disclaimer").split())
        for phrase in ("Research & educational use only", "not a medical device",
                       "not for clinical or diagnostic use",
                       "simulated post-operative results",
                       "Sample imaging is de-identified research data"):
            check(phrase in disc, f"disclaimer says {phrase!r}")

        # the tooltip is the "interactive class names" requirement -- verify it fires
        pg.hover("#overlay .lm__hit")
        pg.wait_for_selector("#tip:not([hidden])", timeout=4000)
        tip = pg.inner_text("#tip")
        check("endplate" in tip.lower() or "femoral" in tip.lower(),
              f"marker tooltip names the landmark ({tip.splitlines()[0][:44]!r})")
        pg.screenshot(path=str(SHOTS / "1_reference.png"))

        print("\n[2] file input -> inference")
        pg.set_input_files("#fileInput", str(img))
        pg.wait_for_function(
            "document.querySelectorAll('#uoverlay .lm__hit').length > 0", timeout=180000)
        backend = pg.inner_text("#engineBadge")
        timing = pg.inner_text("#timing")
        hud = pg.inner_text("#hudUser")
        vals = read_metrics(pg)
        print(f"       backend={backend}  timing={timing}  hud={hud}")
        print(f"       metrics={vals}")
        check("vertebrae" in hud, f"detections reported in the pane header ({hud!r})")
        check("SS" in vals and "LL" in vals, f"SS and LL measured (got {list(vals)})")
        check(vals.get("PI") == "n/a" and vals.get("PT") == "n/a",
              "PI and PT reported n/a, not estimated")
        ss = float(vals.get("SS", "nan").rstrip("°"))
        ll = float(vals.get("LL", "nan").rstrip("°"))
        check(10 < ss < 70, f"SS physiological ({ss}°)")
        check(10 < ll < 90, f"LL physiological ({ll}°)")
        n_u = pg.eval_on_selector_all("#uoverlay .lm__hit", "els => els.length")
        check(n_u >= 20, f"corner markers drawn on the user film ({n_u})")
        pg.screenshot(path=str(SHOTS / "2_inference.png"))

        print("\n[3] clipboard paste")
        pg.click("#clearUser")
        pg.wait_for_selector("#dropPrompt:not([hidden])")
        import base64
        b64 = base64.b64encode(img.read_bytes()).decode()
        pg.evaluate(PASTE_JS, b64)
        pg.wait_for_function(
            "document.querySelectorAll('#uoverlay .lm__hit').length > 0", timeout=180000)
        vals2 = read_metrics(pg)
        check(vals2.get("SS") == vals.get("SS") and vals2.get("LL") == vals.get("LL"),
              f"paste gives the same result as the file input ({vals2.get('SS')})")
        pg.screenshot(path=str(SHOTS / "3_paste.png"))

        # The mirror control exists because the keypoint slots are handed. The test that
        # matters is not "does mirroring change the answer" -- it is "does a film that
        # arrives facing the WRONG WAY get recovered by one click", which is the only
        # situation a user is ever in.
        print("\n[4] mirror control recovers a wrong-facing film")
        from PIL import Image, ImageOps
        mirrored = SHOTS / "mirrored_input.png"
        ImageOps.mirror(Image.open(img)).save(mirrored)

        pg.click("#clearUser")
        pg.wait_for_selector("#dropPrompt:not([hidden])")
        pg.set_input_files("#fileInput", str(mirrored))
        pg.wait_for_function("document.getElementById('uimg').hidden === false",
                             timeout=180000)
        pg.wait_for_timeout(1500)
        before = read_metrics(pg)
        print(f"       wrong-facing: {before}")

        pg.click("#flipBtn")
        pg.wait_for_timeout(500)
        pg.wait_for_function(
            "document.querySelectorAll('#uoverlay .lm__hit').length > 0", timeout=180000)
        after = read_metrics(pg)
        print(f"       after mirror: {after}")
        check(after.get("SS") == vals.get("SS") and after.get("LL") == vals.get("LL"),
              f"one click restores the correct reading "
              f"(SS {after.get('SS')} vs {vals.get('SS')})")
        check(before.get("SS") != after.get("SS"),
              "the wrong-facing film did NOT silently read the same")
        pg.screenshot(path=str(SHOTS / "4_mirror_recovered.png"))

        print("\n[4b] 1024 model")
        pg.click("#clearUser")
        pg.wait_for_selector("#dropPrompt:not([hidden])")
        pg.select_option("#modelSel", "1024")
        pg.set_input_files("#fileInput", str(img))
        pg.wait_for_function(
            "document.querySelectorAll('#uoverlay .lm__hit').length > 0", timeout=300000)
        v1024 = read_metrics(pg)
        print(f"       1024 metrics={v1024}  {pg.inner_text('#timing')}")
        check("SS" in v1024 and v1024["SS"] != "n/a", f"1024 weights also run ({v1024.get('SS')})")
        pg.screenshot(path=str(SHOTS / "5_model1024.png"))

        # A standing C2-S1 film puts the lumbar spine in about a third of the frame.
        # Simulated here by padding the coned film into a tall canvas -- the same
        # construction scripts/standing_scale_sweep.py sweeps, at the f that matters.
        print("\n[5] standing framing falls back to tiles")
        f = 0.36
        src = Image.open(img)
        W, H = src.size
        tall = Image.new("L", (int(W * 1.15), int(H / f)), 114)
        tall.paste(src.convert("L"), ((tall.width - W) // 2, (tall.height - H) // 2))
        tall_path = SHOTS / "standing_input.png"
        tall.save(tall_path)

        pg.click("#clearUser")
        pg.wait_for_selector("#dropPrompt:not([hidden])")
        pg.select_option("#modelSel", "640")
        pg.select_option("#modeSel", "single")
        pg.set_input_files("#fileInput", str(tall_path))
        pg.wait_for_function("document.getElementById('uimg').hidden === false",
                             timeout=180000)
        pg.wait_for_selector("#uloading[hidden]", state="attached", timeout=300000)
        single_hud = pg.inner_text("#hudUser")
        print(f"       single pass : {single_hud}")
        check("no detections" in single_hud or "vertebrae" not in single_hud,
              f"one pass at standing framing finds nothing ({single_hud!r})")

        pg.select_option("#modeSel", "auto")
        pg.wait_for_function(
            "document.querySelectorAll('#uoverlay .lm__hit').length > 0", timeout=300000)
        auto_hud = pg.inner_text("#hudUser")
        auto_t = pg.inner_text("#timing")
        v_st = read_metrics(pg)
        print(f"       auto (tiled): {auto_hud} | {auto_t} | {v_st}")
        check("tiles" in auto_t, f"auto fell back to tiling ({auto_t!r})")
        check("vertebrae" in auto_hud, f"tiling recovers the vertebrae ({auto_hud!r})")
        if v_st.get("SS", "n/a") != "n/a":
            d = abs(float(v_st["SS"].rstrip("°")) - float(vals["SS"].rstrip("°")))
            check(d < 6, f"standing-framing SS within 6° of the coned reading ({d:.1f}°)")
        pg.screenshot(path=str(SHOTS / "6_standing_tiled.png"))

        print("\n[6] page errors")
        real = [e for e in errs if "favicon" not in e.lower()]
        check(not real, f"no page errors ({real[:2]})")

        browser.close()
    srv.shutdown()
    print(f"\nshots in {SHOTS}")
    print("FAILED: " + "; ".join(fails) if fails else "\nALL CHECKS PASSED")
    sys.exit(1 if fails else 0)


if __name__ == "__main__":
    main()
