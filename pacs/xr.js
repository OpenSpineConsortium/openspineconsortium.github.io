/*
  OpenSpineConsortium — lateral-radiograph (DRR) tab of the spinopelvic demo.

  Shows the DRR of the SAME CT case the other tab renders in 3-D, with the
  spinopelvic constructions drawn by OpenSpineToolkit's own 2-D projection
  (ostk.drr + ostk.project2d, PR #5).

  Same metrics.json contract as pacs.js. `summary` is copied verbatim from the CT
  bundle -- so the two tabs provably report the same numbers -- and only the
  geometry space differs:

      geometry.space = "world_mm"   (CT)  3-D  -> NiiVue mmToPx()
      geometry.space = "image_px"   (XR)  2-D  -> used verbatim in the svg viewBox

  Bundles are built by pacs/tools/export_xr_demo_case.py. Nothing is computed in
  the browser and nothing is uploaded; this is a viewer.
*/

const XR_BUILD = "20260803e";

const els = {
  img:     document.getElementById("xrimg"),
  overlay: document.getElementById("overlay"),
  caseSel: document.getElementById("caseSel"),
  hudCase: document.getElementById("hudCase"),
  metrics: document.getElementById("metricBtns"),
  clear:   document.getElementById("clearMetrics"),
  report:  document.getElementById("report"),
  schwab:  document.getElementById("schwab"),
  loading: document.getElementById("loading"),
  empty:   document.getElementById("emptyState"),
};


let current = null;            // parsed metrics.json
const active = new Map();      // angle id -> shown

/* ── SVG overlay ─────────────────────────────────────────────────────────────
   The svg's viewBox IS the DRR's pixel grid and it shares the image's box, so a
   point from metrics.json is used verbatim. This replaced a canvas + hand-rolled
   letterbox mapping, which is exactly where the overlay kept failing to line up. */
const SVGNS = "http://www.w3.org/2000/svg";

function el(tag, attrs) {
  const n = document.createElementNS(SVGNS, tag);
  for (const k in attrs) n.setAttribute(k, attrs[k]);
  return n;
}

function syncOverlaySize() {
  if (!current) return;
  const [H, W] = current.geometry.drr.shape;      // shape is [H, W]
  els.overlay.setAttribute("viewBox", `0 0 ${W} ${H}`);
  drawOverlay();
}

function strokePath(d, color, w, dash) {
  const halo = el("path", { d, class: "halo", "stroke-width": w + 2.5 });
  const line = el("path", { d, class: "seg", stroke: color, "stroke-width": w });
  if (dash) { halo.setAttribute("stroke-dasharray", dash); line.setAttribute("stroke-dasharray", dash); }
  return [halo, line];
}

function drawAngle(a, g) {
  const seg = (p, q) => `M${p[0]},${p[1]} L${q[0]},${q[1]}`;
  const poly = (pts) => pts.map((p, i) => `${i ? "L" : "M"}${p[0]},${p[1]}`).join(" ");
  for (const s of a.segments || [])
    strokePath(seg(s[0], s[1]), a.color, 2.6).forEach(n => g.appendChild(n));
  for (const s of a.dashed || [])
    strokePath(seg(s[0], s[1]), a.color, 1.8, "5 4").forEach(n => g.appendChild(n));
  if (Array.isArray(a.arc) && a.arc.length > 1)   // the wedge -- makes it read as an angle
    strokePath(poly(a.arc), a.color, 1.8, "4 3").forEach(n => g.appendChild(n));
  if (a.label_at) {
    const t = el("text", { x: a.label_at[0], y: a.label_at[1], fill: a.color });
    t.textContent = `${a.id} ${a.value}${a.units || "°"}`;
    g.appendChild(t);
  }
}

function drawOverlay() {
  els.overlay.innerHTML = "";
  if (!current) return;
  for (const a of current.geometry.angles) {
    if (!active.has(a.id)) continue;
    const g = el("g", {});
    drawAngle(a, g);
    els.overlay.appendChild(g);
  }
}

/* A DRR is one static image -- nothing to scroll to and nothing to wait for -- so
   every construction is shown on load; the buttons toggle them. */
/* ONE construction at a time. Drawing all four at once put SS, PT and PI inside the
   same ~60 px of sacrum and they became unreadable. Opens on PI. */
function select(id) {
  active.clear();
  if (id) active.set(id, true);
  [...els.metrics.children].forEach(b => b.classList.toggle("is-on", b.dataset.id === id));
  drawOverlay();
}

function drawAll() {
  if (!current || !current.geometry.angles.length) return;
  const first = current.geometry.angles.find(a => a.id === "PI") || current.geometry.angles[0];
  select(first.id);
}

/* ── panels ──────────────────────────────────────────────────────────────── */

function renderReport() {
  const s = current.summary;
  const f = (v, u = "°") => (v == null ? '<span class="muted">n/a</span>' : `${v}${u}`);
  const rows = [["PI", f(s.PI)], ["SS", f(s.SS)], ["PT", f(s.PT)], ["LL", f(s.LL)]];
  if (s["PI-LL"]) rows.push(["PI − LL", f(s["PI-LL"].pi_minus_ll)]);
  els.report.innerHTML = rows.map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join("");
  const d = (current.geometry && current.geometry.drr) || {};
  els.schwab.innerHTML =
    `<p class="panel__note">DRR integrated along the patient's true bicoxofemoral axis`
    + (d.pixel_spacing_mm ? ` at ${d.pixel_spacing_mm} mm/px` : "")
    + (d.fov_mm ? ` · FOV ${Math.round(d.fov_mm[0])}×${Math.round(d.fov_mm[1])} mm` : "")
    + `. Values are the CT case's own — identical to the CT tab, drawn here in the`
    + ` projected plane.</p>`;
}

function renderButtons() {
  els.metrics.innerHTML = "";
  for (const a of current.geometry.angles) {
    const b = document.createElement("button");
    b.className = "metric";
    b.innerHTML = `<span class="metric__k">${a.id}</span>`
                + `<span class="metric__v">${a.value}${a.units || "°"}</span>`;
    b.style.setProperty("--c", a.color);
    b.dataset.id = a.id;
    b.onclick = () => select(active.has(a.id) ? null : a.id);
    els.metrics.appendChild(b);
  }
}

/* ── loading ─────────────────────────────────────────────────────────────── */

function showEmpty(on, msg) {
  els.empty.hidden = !on;
  if (msg) els.empty.querySelector(".empty__msg").textContent = msg;
}

function showImage(src) {
  return new Promise((res, rej) => {
    els.img.onload = () => res();
    els.img.onerror = () => rej(new Error("image not found"));
    els.img.src = src;
  });
}

async function loadCase(dir) {
  els.loading.hidden = false;
  active.clear();
  try {
    const m = await (await fetch(`data/xr/${dir}/metrics.json?v=${XR_BUILD}`,
                                 { cache: "no-store" })).json();
    if (!m.geometry || m.geometry.space !== "image_px")
      throw new Error(`geometry.space must be "image_px"`);
    await showImage(`data/xr/${dir}/${m.image || "image.png"}?v=${XR_BUILD}`);
    current = m;
    els.hudCase.textContent = m.title || m.case_id || dir;
    renderButtons(); renderReport(); syncOverlaySize();
    showEmpty(false);
    drawAll();                       // static film -> show every construction straight away
  } catch (e) {
    current = null;
    els.report.innerHTML = ""; els.metrics.innerHTML = ""; els.schwab.innerHTML = "";
    showEmpty(true, `Could not load “${dir}”: ${e.message}`);
  } finally {
    els.loading.hidden = true;
  }
}

async function loadManifest() {
  try {
    const m = await (await fetch("data/xr/manifest.json", { cache: "no-store" })).json();
    const cases = m.cases || [];
    els.caseSel.innerHTML = cases.map(c => `<option value="${c.dir}">${c.label}</option>`).join("");
    if (!cases.length) {
      showEmpty(true, "No DRR bundles yet — build one with pacs/tools/export_xr_demo_case.py.");
      return;
    }
    await loadCase(cases[0].dir);
  } catch {
    showEmpty(true, "data/xr/manifest.json not found.");
  }
}

els.caseSel.addEventListener("change", (e) => loadCase(e.target.value));
els.clear.addEventListener("click", () => {
  active.clear(); drawOverlay();
  [...els.metrics.children].forEach(b => b.classList.remove("is-on"));
});
window.addEventListener("resize", syncOverlaySize);

loadManifest();
