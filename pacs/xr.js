/*
  OpenSpineConsortium — lateral radiograph tab of the spinopelvic demo.

  Consumes the SAME metrics.json contract as the CT viewer (pacs.js). The only
  difference is the geometry space:

      geometry.space = "world_mm"   (CT)  -> 3-D points, mapped by NiiVue's mmToPx()
      geometry.space = "image_px"   (XR)  -> 2-D points in the source image's pixel
                                             grid, mapped by imgToPx() below

  `summary` is IDENTICAL in both, so the report / Schwab / surgical-planning panels
  are shared verbatim — that is the whole point of the contract.

  Model hook: inferLandmarks() is the single function to replace when a trained
  net is available. Everything downstream (deriveFromLandmarks -> summary+geometry)
  is plain geometry and already runs client-side, so an ONNX Runtime Web model can
  drop in with no server.
*/

const XR_BUILD = "20260802a";

const els = {
  img:      document.getElementById("xrimg"),
  overlay:  document.getElementById("overlay"),
  caseSel:  document.getElementById("caseSel"),
  hudCase:  document.getElementById("hudCase"),
  metrics:  document.getElementById("metricBtns"),
  clear:    document.getElementById("clearMetrics"),
  report:   document.getElementById("report"),
  schwab:   document.getElementById("schwab"),
  loading:  document.getElementById("loading"),
  empty:    document.getElementById("emptyState"),
  drop:     document.getElementById("dropZone"),
  file:     document.getElementById("fileInput"),
};
const ctx = els.overlay.getContext("2d");

let current = null;          // parsed metrics.json
let imgNat = { w: 0, h: 0 }; // natural pixel size of the loaded film
const active = new Map();    // angle id -> {t}

/* ─────────────────────────── geometry core ───────────────────────────────
   Mirrors tools/export_xr_case.py exactly. Image pixel space: +x right, +y DOWN.
   Anatomical convention for a lateral film with the patient facing LEFT:
   anterior = -x, superior = -y.                                              */

const sub  = (a, b) => [a[0] - b[0], a[1] - b[1]];
const mid  = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
const angOf = (v) => Math.atan2(v[1], v[0]) * 180 / Math.PI;
function acute(d) { d = Math.abs(d) % 180; return d > 90 ? 180 - d : d; }

/** Landmarks -> spinopelvic parameters + drawable constructions.
 *  L = {S1a,S1p,FH,L1a,L1p} each [x,y] in image pixels.
 *  Returns {summary, geometry} in the shared contract shape. */
export function deriveFromLandmarks(L, meta = {}) {
  const { S1a, S1p, FH, L1a, L1p } = L;
  const S1m = mid(S1a, S1p);
  const ep  = sub(S1a, S1p);                 // S1 endplate, posterior -> anterior
  const hip = sub(S1m, FH);                  // femoral head axis -> S1 midpoint
  const nrm = [-ep[1], ep[0]];               // normal to the endplate

  const SS = acute(angOf(ep));                       // endplate vs horizontal
  let   PT = acute(angOf(hip) + 90);                 // hip vector vs vertical
  if (hip[0] > 0) PT = -PT;                          // S1 behind the hip axis -> negative
  const PI = acute(angOf(hip) - angOf(nrm));
  const LL = acute(angOf(sub(L1a, L1p)) - angOf(ep));// Cobb: L1 sup vs S1 sup

  const r1 = (x) => Math.round(x * 10) / 10;
  const summary = {
    case_id: meta.case_id || "xr",
    modality: "XR",
    PI: r1(PI), SS: r1(SS), PT: r1(PT), LL: r1(LL),
    "PI-LL": { pi_minus_ll: r1(PI - LL), abs_pi_minus_ll: r1(Math.abs(PI - LL)) },
    qc_flags: Math.abs((SS + PT) - PI) > 1.5 ? ["pi_identity_mismatch"] : ["ok"],
    method_version: "xr-landmark-v1",
  };

  // Construction lines, in the same {segments,dashed,arc,label_at} shape the CT
  // viewer already knows how to draw.
  const ext = (p, v, len) => {
    const n = Math.hypot(v[0], v[1]) || 1;
    return [p[0] + v[0] / n * len, p[1] + v[1] / n * len];
  };
  const R = Math.max(imgNat.w, imgNat.h) * 0.18 || 160;
  const geometry = {
    space: "image_px",
    angles: [
      { id: "SS", label: "Sacral Slope", value: r1(SS), units: "°", color: "#60a5fa",
        segments: [[S1p, S1a]],
        dashed:  [[S1m, ext(S1m, [1, 0], R)]],
        arc: { center: S1m, a: ext(S1m, ep, R * 0.5), b: ext(S1m, [1, 0], R * 0.5) },
        label_at: ext(S1m, [1, -0.35], R * 0.62) },
      { id: "PT", label: "Pelvic Tilt", value: r1(PT), units: "°", color: "#f59e0b",
        segments: [[FH, S1m]],
        dashed:  [[FH, ext(FH, [0, -1], R * 1.4)]],
        arc: { center: FH, a: ext(FH, hip, R * 0.5), b: ext(FH, [0, -1], R * 0.5) },
        label_at: ext(FH, [-0.5, -1], R * 0.72) },
      { id: "PI", label: "Pelvic Incidence", value: r1(PI), units: "°", color: "#a78bfa",
        segments: [[FH, S1m], [S1p, S1a]],
        dashed:  [[S1m, ext(S1m, nrm, R * 1.2)]],
        arc: { center: S1m, a: ext(S1m, hip, R * 0.5), b: ext(S1m, nrm, R * 0.5) },
        label_at: ext(S1m, [-0.9, -0.4], R * 0.7) },
      { id: "LL", label: "Lumbar Lordosis", value: r1(LL), units: "°", color: "#34d399",
        segments: [[L1p, L1a], [S1p, S1a]],
        dashed:  [],
        arc: null,
        label_at: mid(mid(L1a, L1p), S1m) },
    ],
    landmarks: L,
  };
  return { case_id: summary.case_id, summary, geometry };
}

/* ─────────────────────────── MODEL HOOK ──────────────────────────────────
   Replace this one function with a real inference call. Contract:
     in :  HTMLImageElement (the loaded film)
     out :  {S1a,S1p,FH,L1a,L1p} in that image's PIXEL coordinates, or null

   For an ONNX Runtime Web model the body becomes roughly:
       const t   = await preprocess(imgEl, 512, 512);       // NCHW float32
       const out = await session.run({ input: t });
       return postprocessHeatmaps(out, imgNat.w, imgNat.h); // -> 5 landmarks

   Nothing else in this file needs to change: deriveFromLandmarks() turns the
   landmarks into the same summary+geometry the CT tab already renders.        */
export async function inferLandmarks(/* imgEl */) {
  return null;   // no model wired yet -> the UI falls back to bundled metrics.json
}

/* ─────────────────────────── image <-> canvas ─────────────────────────── */

/** Map a point in the source image's pixel grid to overlay canvas pixels.
 *  The film is rendered with object-fit: contain, so replicate that letterbox. */
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

/* ─────────────────────────── drawing ─────────────────────────────────────
   Same visual language as pacs.js: solid = anatomical line, dashed =
   construction/reference, dotted arc = the angle wedge.                      */

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
  for (const s of a.segments) {
    const p = imgToPx(s[0]), q = imgToPx(s[1]);
    if (p && q) strokeLine(p, lerp(p, q, t), a.color, lw);
  }
  if (Array.isArray(a.dashed) && a.dashed.length) {
    ctx.setLineDash([6 * dpr, 5 * dpr]);
    for (const s of a.dashed) {
      const p = imgToPx(s[0]), q = imgToPx(s[1]);
      if (p && q) strokeLine(p, lerp(p, q, t), a.color, Math.max(2, 2.2 * dpr));
    }
    ctx.setLineDash([]);
  }
  if (t < 1) return;
  if (a.arc) {
    const C = imgToPx(a.arc.center), A = imgToPx(a.arc.a), B = imgToPx(a.arc.b);
    if (C && A && B) {
      const ba = Math.atan2(A[1] - C[1], A[0] - C[0]);
      const bb = Math.atan2(B[1] - C[1], B[0] - C[0]);
      let dd = bb - ba;
      while (dd >  Math.PI) dd -= 2 * Math.PI;
      while (dd < -Math.PI) dd += 2 * Math.PI;
      const r = Math.hypot(A[0] - C[0], A[1] - C[1]);
      ctx.setLineDash([5 * dpr, 4 * dpr]);
      ctx.strokeStyle = a.color; ctx.lineWidth = Math.max(2, 2 * dpr);
      ctx.beginPath(); ctx.arc(C[0], C[1], r, ba, ba + dd, dd < 0); ctx.stroke();
      ctx.setLineDash([]);
    }
  }
  const L = imgToPx(a.label_at);
  if (L) {
    const txt = `${a.label.split(" ").map(w => w[0]).join("")} ${a.value}${a.units}`;
    ctx.font = `${Math.max(13, 14 * dpr)}px "IBM Plex Mono", monospace`;
    const w = ctx.measureText(txt).width, h = 20 * dpr;
    ctx.fillStyle = "rgba(8,12,18,0.82)";
    ctx.fillRect(L[0] - 6, L[1] - h + 4, w + 12, h);
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

/* ─────────────────────────── report (shared shape) ───────────────────── */

function renderReport() {
  const s = current.summary;
  const f = (v, u = "°") => (v == null ? '<span class="muted">n/a</span>' : `${v}${u}`);
  const rows = [["PI", f(s.PI)], ["SS", f(s.SS)], ["PT", f(s.PT)], ["LL", f(s.LL)]];
  if (s["PI-LL"]) rows.push(["PI − LL", f(s["PI-LL"].pi_minus_ll)]);
  els.report.innerHTML = rows.map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join("");
  const bad = (s.qc_flags || []).filter(x => x !== "ok");
  els.schwab.innerHTML = bad.length
    ? `<div class="sb-h"><b>QC</b></div><p class="panel__note">${bad.join(", ")}</p>`
    : `<p class="panel__note">PI = SS + PT identity holds (${s.SS} + ${s.PT} = ${s.PI}).</p>`;
}

function renderButtons() {
  els.metrics.innerHTML = "";
  for (const a of current.geometry.angles) {
    const b = document.createElement("button");
    b.className = "metric";
    b.innerHTML = `<span class="metric__k">${a.id}</span>`
                + `<span class="metric__v">${a.value}${a.units}</span>`;
    b.style.setProperty("--c", a.color);
    b.onclick = () => { animate(a.id); b.classList.add("is-on"); };
    els.metrics.appendChild(b);
  }
}

/* ─────────────────────────── loading ─────────────────────────────────── */

function showEmpty(on, msg) {
  els.empty.hidden = !on;
  if (msg) els.empty.querySelector(".empty__msg").textContent = msg;
}

async function loadCase(dir) {
  els.loading.hidden = false;
  active.clear();
  try {
    const m = await (await fetch(`data/xr/${dir}/metrics.json?v=${XR_BUILD}`,
                                 { cache: "no-store" })).json();
    await showImage(`data/xr/${dir}/${m.image || "image.png"}?v=${XR_BUILD}`);
    current = m;
    if (!current.geometry || current.geometry.space !== "image_px")
      throw new Error(`geometry.space must be "image_px" for the XR tab`);
    els.hudCase.textContent = m.title || m.case_id || dir;
    renderButtons(); renderReport(); syncOverlaySize();
    showEmpty(false);
  } catch (e) {
    current = null;
    showEmpty(true, `Could not load “${dir}”: ${e.message}`);
  } finally {
    els.loading.hidden = true;
  }
}

function showImage(src) {
  return new Promise((res, rej) => {
    els.img.onload = () => {
      imgNat = { w: els.img.naturalWidth, h: els.img.naturalHeight };
      res();
    };
    els.img.onerror = () => rej(new Error("image not found"));
    els.img.src = src;
  });
}

/* Local file -> in-browser only. The image is read with FileReader and never
   transmitted; there is no upload endpoint in this build by design. */
async function loadLocalFile(file) {
  if (!file) return;
  els.loading.hidden = false;
  try {
    const url = await new Promise((res) => {
      const fr = new FileReader();
      fr.onload = () => res(fr.result);
      fr.readAsDataURL(file);
    });
    await showImage(url);
    const L = await inferLandmarks(els.img);
    if (!L) {
      current = null; drawOverlay(); renderEmptyReport();
      showEmpty(true, "Film loaded. No landmark model is wired up yet — "
                    + "implement inferLandmarks() in xr.js to measure it.");
      return;
    }
    current = deriveFromLandmarks(L, { case_id: file.name });
    els.hudCase.textContent = file.name;
    renderButtons(); renderReport(); syncOverlaySize(); showEmpty(false);
  } finally {
    els.loading.hidden = true;
  }
}

function renderEmptyReport() {
  els.report.innerHTML = ["PI", "SS", "PT", "LL"]
    .map(k => `<tr><td>${k}</td><td><span class="muted">n/a</span></td></tr>`).join("");
  els.schwab.innerHTML = "";
  els.metrics.innerHTML = "";
}

async function loadManifest() {
  try {
    const m = await (await fetch("data/xr/manifest.json", { cache: "no-store" })).json();
    const cases = m.cases || [];
    els.caseSel.innerHTML = cases
      .map(c => `<option value="${c.dir}">${c.label}</option>`).join("");
    if (!cases.length) {
      showEmpty(true, "No X-ray cases bundled yet. Add one under pacs/data/xr/ "
                    + "and list it in data/xr/manifest.json.");
      renderEmptyReport();
      return;
    }
    await loadCase(cases[0].dir);
  } catch {
    showEmpty(true, "data/xr/manifest.json not found.");
    renderEmptyReport();
  }
}

/* ─────────────────────────── wiring ──────────────────────────────────── */

els.caseSel.addEventListener("change", (e) => loadCase(e.target.value));
els.clear.addEventListener("click", () => {
  active.clear(); drawOverlay();
  [...els.metrics.children].forEach(b => b.classList.remove("is-on"));
});
els.file.addEventListener("change", (e) => loadLocalFile(e.target.files[0]));
["dragover", "dragenter"].forEach(ev =>
  els.drop.addEventListener(ev, (e) => { e.preventDefault(); els.drop.classList.add("is-over"); }));
["dragleave", "drop"].forEach(ev =>
  els.drop.addEventListener(ev, (e) => { e.preventDefault(); els.drop.classList.remove("is-over"); }));
els.drop.addEventListener("drop", (e) => loadLocalFile(e.dataTransfer.files[0]));
window.addEventListener("resize", syncOverlaySize);

loadManifest();
