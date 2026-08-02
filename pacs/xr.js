/*
  OpenSpineConsortium — lateral-radiograph (DRR) tab of the spinopelvic demo.

  Shows the DRR of the SAME CT case the other tab renders in 3-D, with the
  spinopelvic constructions drawn by OpenSpineToolkit's own 2-D projection
  (ostk.drr + ostk.project2d, PR #5).

  Same metrics.json contract as pacs.js. `summary` is copied verbatim from the CT
  bundle -- so the two tabs provably report the same numbers -- and only the
  geometry space differs:

      geometry.space = "world_mm"   (CT)  3-D  -> NiiVue mmToPx()
      geometry.space = "image_px"   (XR)  2-D  -> imgToPx() below

  Bundles are built by pacs/tools/export_xr_demo_case.py. Nothing is computed in
  the browser and nothing is uploaded; this is a viewer.
*/

const XR_BUILD = "20260802b";

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
const ctx = els.overlay.getContext("2d");

let current = null;            // parsed metrics.json
let imgNat = { w: 0, h: 0 };   // natural pixel size of the DRR
const active = new Map();      // angle id -> {t} animation state

/* ── image pixel -> canvas pixel ─────────────────────────────────────────────
   The DRR is rendered with object-fit: contain, so replicate that letterbox. */
function imgToPx(p) {
  if (!imgNat.w || !imgNat.h) return null;
  const r = els.img.getBoundingClientRect();
  const o = els.overlay.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const s = Math.min(r.width / imgNat.w, r.height / imgNat.h);
  const offX = r.left - o.left + (r.width  - imgNat.w * s) / 2;
  const offY = r.top  - o.top  + (r.height - imgNat.h * s) / 2;
  return [(offX + p[0] * s) * dpr, (offY + p[1] * s) * dpr];
}

function syncOverlaySize() {
  const dpr = window.devicePixelRatio || 1;
  const r = els.overlay.getBoundingClientRect();
  els.overlay.width  = Math.round(r.width  * dpr);
  els.overlay.height = Math.round(r.height * dpr);
  drawOverlay();
}

/* ── drawing (same visual language as pacs.js) ───────────────────────────── */

const lerp = (p, q, t) => [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t];

function strokeLine(p, q, color, w) {
  ctx.lineCap = "round";
  ctx.strokeStyle = "rgba(0,0,0,0.85)"; ctx.lineWidth = w + 3;
  ctx.beginPath(); ctx.moveTo(p[0], p[1]); ctx.lineTo(q[0], q[1]); ctx.stroke();
  ctx.strokeStyle = color; ctx.lineWidth = w;
  ctx.beginPath(); ctx.moveTo(p[0], p[1]); ctx.lineTo(q[0], q[1]); ctx.stroke();
}

function drawAngle(a, t, dpr) {
  if (!a || !Array.isArray(a.segments)) return;
  const lw = Math.max(3, 3.5 * dpr);
  for (const s of a.segments) {                      // solid = anatomical line
    const p = imgToPx(s[0]), q = imgToPx(s[1]);
    if (p && q) strokeLine(p, lerp(p, q, t), a.color, lw);
  }
  if (Array.isArray(a.dashed) && a.dashed.length) {  // dashed = reference line
    ctx.setLineDash([6 * dpr, 5 * dpr]);
    for (const s of a.dashed) {
      const p = imgToPx(s[0]), q = imgToPx(s[1]);
      if (p && q) strokeLine(p, lerp(p, q, t), a.color, Math.max(2, 2.2 * dpr));
    }
    ctx.setLineDash([]);
  }
  if (t < 1) return;
  const L = imgToPx(a.label_at);
  if (L) {
    const txt = `${a.id} ${a.value}${a.units || "°"}`;
    ctx.font = `${Math.max(13, 14 * dpr)}px "IBM Plex Mono", monospace`;
    const w = ctx.measureText(txt).width, h = 21 * dpr;
    ctx.fillStyle = "rgba(8,12,18,0.82)";
    ctx.fillRect(L[0] - 6, L[1] - h + 5, w + 12, h);
    ctx.fillStyle = a.color;
    ctx.fillText(txt, L[0], L[1]);
  }
}

function drawOverlay() {
  ctx.clearRect(0, 0, els.overlay.width, els.overlay.height);
  if (!current) return;
  const dpr = window.devicePixelRatio || 1;
  for (const a of current.geometry.angles) {
    const st = active.get(a.id);
    if (st) drawAngle(a, st.t, dpr);
  }
}

function animate(id) {
  const st = { t: 0 };
  active.set(id, st);
  const t0 = performance.now(), dur = 480;
  const step = (now) => {
    st.t = Math.min(1, (now - t0) / dur);
    drawOverlay();
    if (st.t < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
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
    b.onclick = () => { animate(a.id); b.classList.add("is-on"); };
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
    els.img.onload = () => { imgNat = { w: els.img.naturalWidth, h: els.img.naturalHeight }; res(); };
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
