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
});
nv.attachToCanvas(els.gl);
nv.setSliceType(SLICE_TYPE.SAGITTAL);
requestAnimationFrame(tick);       // continuous overlay sync (independent of NiiVue callbacks)

// ---- data -----------------------------------------------------------------
async function loadManifest() {
  const m = await (await fetch("data/manifest.json")).json();
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
  current = await (await fetch(`data/${dir}/metrics.json`)).json();
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
  buildMetricButtons();
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

function mmToPx(mm) {
  const tile = sagittalTile();
  if (!tile) return null;
  let f;
  try { f = nv.mm2frac(mm); } catch (e) { return null; }
  const [x, y, w, h] = tile.leftTopWidthHeight;
  // NiiVue device px -> overlay (canvas sized to device px below)
  const px = x + f[1] * w;
  const py = y + (1 - f[2]) * h;
  return [px, py];
}

// ---- overlay drawing ------------------------------------------------------
function syncOverlaySize() {
  const c = els.gl;
  if (els.overlay.width !== c.width || els.overlay.height !== c.height) {
    els.overlay.width = c.width; els.overlay.height = c.height;
  }
}

function drawOverlay() {
  syncOverlaySize();
  ctx.clearRect(0, 0, els.overlay.width, els.overlay.height);
  if (!current) return;
  const dpr = els.overlay.width / els.overlay.clientWidth || 1;
  for (const a of current.geometry.angles) {
    const st = active.get(a.id);
    if (!st) continue;
    drawAngle(a, st.t, dpr);
  }
}

function lerp(p, q, t) { return [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]; }

function drawAngle(a, t, dpr) {
  const V = mmToPx(a.vertex), T1 = mmToPx(a.tip1), T2 = mmToPx(a.tip2);
  if (!V || !T1 || !T2) return;
  const e1 = lerp(V, T1, t), e2 = lerp(V, T2, t);
  ctx.save();
  ctx.lineWidth = 2.2 * dpr; ctx.strokeStyle = a.color; ctx.fillStyle = a.color;
  ctx.lineCap = "round";
  ctx.shadowColor = "rgba(0,0,0,.8)"; ctx.shadowBlur = 4 * dpr;
  // rays
  line(V, e1); line(V, e2);
  // landmark dots
  dot(V, 3.4 * dpr);
  if (t >= 1) { dot(T1, 2.6 * dpr); dot(T2, 2.6 * dpr); }
  // arc + label once fully drawn
  if (t >= 1) {
    const a1 = Math.atan2(T1[1] - V[1], T1[0] - V[0]);
    const a2 = Math.atan2(T2[1] - V[1], T2[0] - V[0]);
    const r = 26 * dpr;
    ctx.beginPath();
    ctx.lineWidth = 1.4 * dpr;
    ctx.arc(V[0], V[1], r, Math.min(a1, a2), Math.max(a1, a2));
    ctx.stroke();
    const mid = (a1 + a2) / 2;
    const lx = V[0] + Math.cos(mid) * (r + 22 * dpr);
    const ly = V[1] + Math.sin(mid) * (r + 22 * dpr);
    label(`${a.id} ${a.value}${a.units}`, lx, ly, a.color, dpr);
  }
  ctx.restore();
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
