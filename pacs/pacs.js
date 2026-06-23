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
  phaseRow: document.getElementById("phaseRow"),
  phasePre: document.getElementById("phasePre"),
  phasePost: document.getElementById("phasePost"),
};

const ctx = els.overlay.getContext("2d");
let nv, current = null;            // current = parsed metrics.json
const active = new Map();          // angle id -> {t:0..1} animation state

// ---- NiiVue setup ---------------------------------------------------------
nv = new Niivue({
  backColor: [0, 0, 0, 1],
  show3Dcrosshair: false,
  crosshairColor: [0.18, 0.55, 0.5, 0.6],
  dragMode: 0,                     // NiiVue drag OFF — we own pan/zoom (below)
  isColorbar: false,
  sagittalNoseLeft: true,          // anterior points left, like a lateral film / Greenberg
});
nv.attachToCanvas(els.gl);
nv.setSliceType(SLICE_TYPE.SAGITTAL);
requestAnimationFrame(tick);       // continuous overlay sync (independent of NiiVue callbacks)

// Navigation: the CT and the overlay are ONE UNIT — the same CSS transform is applied
// to both canvases, so they pan/zoom together pixel-for-pixel (NiiVue renders at base;
// frac2canvasPos stays in base coords; the transform does the visual zoom/pan).
//   LEFT-drag vertical = zoom (up in / down out, L-R ignored)
//   RIGHT-drag         = pan in the drag direction
const view = { zoom: 1, panX: 0, panY: 0 };
els.gl.style.transformOrigin = "50% 50%";
els.overlay.style.transformOrigin = "50% 50%";
function applyView() {
  const tf = `translate(${view.panX}px, ${view.panY}px) scale(${view.zoom})`;
  els.gl.style.transform = tf;
  els.overlay.style.transform = tf;
}
function resetView() { view.zoom = 1; view.panX = 0; view.panY = 0; applyView(); }
// dragMode:0 means NiiVue ignores drags, so we DON'T block its events — leaving them
// through keeps NiiVue's wheel handler alive (scroll = slice). We only read the drag.
// Step the displayed slice by a frac amount (shared by wheel + 1-finger touch).
function stepSliceFrac(df) {
  if (!nv || !nv.scene || !nv.scene.crosshairPos) return;
  if (!planeMap) computePlaneMap();
  const depth = planeMap ? 3 - planeMap.iH - planeMap.iV : 0;
  const cp = nv.scene.crosshairPos;
  cp[depth] = Math.min(1, Math.max(0, cp[depth] + df));
  nv.drawScene();
}

// ---- touch (iOS / Android): 1 finger = scroll slices, 2 fingers = pinch-zoom + pan.
// Branches on pointerType so the desktop mouse mapping is untouched.
const touches = new Map();          // pointerId -> {x, y}
let pinch = null;                   // 2-finger baseline {dist, cx, cy, zoom, panX, panY}
const tList = () => [...touches.values()];
const tDist = () => { const [a, b] = tList(); return Math.hypot(a.x - b.x, a.y - b.y); };
const tMid = () => { const [a, b] = tList(); return [(a.x + b.x) / 2, (a.y + b.y) / 2]; };

let drag = null;
els.gl.addEventListener("contextmenu", (e) => e.preventDefault());
els.gl.addEventListener("pointerdown", (e) => {
  if (e.pointerType === "touch") {
    touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (touches.size === 2) {
      const m = tMid();
      pinch = { dist: tDist() || 1, cx: m[0], cy: m[1], zoom: view.zoom, panX: view.panX, panY: view.panY };
    }
    try { els.gl.setPointerCapture(e.pointerId); } catch (_) {}
    e.preventDefault();
    return;
  }
  drag = { pan: e.button === 2, x: e.clientX, y: e.clientY, moved: false,
           zoom: view.zoom, panX: view.panX, panY: view.panY };
  try { els.gl.setPointerCapture(e.pointerId); } catch (_) {}
  e.preventDefault();
});
els.gl.addEventListener("pointermove", (e) => {
  if (e.pointerType === "touch") {
    const p = touches.get(e.pointerId);
    if (!p) return;
    const prevY = p.y;
    p.x = e.clientX; p.y = e.clientY;
    if (touches.size >= 2 && pinch) {              // pinch -> zoom + 2-finger pan
      const m = tMid();
      view.zoom = Math.max(0.4, Math.min(12, pinch.zoom * (tDist() / pinch.dist)));
      view.panX = pinch.panX + (m[0] - pinch.cx);
      view.panY = pinch.panY + (m[1] - pinch.cy);
      applyView();
    } else if (touches.size === 1) {               // one finger -> scroll slices
      const h = els.gl.getBoundingClientRect().height || 1;
      stepSliceFrac((prevY - e.clientY) / h);      // finger up = advance
    }
    e.preventDefault();
    return;
  }
  if (!drag) return;
  if (Math.abs(e.clientX - drag.x) + Math.abs(e.clientY - drag.y) > 4) drag.moved = true;
  if (drag.pan) {                                  // RIGHT-drag -> pan
    view.panX = drag.panX + (e.clientX - drag.x);
    view.panY = drag.panY + (e.clientY - drag.y);
  } else {                                         // LEFT-drag up/down -> zoom
    view.zoom = Math.max(0.4, Math.min(12, drag.zoom * Math.exp((drag.y - e.clientY) * 0.005)));
  }
  applyView();
  e.preventDefault();
});
function endTouch(e) {
  touches.delete(e.pointerId);
  if (touches.size < 2) pinch = null;              // re-baseline on the next 2nd finger
}
els.gl.addEventListener("pointerup", (e) => {
  if (e.pointerType === "touch") { endTouch(e); e.preventDefault(); return; }
  if (drag && !drag.moved && !drag.pan) moveCrosshairTo(e.clientX, e.clientY);  // left CLICK
  drag = null;
});
els.gl.addEventListener("pointercancel", (e) => { if (e.pointerType === "touch") endTouch(e); });

// Left CLICK (no drag) localizes: move NiiVue's crosshair to the click point. The gl
// canvas is CSS-zoomed, so we invert the transform via its on-screen rect (linear)
// then NiiVue's canvasPos2frac. The slice-depth component is preserved, so a click
// only moves the crosshair in-plane and never shifts the construction.
function moveCrosshairTo(clientX, clientY) {
  if (!nv || typeof nv.canvasPos2frac !== "function" || !nv.scene) return;
  const r = els.gl.getBoundingClientRect();
  if (r.width <= 0 || r.height <= 0) return;
  const bx = (clientX - r.left) / r.width * els.gl.width;
  const by = (clientY - r.top) / r.height * els.gl.height;
  let frac;
  try { frac = nv.canvasPos2frac([bx, by]); } catch (_) { return; }
  if (!frac || frac[0] < 0 || frac[1] < 0 || frac[2] < 0) return;   // outside the slice
  if (!planeMap) computePlaneMap();
  const depth = planeMap ? 3 - planeMap.iH - planeMap.iV : 0;
  const keep = nv.scene.crosshairPos[depth];
  nv.scene.crosshairPos = [frac[0], frac[1], frac[2]];
  nv.scene.crosshairPos[depth] = keep;             // stay on the current slice
  nv.drawScene();
}
// Scroll = slice. We handle the wheel ourselves (capture + stop) because once the gl
// canvas is CSS-zoomed, NiiVue's own wheel hit-test (getBoundingClientRect-based) is
// off and it ignores the scroll. This steps the slice directly, so it works at ANY
// zoom/pan and regardless of where the cursor is.
els.gl.addEventListener("wheel", (e) => {
  e.preventDefault(); e.stopImmediatePropagation();
  if (!planeMap) computePlaneMap();
  const depth = planeMap ? 3 - planeMap.iH - planeMap.iV : 0;
  const dims = (nv.back && nv.back.dims) || (nv.volumes[0] && nv.volumes[0].dims) || null;
  const n = dims && dims.length > depth + 1 ? dims[depth + 1] : 100;
  stepSliceFrac((e.deltaY > 0 ? 1 : -1) / Math.max(1, n));
}, { passive: false, capture: true });

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

let caseData = null, currentDir = null, phase = "preop";

async function loadCase(dir) {
  els.loading.style.display = "flex";
  currentDir = dir;
  caseData = await (await fetch(`data/${dir}/metrics.json`, { cache: "no-store" })).json();
  els.phaseRow.hidden = !caseData.postop;                  // toggle only when a post-op state exists
  const startPost = !!caseData.postop && location.hash === "#post";
  els.phasePre.classList.toggle("is-on", !startPost);
  els.phasePost.classList.toggle("is-on", startPost);
  await applyPhase(startPost ? "postop" : "preop");
}

// Show the pre-op case or its simulated post-op state (own volumes + construction).
async function applyPhase(p) {
  phase = p;
  const post = (p === "postop" && caseData.postop) ? caseData.postop : null;
  current = post
    ? { case_id: caseData.case_id, label: caseData.label, files: post.files,
        geometry: post.geometry, summary: post.summary,
        postop_plan: post.plan, preop_summary: post.preop_summary }
    : caseData;
  els.loading.style.display = "flex";
  active.clear();
  const base = `data/${currentDir}/`;
  const vols = [];
  if (current.files.ct) vols.push({ url: base + current.files.ct, colormap: "gray" });
  vols.push({ url: base + current.files.seg, colormap: "random",
              opacity: els.segOpacity.value / 100 });
  await nv.loadVolumes(vols);
  segIdx = current.files.ct ? 1 : 0;
  applyWL("bone");
  setSeg(true);
  resetView();
  centreOnConstruction();
  computePlaneMap();
  buildMetricButtons();
  for (const a of current.geometry.angles) {
    if (a.value != null) active.set(a.id, { t: 1, start: 0 });
  }
  for (const b of els.metricBtns.children) b.classList.toggle("is-active", active.has(b.dataset.id));
  renderReport();
  els.hudCase.textContent = (current.label || current.case_id) +
    (post ? "  ·  POST-OP (simulated)" : "");
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

// open on the spine's MEDIAL slice (L-R centre of the vertebral column), not the
// laterally-offset S1-endplate plane. The angle overlay is slice-independent, so it
// renders correctly here regardless.
function centreOnConstruction() {
  const g = current.geometry || {};
  const o = g.view_center || g.plane_origin;
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
  // Map by IN-PLANE position only: replace the slice-depth frac with the CURRENT
  // slice's depth, so a world point maps to its (anterior, superior) screen position
  // regardless of which sagittal slice is scrolled to. The construction lives on one
  // mid-sagittal plane; this pins it on screen while the bone scrolls underneath, and
  // it no longer "moves" as you scroll (the earlier off-plane drift). Curved/rotated
  // spines still need scrolling to view each level centred — which now works.
  try {
    if (!planeMap) computePlaneMap();
    if (planeMap) {
      const depth = 3 - planeMap.iH - planeMap.iV;
      f = [f[0], f[1], f[2]];
      f[depth] = nv.scene.crosshairPos[depth];
    }
  } catch (e) { /* keep raw frac */ }
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
  // Position the overlay over the gl canvas's BASE (untransformed) box — NiiVue
  // letterboxes the gl canvas, so the box must be measured, not assumed. The SAME
  // pan/zoom transform is then applied to both (applyView), keeping them ONE UNIT
  // without double-applying (we measure with the gl transform momentarily removed).
  const savedT = c.style.transform;
  c.style.transform = "none";
  const gr = c.getBoundingClientRect();
  c.style.transform = savedT;
  const pr = els.overlay.offsetParent ? els.overlay.offsetParent.getBoundingClientRect()
                                      : { left: 0, top: 0 };
  const st = els.overlay.style;
  const L = (gr.left - pr.left) + "px", T = (gr.top - pr.top) + "px";
  const W = gr.width + "px", H = gr.height + "px";
  if (st.left !== L) st.left = L;
  if (st.top !== T) st.top = T;
  if (st.width !== W) { st.width = W; st.right = "auto"; }
  if (st.height !== H) { st.height = H; st.bottom = "auto"; }
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
  // rules on top, so midpoint dots/measurements aren't hidden under another line
  for (const a of current.geometry.angles) {
    const st = active.get(a.id);
    if (st && st.t >= 1) drawRule(a, dpr);
  }
  drawLabels(dpr);                                  // value labels, globally decluttered
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
      ctx.beginPath(); ctx.arc(C[0], C[1], arcRadiusPx(a, C, dpr), ba, ba + dd, dd < 0); ctx.stroke();
      ctx.setLineDash([]);
    }
  }
  // value label is drawn later, in a global declutter pass (drawLabels)
}

// Arc radius in screen px. Prefer arc_r_mm (world mm projected through the current
// view) so the wedge scales with the anatomy/zoom and never balloons on a small
// (mobile) render; fall back to the legacy fixed-pixel arc_r_px.
function arcRadiusPx(a, Cpx, dpr) {
  if (a.arc_r_mm && a.arc && a.arc.center && a.arc.a && Cpx) {
    const c = a.arc.center, m = a.arc.a;
    const dx = m[0] - c[0], dy = m[1] - c[1], dz = m[2] - c[2];
    const L = Math.hypot(dx, dy, dz) || 1;
    const tip = mmToPx([c[0] + dx / L * a.arc_r_mm, c[1] + dy / L * a.arc_r_mm,
                        c[2] + dz / L * a.arc_r_mm]);
    if (tip) return Math.hypot(tip[0] - Cpx[0], tip[1] - Cpx[1]);
  }
  return (a.arc_r_px || 30) * dpr;
}

// closest point on segment AB to point P (screen px)
function closestOnSeg(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
  let t = L2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / L2 : 0;
  t = Math.max(0, Math.min(1, t));
  return [ax + t * dx, ay + t * dy];
}

// Dynamic anti-overlap: push label boxes apart from EACH OTHER and away from the
// construction LINES/ARCS (obstacles), with a weak spring to each label's anchor.
// The spring is released for the final iterations so clearance converges even if a
// label has to travel far to find clear space (readability > staying near the line).
function declutter(boxes, obstacles, dpr) {
  const pad = 4 * dpr, clr = 10 * dpr;
  for (let it = 0; it < 140; it++) {
    let moved = false;
    for (let i = 0; i < boxes.length; i++) {          // label vs label
      for (let j = i + 1; j < boxes.length; j++) {
        const A = boxes[i], B = boxes[j];
        const dx = B.x - A.x, dy = B.y - A.y;
        const ox = (A.hw + B.hw + pad) - Math.abs(dx);
        const oy = (A.hh + B.hh + pad) - Math.abs(dy);
        if (ox > 0 && oy > 0) {
          moved = true;
          if (ox <= oy) { const p = ox / 2 * (dx < 0 ? -1 : 1); A.x -= p; B.x += p; }
          else { const p = oy / 2 * (dy < 0 ? -1 : 1); A.y -= p; B.y += p; }
        }
      }
    }
    for (const b of boxes) {                          // label vs lines/arcs
      for (const s of obstacles) {
        const c = closestOnSeg(b.x, b.y, s[0], s[1], s[2], s[3]);
        const dx = b.x - c[0], dy = b.y - c[1];
        const ox = (b.hw + clr) - Math.abs(dx), oy = (b.hh + clr) - Math.abs(dy);
        if (ox > 0 && oy > 0) {                        // closest point inside the box -> push out
          moved = true;
          if (ox <= oy) b.x += (dx < 0 ? -1 : 1) * ox;
          else b.y += (dy < 0 ? -1 : 1) * oy;
        }
      }
    }
    if (it < 90) for (const b of boxes) {             // spring back early; release late
      b.x += (b.x0 - b.x) * 0.04; b.y += (b.y0 - b.y) * 0.04;
    } else if (!moved) break;
  }
}

function drawLabels(dpr) {
  const fs = Math.max(14, 15 * dpr);
  ctx.font = `${fs}px "IBM Plex Mono", monospace`;
  const boxes = [], obstacles = [];
  for (const a of current.geometry.angles) {
    const st = active.get(a.id);
    if (!st || st.t < 1) continue;
    const addSeg = (s) => { const p = mmToPx(s[0]), q = mmToPx(s[1]); if (p && q) obstacles.push([p[0], p[1], q[0], q[1]]); };
    (a.segments || []).forEach(addSeg);
    (a.dashed || []).forEach(addSeg);
    if (a.arc) {                                       // sample the arc into short segments
      const C = mmToPx(a.arc.center), A = mmToPx(a.arc.a), B = mmToPx(a.arc.b);
      if (C && A && B) {
        const r = arcRadiusPx(a, C, dpr);
        let ba = Math.atan2(A[1] - C[1], A[0] - C[0]);
        let dd = Math.atan2(B[1] - C[1], B[0] - C[0]) - ba;
        while (dd > Math.PI) dd -= 2 * Math.PI; while (dd < -Math.PI) dd += 2 * Math.PI;
        let prev = null;
        for (let k = 0; k <= 6; k++) {
          const ang = ba + dd * k / 6, pt = [C[0] + r * Math.cos(ang), C[1] + r * Math.sin(ang)];
          if (prev) obstacles.push([prev[0], prev[1], pt[0], pt[1]]);
          prev = pt;
        }
      }
    }
    if (!a.label_at) continue;
    const L = mmToPx(a.label_at);
    if (!L) continue;
    const txt = `${a.id} ${a.value}${a.units}`;
    boxes.push({ txt, color: a.color, x: L[0], y: L[1], x0: L[0], y0: L[1],
                 hw: ctx.measureText(txt).width / 2 + 2 * dpr, hh: fs / 2 + 2 * dpr });
  }
  declutter(boxes, obstacles, dpr);
  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.lineWidth = Math.max(3, 4 * dpr);
  for (const b of boxes) {
    const x = Math.min(els.overlay.width - b.hw, Math.max(b.hw, b.x));
    const y = Math.min(els.overlay.height - b.hh, Math.max(b.hh, b.y));
    ctx.strokeStyle = "rgba(0,0,0,0.92)"; ctx.strokeText(b.txt, x, y);
    ctx.fillStyle = b.color; ctx.fillText(b.txt, x, y);
  }
}

// "1/2 + 1/2" rule: endpoint/midpoint dots + half-length callouts on the endplate.
// Drawn in a SEPARATE pass on top of every construction so another line (e.g. the
// LL line over the S1 endplate) can't cover the midpoint measurements.
function drawDoubleArrow(p, q, color, dpr) {
  ctx.strokeStyle = color; ctx.lineWidth = Math.max(1.5, 1.8 * dpr); ctx.setLineDash([]);
  ctx.beginPath(); ctx.moveTo(p[0], p[1]); ctx.lineTo(q[0], q[1]); ctx.stroke();
  const ah = 6 * dpr;
  for (const [from, to] of [[q, p], [p, q]]) {       // arrowhead at each end
    const ang = Math.atan2(to[1] - from[1], to[0] - from[0]);
    ctx.beginPath();
    ctx.moveTo(to[0], to[1]); ctx.lineTo(to[0] - ah * Math.cos(ang - 0.45), to[1] - ah * Math.sin(ang - 0.45));
    ctx.moveTo(to[0], to[1]); ctx.lineTo(to[0] - ah * Math.cos(ang + 0.45), to[1] - ah * Math.sin(ang + 0.45));
    ctx.stroke();
  }
}

function drawRule(a, dpr) {
  const r = a.rule;
  if (!r) return;
  // ONE midpoint dot
  if (r.mid) {
    const p = mmToPx(r.mid);
    if (p) {
      ctx.beginPath(); ctx.arc(p[0], p[1], 4 * dpr, 0, 7);
      ctx.fillStyle = a.color; ctx.fill();
      ctx.lineWidth = Math.max(1.5, 1.5 * dpr); ctx.strokeStyle = "rgba(0,0,0,0.85)"; ctx.stroke();
    }
  }
  // dotted perpendicular ticks at the half boundaries
  ctx.setLineDash([3 * dpr, 3 * dpr]);
  ctx.strokeStyle = a.color; ctx.lineWidth = Math.max(1.4, 1.5 * dpr);
  for (const t of r.ticks || []) {
    const p = mmToPx(t[0]), q = mmToPx(t[1]);
    if (p && q) { ctx.beginPath(); ctx.moveTo(p[0], p[1]); ctx.lineTo(q[0], q[1]); ctx.stroke(); }
  }
  ctx.setLineDash([]);
  // <-> arrow over each half + its length printed IN LINE with the arrow (rotated)
  ctx.font = `${Math.max(8, 8.5 * dpr)}px "IBM Plex Mono", monospace`;
  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  for (const s of r.spans || []) {
    const p = mmToPx(s.a), q = mmToPx(s.b);
    if (p && q) drawDoubleArrow(p, q, a.color, dpr);
    const L = s.label && mmToPx(s.label);
    if (L && p && q) {
      let ang = Math.atan2(q[1] - p[1], q[0] - p[0]);
      if (ang > Math.PI / 2) ang -= Math.PI;       // keep text upright
      else if (ang < -Math.PI / 2) ang += Math.PI;
      ctx.save();
      ctx.translate(L[0], L[1]); ctx.rotate(ang);
      ctx.lineWidth = Math.max(2, 3 * dpr); ctx.strokeStyle = "rgba(0,0,0,0.92)";
      ctx.strokeText(s.text, 0, 0);
      ctx.fillStyle = a.color; ctx.fillText(s.text, 0, 0);
      ctx.restore();
    }
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
function tick(now) {
  for (const st of active.values())
    if (st.t < 1) st.t = Math.min(1, (now - st.start) / ANIM_MS);
  drawOverlay();
  requestAnimationFrame(tick);
}

// ---- panel ----------------------------------------------------------------
const METRIC_ORDER = ["PI", "SS", "PT", "LL"];   // match the Report's order

function buildMetricButtons() {
  els.metricBtns.innerHTML = "";
  const angles = [...current.geometry.angles].sort(
    (x, y) => (METRIC_ORDER.indexOf(x.id) + 1 || 99) - (METRIC_ORDER.indexOf(y.id) + 1 || 99));
  for (const a of angles) {
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
  if (s.PT_standing != null) rows.push(["PT (standing)", f(s.PT_standing)]);
  if (s["PI-LL"]) rows.push(["PI − LL", f(s["PI-LL"].pi_minus_ll)]);
  // post-op plan banner with the pre→post change
  let plan = "";
  if (current.postop_plan) {
    const p = current.postop_plan, pre = current.preop_summary || {};
    plan = `<tr class="planrow"><td colspan="2">Simulated ${String(p.technique).toUpperCase()} `
      + `${p.level} · ΔLL ${p.delta_deg}° &nbsp;|&nbsp; LL ${pre.LL}→${s.LL}° · `
      + `PI−LL ${pre["PI-LL"] ? pre["PI-LL"].pi_minus_ll : "?"}→${s["PI-LL"] ? s["PI-LL"].pi_minus_ll : "?"}°</td></tr>`;
  }
  els.report.innerHTML = plan + rows.map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join("");
  if (s.schwab) {
    const sw = s.schwab, pll = s["PI-LL"] || {}, obj = sw.objectives || {};
    const g = (x) => `<span class="grade grade--${x === "++" ? 2 : x === "+" ? 1 : 0}">${x}</span>`;
    const chk = (ok) => ok == null ? '<span class="muted">—</span>'
      : `<span class="grade grade--${ok ? 0 : 2}">${ok ? "✓" : "✗"}</span>`;
    const tgt = pll.ll_target_deg ? `${pll.ll_target_deg[0]}–${pll.ll_target_deg[1]}°` : "—";
    const rou = ({ "1-2": "1–2", "3": "3", "4": "4" })[s.roussouly] || s.roussouly || "—";
    const sg = s.surgery;
    const sevG = { mild: 0, moderate: 1, severe: 2 };
    const surgeryHTML = sg ? `
      <div class="sb-h"><b>Surgical planning</b> <span class="muted">Greenberg §73.7</span></div>
      <table class="sb">
        <tr><td>Lordosis to restore</td><td><b>${(+sg.ll_to_restore_deg).toFixed(1)}°</b></td>
            <td colspan="2" class="muted">ΔLL = (PI−LL−9)+(PT−20)</td></tr>
        <tr><td>Deformity</td>
            <td><span class="grade grade--${sevG[sg.severity] ?? 0}">${sg.severity}</span></td>
            <td colspan="2" class="muted">SRS-Schwab (Table 73.3)</td></tr>
      </table>
      <div class="rec"><b>Recommended:</b> ${sg.primary}.<br>
        <b>Fixation:</b> ${sg.fixation}.${sg.osteotomy ? ` <b>Osteotomy:</b> ${sg.osteotomy}.` : ""}</div>` : "";
    els.schwab.innerHTML = `
      <div class="sb-h"><b>SRS-Schwab</b> <span class="muted">sagittal modifier · grade 0 / + / ++</span></div>
      <table class="sb">
        <tr><td>PI–LL</td><td>${f(pll.pi_minus_ll)}</td><td>${g(sw["PI-LL"])}</td>
            <td class="muted">0:&lt;10 · +:10–20 · ++:&gt;20</td></tr>
        <tr><td>PT</td><td>${f(s.PT)}</td><td>${g(sw.PT)}</td>
            <td class="muted">0:&lt;20 · +:20–30 · ++:&gt;30</td></tr>
      </table>
      <div class="sb-h"><b>Alignment targets</b> <span class="muted">Greenberg §73.6</span></div>
      <table class="sb">
        <tr><td>LL = PI ± 9°</td><td>${tgt}</td><td>${chk(obj["LL=PI±9°"])}</td>
            <td class="muted">LL ${f(s.LL)}</td></tr>
        <tr><td>PT &lt; 20°</td><td></td><td>${chk(obj["PT<20°"])}</td>
            <td class="muted">PT ${f(s.PT)}</td></tr>
        <tr><td>ΔLL to target</td><td><b>${sw.ll_increase_needed_deg}°</b></td>
            <td colspan="2" class="muted">lordosis to restore (Eq. 73.1)</td></tr>
      </table>
      <div class="sb-h"><b>Morphotype</b></div>
      <div class="muted">PI ${f(s.PI)} (${s.pi_category || "—"}) · Roussouly ${rou}
        <span title="SS alone cannot split type 1 vs 2">(by SS ${f(s.SS)})</span></div>
      ${surgeryHTML}`;
  } else {
    els.schwab.innerHTML =
      `<div class="muted">PI / SS / PT unlock once the case has femur GT (v3).
       LL is computed; full classification follows.</div>`;
  }
}

// ---- events ---------------------------------------------------------------
els.caseSel.onchange = (e) => loadCase(e.target.value);
els.phasePre.onclick = () => {
  if (phase === "preop") return;
  els.phasePre.classList.add("is-on"); els.phasePost.classList.remove("is-on");
  applyPhase("preop");
};
els.phasePost.onclick = () => {
  if (phase === "postop" || !caseData || !caseData.postop) return;
  els.phasePost.classList.add("is-on"); els.phasePre.classList.remove("is-on");
  applyPhase("postop");
};
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
