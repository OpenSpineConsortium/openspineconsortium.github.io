// Spinopelvic PACS demo — NiiVue viewer + ostk-computed angle overlay.
//
// NiiVue renders the CT + segmentation (real .nii.gz). Angle constructions are
// precomputed in world mm by ostk (metrics.json) and drawn on a 2-D overlay
// canvas that is re-aligned to NiiVue's sagittal slice on every render, so the
// lines track pan / zoom / window-level. Clicking a measurement animates the
// rays growing from the vertex — simulating a live PACS measurement.
//
// NiiVue is loaded as ESM from the CDN. Pin a version for production
// (…/@niivue/niivue@X.Y.Z/+esm) once you have verified it in a browser.
import { Niivue, SLICE_TYPE } from "https://cdn.jsdelivr.net/npm/@niivue/niivue/+esm";

const WL = {
  bone: { min: -200, max: 1200 },
  soft: { min: -160, max: 240 },
  wide: { min: -600, max: 1600 },
};

// If the overlay is mirrored, flip these (anterior left/right, superior up/down).
const FLIP_H = false;   // horizontal (anterior–posterior) screen direction
const FLIP_V = false;   // vertical (superior–inferior) screen direction
const DEBUG = false;    // draw a diagnostic HUD + show all angles without clicking
let planeMap = null;    // {iH,iV,sH,sV} — which frac axes are in-plane (orientation-agnostic)

const els = {
  gl: document.getElementById("gl"),
  overlay: document.getElementById("overlay"),
  loading: document.getElementById("loading"),
  caseSel: document.getElementById("caseSel"),
  hudCase: document.getElementById("hudCase"),
  toggleSeg: document.getElementById("toggleSeg"),
  segOpacity: document.getElementById("segOpacity"),
  metricBtns: document.getElementById("metricBtns"),
  clearMetrics: document.getElementById("clearMetrics"),
  report: document.getElementById("report"),
  schwab: document.getElementById("schwab"),
};

const ctx = els.overlay.getContext("2d");
let nv, current = null;            // current = parsed metrics.json
const active = new Map();          // angle id -> {t:0..1} animation state

// ---- NiiVue setup ---------------------------------------------------------
nv = new Niivue({
  backColor: [0, 0, 0, 1],
  show3Dcrosshair: false,
  crosshairColor: [0.18, 0.55, 0.5, 0.6],
  dragMode: 1,                     // contrast (window/level) on drag
  isColorbar: false,
  sagittalNoseLeft: true,          // anterior points left, like a lateral film / Greenberg
});
nv.attachToCanvas(els.gl);
nv.setSliceType(SLICE_TYPE.SAGITTAL);
requestAnimationFrame(tick);       // continuous overlay sync (independent of NiiVue callbacks)

// ---- data -----------------------------------------------------------------
async function loadManifest() {
  const m = await (await fetch("data/manifest.json", { cache: "no-store" })).json();
  els.caseSel.innerHTML = "";
  m.cases.forEach((c) => {
    const o = document.createElement("option");
    o.value = c.dir; o.textContent = c.label || c.id;
    els.caseSel.appendChild(o);
  });
  if (m.cases.length) await loadCase(m.cases[0].dir);
}

async function loadCase(dir) {
  els.loading.style.display = "flex";
  active.clear();
  current = await (await fetch(`data/${dir}/metrics.json`, { cache: "no-store" })).json();
  const base = `data/${dir}/`;
  const vols = [];
  if (current.files.ct) vols.push({ url: base + current.files.ct, colormap: "gray" });
  vols.push({
    url: base + current.files.seg,
    colormap: "random",            // distinct color per integer label
    opacity: els.segOpacity.value / 100,
  });
  await nv.loadVolumes(vols);
  // CT is volume 0 if present, seg is last
  segIdx = current.files.ct ? 1 : 0;
  applyWL("bone");
  setSeg(true);
  centreOnConstruction();
  computePlaneMap();
  buildMetricButtons();
  // show computable constructions by default (Clear removes them; clicking re-animates)
  for (const a of current.geometry.angles) {
    if (a.value != null) active.set(a.id, { t: 1, start: 0 });
  }
  for (const b of els.metricBtns.children) b.classList.toggle("is-active", active.has(b.dataset.id));
  renderReport();
  els.hudCase.textContent = current.label || current.case_id;
  els.loading.style.display = "none";
  nv.drawScene();
}

let segIdx = 1;

function setSeg(on) {
  if (nv.volumes[segIdx]) nv.setOpacity(segIdx, on ? els.segOpacity.value / 100 : 0);
  els.toggleSeg.classList.toggle("ctl--on", on);
  els.toggleSeg.setAttribute("aria-pressed", String(on));
  els.toggleSeg.textContent = `Segmentation: ${on ? "on" : "off"}`;
  segOn = on;
}
let segOn = true;

function applyWL(key) {
  const v = nv.volumes[0];
  if (!v) return;
  v.cal_min = WL[key].min; v.cal_max = WL[key].max;
  nv.updateGLVolume();
}

// put the sagittal slice on the plane of the construction
function centreOnConstruction() {
  const o = current.geometry?.plane_origin;
  if (!o) return;
  try { nv.scene.crosshairPos = nv.mm2frac(o); } catch (e) { /* version drift */ }
}

// ---- world mm -> overlay canvas px ----------------------------------------
// Read NiiVue's on-screen sagittal tile and map a frac coord into it. NiiVue
// stores rendered tiles in `screenSlices`, each with leftTopWidthHeight (device
// px) and axCorSag (2 = sagittal). For sagittal, frac.y -> horizontal,
// frac.z -> vertical (top-down).
function sagittalTile() {
  const ss = nv.screenSlices || [];
  return ss.find((s) => s.axCorSag === 2) || null;
}

// Discover which fractional-voxel axes are in-plane for the sagittal view by
// probing world +anterior (+Y) and +superior (+Z). Orientation-agnostic — works
// for RAS, PIR, or any affine, so the overlay tracks the volume's real axes.
function computePlaneMap() {
  planeMap = null;
  const o = current?.geometry?.plane_origin;
  if (!o) return;
  let f0, fa, fs;
  try {
    f0 = nv.mm2frac(o);
    fa = nv.mm2frac([o[0], o[1] + 20, o[2]]);
    fs = nv.mm2frac([o[0], o[1], o[2] + 20]);
  } catch (e) { return; }
  const dA = fa.map((v, i) => v - f0[i]);
  const dS = fs.map((v, i) => v - f0[i]);
  const amax = Math.max(...dA.map(Math.abs));
  const smax = Math.max(...dS.map(Math.abs));
  const iH = dA.findIndex((v) => Math.abs(v) === amax);
  const iV = dS.findIndex((v) => Math.abs(v) === smax);
  // mm spanned by a full frac (0..1) along each in-plane axis -> physical extents,
  // used to aspect-fit the slice the way NiiVue letterboxes it into the tile.
  const mmH = Math.abs(dA[iH]) > 1e-6 ? 20 / Math.abs(dA[iH]) : 1;
  const mmV = Math.abs(dS[iV]) > 1e-6 ? 20 / Math.abs(dS[iV]) : 1;
  planeMap = { iH, iV, sH: Math.sign(dA[iH]) || 1, sV: Math.sign(dS[iV]) || 1, mmH, mmV };
}

function mmToPx(mm) {
  let f;
  try { f = nv.mm2frac(mm); } catch (e) { return null; }
  // Authoritative: NiiVue's own frac->canvas mapping (handles its layout/zoom/pan).
  if (typeof nv.frac2canvasPos === "function") {
    try {
      const p = nv.frac2canvasPos([f[0], f[1], f[2]]);
      if (p && isFinite(p[0]) && isFinite(p[1])) return [p[0], p[1]];
    } catch (e) { /* fall through to manual */ }
  }
  // Fallback: manual tile + aspect-fit (orientation-agnostic via planeMap).
  const tile = sagittalTile();
  if (!tile) return null;
  if (!planeMap) computePlaneMap();
  const [x, y, w, h] = tile.leftTopWidthHeight;
  let u, v, mmH = 1, mmV = 1;
  if (planeMap) {
    u = planeMap.sH > 0 ? f[planeMap.iH] : 1 - f[planeMap.iH];
    v = planeMap.sV > 0 ? f[planeMap.iV] : 1 - f[planeMap.iV];
    mmH = planeMap.mmH; mmV = planeMap.mmV;
  } else { u = f[1]; v = f[2]; }
  if (FLIP_H) u = 1 - u;
  if (FLIP_V) v = 1 - v;
  const sliceAR = mmH / mmV, tileAR = w / h;
  let dw = w, dh = h, ox = 0, oy = 0;
  if (sliceAR < tileAR) { dw = h * sliceAR; ox = (w - dw) / 2; }
  else { dh = w / sliceAR; oy = (h - dh) / 2; }
  return [x + ox + u * dw, y + oy + (1 - v) * dh];
}

// ---- overlay drawing ------------------------------------------------------
function syncOverlaySize() {
  const c = els.gl;
  if (els.overlay.width !== c.width || els.overlay.height !== c.height) {
    els.overlay.width = c.width; els.overlay.height = c.height;
  }
  // Position the overlay EXACTLY over NiiVue's gl canvas. NiiVue may size/letterbox
  // its canvas element so it doesn't fill the viewport; frac2canvasPos returns
  // gl-canvas pixels, so the overlay must cover the same on-screen box or the
  // construction shifts (the off-right HiDPI bug).
  const gr = c.getBoundingClientRect();
  const pr = els.overlay.offsetParent ? els.overlay.offsetParent.getBoundingClientRect()
                                      : { left: 0, top: 0 };
  const want = { left: gr.left - pr.left, top: gr.top - pr.top, w: gr.width, h: gr.height };
  const st = els.overlay.style;
  if (st.left !== want.left + "px") st.left = want.left + "px";
  if (st.top !== want.top + "px") st.top = want.top + "px";
  if (st.width !== want.w + "px") { st.width = want.w + "px"; st.right = "auto"; }
  if (st.height !== want.h + "px") { st.height = want.h + "px"; st.bottom = "auto"; }
}

function drawOverlay() {
  syncOverlaySize();
  ctx.clearRect(0, 0, els.overlay.width, els.overlay.height);
  if (!current) return;
  const cw = els.overlay.clientWidth;
  let dpr = cw > 0 ? els.overlay.width / cw : (window.devicePixelRatio || 1);
  if (!isFinite(dpr) || dpr <= 0) dpr = window.devicePixelRatio || 1;
  dpr = Math.min(4, Math.max(1, dpr));               // never Infinity / 0

  for (const a of current.geometry.angles) {
    const st = active.get(a.id);
    if (!st) continue;                             // only draw active overlays (Clear empties this)
    drawAngle(a, st.t, dpr);
  }
  if (DEBUG) drawDebugHud(dpr);
}

function drawDebugHud(dpr) {
  const tile = sagittalTile();
  const a0 = current.geometry.angles.find((x) => x.value != null);
  const px = (mm) => { const p = mmToPx(mm); return p ? `${p[0] | 0},${p[1] | 0}` : "null"; };
  const d = window.__dbg || {};
  const arr = (x) => x ? Array.from(x).map((n) => (+n).toFixed(1)).join(",") : "—";
  const ltwh = tile && tile.leftTopWidthHeight ? tile.leftTopWidthHeight.map((n) => (+n).toFixed(0)).join(",") : "—";
  const fc = a0 && typeof nv.frac2canvasPos === "function"
    ? (() => { try { const p = nv.frac2canvasPos(Array.from(nv.mm2frac(a0.segments[0][0]))); return `${p[0] | 0},${p[1] | 0}`; } catch (e) { return "err"; } })()
    : "n/a";
  const lines = [
    `dpr=${window.devicePixelRatio} gl=${els.gl.width}x${els.gl.height} client=${els.gl.clientWidth}x${els.gl.clientHeight} ov=${els.overlay.width}x${els.overlay.height}`,
    `seg0mm=${a0 ? a0.segments[0][0].join(",") : "-"} origin=${current.geometry.plane_origin.join(",")}`,
    `ltwh:${ltwh} ltMM:${arr(tile && tile.leftTopMM)} fov:${arr(tile && tile.fovMM)} fc(seg0)=${fc}`,
    `planeMap: ${planeMap ? `iH=${planeMap.iH} iV=${planeMap.iV}` : "NULL"}  frac0: ${a0 ? Array.from(nv.mm2frac(a0.segments[0][0])).map((n) => n.toFixed(2)).join(",") : "-"}`,
  ];
  if (a0) {
    a0.segments.forEach((s, i) => lines.push(`seg${i}: ${px(s[0])}  ->  ${px(s[1])}`));
    lines.push(`arc.center: ${px(a0.arc.center)}`);
    // big unmissable markers at every endpoint (stroked rings; fill doesn't render)
    ctx.save();
    ctx.strokeStyle = "#ff2d55"; ctx.lineWidth = 3 * dpr;
    const allpts = a0.segments.flat().concat([a0.arc.center]);
    for (const mm of allpts) {
      const p = mmToPx(mm);
      if (p) { ctx.beginPath(); ctx.arc(p[0], p[1], 9 * dpr, 0, 7); ctx.stroke(); }
    }
    ctx.restore();
  }
  document.title = "DBG " + lines.join(" || ");
  ctx.save();
  ctx.font = `${12 * dpr}px "IBM Plex Mono", monospace`;
  ctx.textAlign = "left"; ctx.textBaseline = "top";
  lines.forEach((t, i) => {
    const y = (8 + i * 16) * dpr;
    ctx.fillStyle = "rgba(0,0,0,.7)";
    ctx.fillRect(6 * dpr, y, ctx.measureText(t).width + 10 * dpr, 15 * dpr);
    ctx.fillStyle = "#36d399";
    ctx.fillText(t, 10 * dpr, y);
  });
  ctx.restore();
}

function lerp(p, q, t) { return [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]; }

// helpers in screen space (pixels are isotropic on this slice, so screen angles
// equal true angles)
function v2(a, b) { return [b[0] - a[0], b[1] - a[1]]; }
function v2u(v) { const n = Math.hypot(v[0], v[1]) || 1; return [v[0] / n, v[1] / n]; }

function strokeLine(p, q, color, w) {
  ctx.lineCap = "round";
  ctx.strokeStyle = "rgba(0,0,0,0.85)"; ctx.lineWidth = w + 3;
  ctx.beginPath(); ctx.moveTo(p[0], p[1]); ctx.lineTo(q[0], q[1]); ctx.stroke();
  ctx.strokeStyle = color; ctx.lineWidth = w;
  ctx.beginPath(); ctx.moveTo(p[0], p[1]); ctx.lineTo(q[0], q[1]); ctx.stroke();
}

// Draw a precomputed angle construction (world-mm segments + arc + label from
// metrics.json). Everything is fixed in WORLD space and just mapped to screen, so
// there is no screen-space re-derivation — the construction can't flip as you
// scroll slices. Segments animate (grow from p->q) with t.
function drawAngle(a, t, dpr) {
  if (!a || !Array.isArray(a.segments)) return;
  const lw = Math.max(3, 3.5 * dpr);
  // SOLID segments = the anatomical endplate line(s)
  for (const s of a.segments) {
    const p = mmToPx(s[0]), q = mmToPx(s[1]);
    if (!p || !q) continue;
    strokeLine(p, lerp(p, q, t), a.color, lw);
  }
  // DOTTED segments = reference/construction lines (HRL, VRL, perpendicular, radius)
  if (Array.isArray(a.dashed)) {
    ctx.setLineDash([6 * dpr, 5 * dpr]);
    for (const s of a.dashed) {
      const p = mmToPx(s[0]), q = mmToPx(s[1]);
      if (!p || !q) continue;
      strokeLine(p, lerp(p, q, t), a.color, Math.max(2, 2.2 * dpr));
    }
    ctx.setLineDash([]);
  }
  if (t < 1) return;
  // angle wedge: dotted arc at arc.center, from (center->a) to (center->b)
  if (a.arc) {
    const C = mmToPx(a.arc.center), A = mmToPx(a.arc.a), B = mmToPx(a.arc.b);
    if (C && A && B) {
      const ba = Math.atan2(A[1] - C[1], A[0] - C[0]);
      const bb = Math.atan2(B[1] - C[1], B[0] - C[0]);
      let dd = bb - ba; while (dd > Math.PI) dd -= 2 * Math.PI; while (dd < -Math.PI) dd += 2 * Math.PI;
      ctx.setLineDash([5 * dpr, 4 * dpr]);
      ctx.strokeStyle = a.color; ctx.lineWidth = Math.max(2, 2 * dpr);
      ctx.beginPath(); ctx.arc(C[0], C[1], 30 * dpr, ba, ba + dd, dd < 0); ctx.stroke();
      ctx.setLineDash([]);
    }
  }
  // value label
  const L = mmToPx(a.label_at);
  if (L) {
    const txt = `${a.id} ${a.value}${a.units}`;
    ctx.font = `${Math.max(14, 15 * dpr)}px "IBM Plex Mono", monospace`;
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.lineWidth = Math.max(3, 4 * dpr); ctx.strokeStyle = "rgba(0,0,0,0.92)";
    ctx.strokeText(txt, L[0], L[1]);
    ctx.fillStyle = a.color; ctx.fillText(txt, L[0], L[1]);
  }
}

function line(p, q) { ctx.beginPath(); ctx.moveTo(p[0], p[1]); ctx.lineTo(q[0], q[1]); ctx.stroke(); }
function dot(p, r) { ctx.beginPath(); ctx.arc(p[0], p[1], r, 0, 7); ctx.fill(); }
function label(txt, x, y, color, dpr) {
  ctx.font = `${13 * dpr}px "IBM Plex Mono", monospace`;
  const w = ctx.measureText(txt).width + 12 * dpr;
  ctx.shadowBlur = 0;
  ctx.fillStyle = "rgba(8,12,18,.85)";
  roundRect(x - w / 2, y - 11 * dpr, w, 22 * dpr, 5 * dpr); ctx.fill();
  ctx.fillStyle = color; ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.fillText(txt, x, y);
}
function roundRect(x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
}

// ---- animation ------------------------------------------------------------
const ANIM_MS = 480;

function animate(id) {
  const a = current?.geometry.angles.find((x) => x.id === id);
  if (!a || a.value == null) return;
  active.set(id, { t: 0, start: performance.now() });
  for (const b of els.metricBtns.children)
    b.classList.toggle("is-active", active.has(b.dataset.id));
}

// single render loop: advance any running animations, then redraw the overlay
// While any angle is shown, PIN the sagittal slice to the construction plane: the
// precomputed lines live on that one mid-sagittal plane, so the view must stay on it
// for the overlay to line up. Scrolling off-plane is what made PI/PT/LL look like
// they "moved"; here a scroll snaps back to the plane so the angles render stable.
function pinSliceToPlane() {
  if (!current || active.size === 0) return;
  const o = current.geometry && current.geometry.plane_origin;
  if (!o) return;
  try {
    if (!planeMap) computePlaneMap();
    const depth = planeMap ? (3 - planeMap.iH - planeMap.iV) : 0;  // sagittal-depth frac axis
    const pf = nv.mm2frac(o);
    const cp = nv.scene.crosshairPos;
    if (Math.abs(cp[depth] - pf[depth]) > 1e-4) {
      const nc = [cp[0], cp[1], cp[2]];
      nc[depth] = pf[depth];
      nv.scene.crosshairPos = nc;
      nv.drawScene();
    }
  } catch (e) { /* version drift */ }
}

function tick(now) {
  for (const st of active.values())
    if (st.t < 1) st.t = Math.min(1, (now - st.start) / ANIM_MS);
  pinSliceToPlane();
  drawOverlay();
  requestAnimationFrame(tick);
}

// ---- panel ----------------------------------------------------------------
function buildMetricButtons() {
  els.metricBtns.innerHTML = "";
  for (const a of current.geometry.angles) {
    const b = document.createElement("button");
    b.className = "metric"; b.dataset.id = a.id; b.style.borderLeftColor = a.color;
    b.style.color = a.color;
    b.disabled = a.value == null;
    b.title = a.value == null ? "needs v3 femur ground truth" : `render ${a.label}`;
    b.innerHTML = `<span class="metric__abbr">${a.id}</span>
      <span class="metric__name">${a.label}</span>
      <span class="metric__val">${a.value == null ? "—" : a.value + a.units}</span>`;
    b.onclick = () => animate(a.id);
    els.metricBtns.appendChild(b);
  }
}

function renderReport() {
  const s = current.summary, rows = [];
  const f = (v, u = "°") => (v == null ? '<span class="muted">n/a</span>' : `${v}${u}`);
  rows.push(["PI", f(s.PI)], ["SS", f(s.SS)], ["PT", f(s.PT)], ["LL", f(s.LL)]);
  if (s["PI-LL"]) rows.push(["PI − LL", f(s["PI-LL"].pi_minus_ll)]);
  els.report.innerHTML = rows.map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join("");
  if (s.schwab) {
    const g = (x) => `<span class="grade grade--${x === "++" ? 2 : x === "+" ? 1 : 0}">${x}</span>`;
    els.schwab.innerHTML =
      `<div><b>SRS-Schwab</b></div>
       <div>PI–LL ${g(s.schwab["PI-LL"])} · PT ${g(s.schwab.PT)}</div>
       <div>LL increase needed: <b>${s.schwab.ll_increase_needed_deg}°</b></div>`;
  } else {
    els.schwab.innerHTML =
      `<div class="muted">PI / SS / PT unlock once the case has femur GT (v3).
       LL is computed; full classification follows.</div>`;
  }
}

// ---- events ---------------------------------------------------------------
els.caseSel.onchange = (e) => loadCase(e.target.value);
els.toggleSeg.onclick = () => setSeg(!segOn);
els.segOpacity.oninput = () => { if (segOn) nv.setOpacity(segIdx, els.segOpacity.value / 100); };
els.clearMetrics.onclick = () => {
  active.clear(); nv.drawScene();
  for (const b of els.metricBtns.children) b.classList.remove("is-active");
};
document.querySelectorAll(".chip[data-wl]").forEach((c) =>
  (c.onclick = () => applyWL(c.dataset.wl)));
window.addEventListener("resize", () => { syncOverlaySize(); nv.drawScene(); });

loadManifest().catch((e) => {
  els.loading.textContent = "failed to load demo data — serve over HTTP (see index.html).";
  console.error(e);
});
