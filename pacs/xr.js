/*
  OpenSpineConsortium — lateral-radiograph tab of the spinopelvic demo.

  Two panes share one overlay renderer:

    REFERENCE  a DRR of the CT case the other tab shows in 3-D, with ostk's own
               constructions and landmarks (pacs/tools/export_xr_demo_case.py).
               geometry.space = "image_px", used verbatim in the svg viewBox.

    USER       whatever film you drop or paste, with landmarks predicted here in the
               browser by pacs/infer.js. Its detections are converted into the SAME
               shape the reference bundle uses, so a single draw path serves both --
               and the two panes cannot drift apart in how they present a number.

  Nothing is uploaded. The user pane's image is read with createImageBitmap and lives
  only in this tab.
*/

import { SpineDetector, KPT_LABEL, assignLevels, suggestRegion, computeAngles,
         angleToHorizontal } from "./infer.js?v=20260911b";

const XR_BUILD = "20260826a";
// ONE MODEL. YOLO11m-Pose at 1024, converted to float16: 42 MB against the 84 MB
// the fp32 graph would cost, and verified against that graph to find the same
// vertebrae. Apple GPUs execute fp16 natively, so this is also the fastest form on
// a Mac or an iPhone, where WebGPU runs on Metal.
//
// int8 was tried first and REJECTED. At 22 MB it was tempting, but it changed the
// detection COUNT on 15 of 40 test films, and the level chain is positional: one
// lost vertebra renames every level above it. A quarter of the download is not
// worth a model that silently miscounts.
// v4 (detect_v4, best epoch 126 of 156, early-stopped). Chosen over v3 on a head-to-head
// over the SAME held-out test split -- 87 films, 558 instances -- because each run's own
// validation numbers were selected on its own split and are not comparable:
//
//                 AP50      PCK@0.1    PCK@0.2
//     v3         0.9800      0.8335     0.9512
//     v4         0.9691      0.8475     0.9588
//
// v4 places corners better on every source (film .828->.841, standing DR .840->.855,
// BUU .850->.867, Mendeley .839->.854) and finds about one percent fewer. Corners are
// what this page draws and measures angles from, so that is the trade taken. Roll back by
// pointing this at v11m_1024_fp16.onnx, which is still served.
//
// The fp16 cast was re-checked for THIS model rather than assumed from v3's: no change in
// detection count on 12 test films, median corner drift 0.21 px, and PCK identical to
// fp32 to within one corner in 328. src/export_onnx.py in the spine-detector repo.
//
// The filename carries the version because Pages caches models/ hard; overwriting in
// place leaves returning visitors on the old weights with no way to tell.
const MODEL_URL = "models/v11m_1024_v4_fp16.onnx";
const MODEL_IMGSZ = 1024;

const $ = id => document.getElementById(id);
const els = {
  img: $("xrimg"), overlay: $("overlay"), caseSel: $("caseSel"), hudCase: $("hudCase"),
  metrics: $("metricBtns"), clear: $("clearMetrics"), metricSrc: $("metricSrc"),
  lmList: $("lmList"), lmNote: $("lmNote"),
  loading: $("loading"), empty: $("emptyState"),
  uimg: $("uimg"), uoverlay: $("uoverlay"), hudUser: $("hudUser"),
  dropzone: $("dropzone"), dropPrompt: $("dropPrompt"), dragveil: $("dragveil"),
  fileInput: $("fileInput"), pickBtn: $("pickBtn"), clearUser: $("clearUser"),
  uloading: $("uloading"), uloadtxt: $("uloadtxt"),
  engine: $("engineBadge"), timing: $("timing"),
  confRange: $("confRange"), confVal: $("confVal"),
  regionSel: $("regionSel"), regionNote: $("regionNote"), modelName: $("modelName"),
  camBtn: $("camBtn"), camInput: $("camInput"), camWrap: $("camWrap"),
  camVideo: $("camVideo"), camShoot: $("camShoot"), camCancel: $("camCancel"),
  modeSel: $("modeSel"),
  flipBtn: $("flipBtn"), paneRef: $("paneRef"), paneUser: $("paneUser"), tip: $("tip"),
};

/* A "view" is everything a pane needs to draw: the pixel grid, the constructions and
   the landmarks. The reference view is parsed from metrics.json; the user view is
   built from detections. Same fields, same renderer. */
const view = { ref: null, user: null };
const active = { ref: new Map(), user: new Map() };
let panelSrc = "ref";

/* ── svg ─────────────────────────────────────────────────────────────────────
   The svg's viewBox IS the image's pixel grid and it shares the image's box, so a
   point is used verbatim. This replaced a canvas + hand-rolled letterbox mapping,
   which is exactly where the overlay kept failing to line up. */
const SVGNS = "http://www.w3.org/2000/svg";
const el = (tag, attrs) => {
  const n = document.createElementNS(SVGNS, tag);
  for (const k in attrs) if (attrs[k] != null) n.setAttribute(k, attrs[k]);
  return n;
};

/* Stroke widths and type are in viewBox units, so they must scale with the grid or a
   743x1200 DRR draws hairlines where a 260x420 one drew a 3 px rule. Scaling by H
   makes the DISPLAYED width identical at any source resolution. */
const kOf = v => v.shape[0] / 420;

function strokePath(d, color, w, dash) {
  const halo = el("path", { d, class: "halo", "stroke-width": w + 2.5,
                            "stroke-dasharray": dash });
  const line = el("path", { d, class: "seg", stroke: color, "stroke-width": w,
                            "stroke-dasharray": dash });
  return [halo, line];
}

function drawAngle(a, g, k) {
  const seg = (p, q) => `M${p[0]},${p[1]} L${q[0]},${q[1]}`;
  const poly = pts => pts.map((p, i) => `${i ? "L" : "M"}${p[0]},${p[1]}`).join(" ");
  for (const s of a.segments || [])
    strokePath(seg(s[0], s[1]), a.color, 2.6 * k).forEach(n => g.appendChild(n));
  for (const s of a.dashed || [])
    strokePath(seg(s[0], s[1]), a.color, 1.8 * k, `${5 * k} ${4 * k}`)
      .forEach(n => g.appendChild(n));
  if (Array.isArray(a.arc) && a.arc.length > 1)     // the wedge -- makes it read as an angle
    strokePath(poly(a.arc), a.color, 1.8 * k, `${4 * k} ${3 * k}`)
      .forEach(n => g.appendChild(n));
  if (Array.isArray(a.leader) && a.leader.length === 2)
    strokePath(seg(a.leader[0], a.leader[1]), a.color, 1.1 * k, `${3 * k} ${4 * k}`)
      .forEach(n => { n.setAttribute("opacity", ".55"); g.appendChild(n); });
  if (a.label_at) {
    const t = el("text", { x: a.label_at[0], y: a.label_at[1], fill: a.color,
                           "font-size": 13 * k,
                           "stroke-width": 4 * k,
                           "text-anchor": a.label_anchor || "start",
                           "dominant-baseline": "middle" });
    t.textContent = `${a.id} ${a.value}${a.units || "°"}`;
    g.appendChild(t);
  }
}

/* ── landmarks ────────────────────────────────────────────────────────────── */

const LM_COLOR = { sup_anterior: "#34d399", sup_posterior: "#60a5fa",
                   sup_ant: "#34d399", sup_post: "#60a5fa",
                   inf_ant: "#fbbf24", inf_post: "#f472b6", hip_axis: "#f472b6" };

function drawLandmarks(svg, v, which) {
  const k = kOf(v);
  const g = el("g", { class: "lmk" });
  for (const L of v.landmarks || []) {
    const [x, y] = L.xy;
    const c = L.color || LM_COLOR[L.cls] || "#e6edf5";
    g.appendChild(el("circle", { cx: x, cy: y, r: 5.2 * k, class: "lm__ring",
                                 stroke: c, "stroke-width": 2 * k }));
    g.appendChild(el("circle", { cx: x, cy: y, r: 1.3 * k, fill: c }));
    // A generous transparent hit target: the visible ring is deliberately small so it
    // does not hide the corner it is marking, which makes it a poor thing to aim at.
    const hit = el("circle", { cx: x, cy: y, r: 13 * k, fill: "transparent",
                               class: "lm__hit", "data-id": L.id });
    hit.addEventListener("pointerenter", e => { showTip(e, L); highlightRow(which, L.id, true); });
    hit.addEventListener("pointerleave", () => { hideTip(); highlightRow(which, L.id, false); });
    g.appendChild(hit);
  }
  svg.appendChild(g);
}

/* KEEP THE NUMBERS ON THE FILM. The viewBox is the image's pixel grid, so anything drawn
   outside it is cut off by the edge of the pane -- and the angle labels were placed just
   beyond the film on purpose, to keep the value off the anatomy it measures. Off the film
   turns out to mean off the screen.

   Clamping needs the text's own width, because a label anchored "end" grows leftward from
   its x and one anchored "start" grows rightward; clamping the anchor point alone moves the
   wrong edge. 0.62em per character is the usual average for a proportional face and is
   close enough for a five-character number.

   The leader is then re-aimed from whichever edge of the text faces the construction, or it
   is drawn straight through the number it points from. */
function clampLabels(v, k) {
  const W = v.shape[1], H = v.shape[0], pad = 4 * k;
  return (v.angles || []).map((a) => {
    if (!a.label_at) return a;
    const anchor = a.label_anchor || "start";
    const tw = 0.62 * 13 * k * `${a.id} ${a.value}${a.units || "°"}`.length;
    let [x, y] = a.label_at;
    const edges = () => (anchor === "end" ? [x - tw, x] : [x, x + tw]);
    let [l, r] = edges();
    if (l < pad) x += pad - l;
    else if (r > W - pad) x += W - pad - r;
    y = Math.min(Math.max(y, 10 * k), H - 8 * k);
    if (x === a.label_at[0] && y === a.label_at[1]) return a;
    [l, r] = edges();
    const out = { ...a, label_at: [x, y] };
    if (Array.isArray(a.leader) && a.leader.length === 2) {
      const to = a.leader[1];
      out.leader = [to[0] >= r ? [r + pad, y] : [l - pad, y], to];
    }
    return out;
  });
}

/** Size a pane for the film it is showing.
 *
 *  A pane is wider than it is tall; a standing full-length film is the opposite. Fitting
 *  such a film to the pane's HEIGHT renders it as a sliver whose vertebrae cannot be
 *  read, and leaves nothing to scroll because the whole image is, technically, on
 *  screen. Past roughly 1:1.6 the film is therefore sized to the pane's width and the
 *  viewport scrolls instead. The overlay follows: .xrsvg sits inset over .xrwrap and
 *  carries a viewBox, so it scales with its box. */
const TALL_AR = 1.6;
function fitPane(which, shape) {
  const vp = (which === "ref" ? els.overlay : els.uoverlay)?.closest(".viewport");
  if (!vp || !shape) return;
  const [h, w] = shape;
  vp.classList.toggle("is-tall", w > 0 && h / w > TALL_AR);
}

function draw(which) {
  const v = view[which];
  const svg = which === "ref" ? els.overlay : els.uoverlay;
  svg.innerHTML = "";
  if (!v) return;
  svg.setAttribute("viewBox", `0 0 ${v.shape[1]} ${v.shape[0]}`);
  fitPane(which, v.shape);
  const k = kOf(v);
  for (const a of clampLabels(v, k)) {
    if (!active[which].has(a.id)) continue;
    const g = el("g", {});
    drawAngle(a, g, k);
    svg.appendChild(g);
  }
  if (v.landmarks?.length) drawLandmarks(svg, v, which);
}

/* ── tooltip ─────────────────────────────────────────────────────────────── */

function showTip(e, L) {
  els.tip.innerHTML = `<b>${L.label}</b>` + (L.desc ? `<span>${L.desc}</span>` : "")
    + (L.conf != null ? `<span class="tip__k">confidence ${L.conf.toFixed(2)}</span>` : "");
  els.tip.hidden = false;
  const r = els.tip.getBoundingClientRect();
  const x = Math.min(e.clientX + 16, window.innerWidth - r.width - 12);
  const y = Math.min(e.clientY + 16, window.innerHeight - r.height - 12);
  els.tip.style.transform = `translate(${x}px, ${y}px)`;
}
const hideTip = () => { els.tip.hidden = true; };

function highlightRow(which, id, on) {
  if (panelSrc !== which) return;
  const row = els.lmList.querySelector(`[data-id="${CSS.escape(id)}"]`);
  if (row) row.classList.toggle("is-hot", on);
}

/* ── panel ───────────────────────────────────────────────────────────────── */

function renderPanel() {
  const v = view[panelSrc];
  els.metrics.innerHTML = "";
  els.lmList.innerHTML = "";
  if (!v) return;

  els.metricSrc.textContent = panelSrc === "ref"
    ? "Reference case — click a parameter to toggle it."
    : "Your radiograph — measured from the predicted corners.";

  for (const a of v.angles || []) {
    const b = document.createElement("button");
    b.className = "metric";
    b.innerHTML = `<span class="metric__k">${a.id}</span>`
                + `<span class="metric__v">${a.value}${a.units || "°"}</span>`;
    b.style.setProperty("--c", a.color);
    b.dataset.id = a.id;
    b.classList.toggle("is-on", active[panelSrc].has(a.id));
    b.onclick = () => toggle(panelSrc, a.id);
    els.metrics.appendChild(b);
  }
  for (const id of v.unavailable || []) {
    const b = document.createElement("button");
    b.className = "metric";
    b.disabled = true;
    b.innerHTML = `<span class="metric__k">${id}</span>`
                + `<span class="metric__v muted">n/a</span>`;
    els.metrics.appendChild(b);
  }

  for (const L of v.landmarks || []) {
    const r = document.createElement("div");
    r.className = "lmrow";
    r.dataset.id = L.id;
    r.innerHTML = `<i style="background:${L.color || LM_COLOR[L.cls] || "#e6edf5"}"></i>`
                + `<span class="lmrow__k">${L.level || ""}</span>`
                + `<span class="lmrow__n">${L.cls}</span>`;
    r.title = L.label;
    r.onmouseenter = () => flashMarker(panelSrc, L.id, true);
    r.onmouseleave = () => flashMarker(panelSrc, L.id, false);
    els.lmList.appendChild(r);
  }
  els.lmNote.textContent = v.lmNote
    || "Four corners per vertebra, in the order the model predicts them. Hover a row to find it on the film.";
}

function flashMarker(which, id, on) {
  const svg = which === "ref" ? els.overlay : els.uoverlay;
  const hit = svg.querySelector(`.lm__hit[data-id="${CSS.escape(id)}"]`);
  if (hit) hit.previousElementSibling?.previousElementSibling
              ?.classList.toggle("is-hot", on);
}

function toggle(which, id) {
  if (active[which].has(id)) active[which].delete(id); else active[which].set(id, true);
  [...els.metrics.children].forEach(b => b.dataset.id
    && b.classList.toggle("is-on", active[which].has(b.dataset.id)));
  draw(which);
}

function focusPane(which) {
  if (panelSrc === which || !view[which]) return;
  panelSrc = which;
  els.paneRef.classList.toggle("is-focus", which === "ref");
  els.paneUser.classList.toggle("is-focus", which === "user");
  renderPanel();
}

/* ── reference case ──────────────────────────────────────────────────────── */

function showImage(node, src) {
  return new Promise((res, rej) => {
    node.onload = () => res();
    node.onerror = () => rej(new Error("image not found"));
    node.src = src;
  });
}

async function loadCase(dir) {
  els.loading.hidden = false;
  active.ref.clear();
  try {
    const m = await (await fetch(`data/xr/${dir}/metrics.json?v=${XR_BUILD}`,
                                 { cache: "no-store" })).json();
    if (!m.geometry || m.geometry.space !== "image_px")
      throw new Error(`geometry.space must be "image_px"`);
    await showImage(els.img, `data/xr/${dir}/${m.image || "image.png"}?v=${XR_BUILD}`);
    const net = m.geometry.net || null;
    view.ref = {
      shape: m.geometry.drr.shape,
      angles: m.geometry.angles,
      landmarks: m.geometry.landmarks || [],
      net,
      imageUrl: `data/xr/${dir}/${m.image || "image.png"}?v=${XR_BUILD}`,
      lmNote: net
        ? `Corners predicted by ${net.model} on this synthetic radiograph, and every angle `
          + `measured from those corners by ostk — one chain, so the endplate drawn is the `
          + `line the angle was taken from. The femoral head is the exception: a sphere `
          + `fitted in the CT, which no lateral model predicts, and which is why this pane `
          + `can show PI and PT where a dropped film cannot. Precomputed for speed; change `
          + `the model, confidence or mode above to re-run the network here.`
        : "Derived in 3-D from the segmentation and projected — not read off the "
          + "2-D silhouette. Hover a marker for its definition.",
    };
    /* kept so a re-infer can be reverted without another fetch */
    view.refBundle = { landmarks: view.ref.landmarks, lmNote: view.ref.lmNote };
    view.ref.angles.forEach(a => active.ref.set(a.id, true));
    els.hudCase.textContent = m.title || m.case_id || dir;
    els.empty.hidden = true;
    if (panelSrc === "ref") renderPanel();
    draw("ref");
  } catch (e) {
    view.ref = null;
    els.empty.hidden = false;
    els.empty.querySelector(".empty__msg").textContent =
      `Could not load “${dir}”: ${e.message}`;
    renderPanel();
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
      els.empty.hidden = false;
      els.empty.querySelector(".empty__msg").textContent =
        "No reference bundle yet — build one with pacs/tools/export_xr_demo_case.py.";
      return;
    }
    await loadCase(cases[0].dir);
  } catch {
    els.empty.hidden = false;
    els.empty.querySelector(".empty__msg").textContent = "data/xr/manifest.json not found.";
  }
}

/* ── user pane : constructions from detections ───────────────────────────── */

const COLORS = { SS: "#60a5fa", PT: "#f59e0b", PI: "#a78bfa", LL: "#34d399" };
const kpOf = (d, n) => d.kpts.find(k => k.name === n);

function extend(p, q, f) {                       // stretch a segment about its midpoint
  const m = [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
  return [[m[0] + (p[0] - m[0]) * f, m[1] + (p[1] - m[1]) * f],
          [m[0] + (q[0] - m[0]) * f, m[1] + (q[1] - m[1]) * f]];
}

function arcPts(c, a, b, r, N = 28) {
  const ang = p => Math.atan2(p[1] - c[1], p[0] - c[0]);
  const a1 = ang(a);
  let dd = ang(b) - a1;
  dd = ((dd + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
  return Array.from({ length: N }, (_, i) => {
    const t = a1 + dd * i / (N - 1);
    return [c[0] + r * Math.cos(t), c[1] + r * Math.sin(t)];
  });
}

function intersect(p1, p2, p3, p4) {
  const d = (p1[0] - p2[0]) * (p3[1] - p4[1]) - (p1[1] - p2[1]) * (p3[0] - p4[0]);
  if (Math.abs(d) < 1e-9) return null;
  const a = p1[0] * p2[1] - p1[1] * p2[0], b = p3[0] * p4[1] - p3[1] * p4[0];
  return [(a * (p3[0] - p4[0]) - (p1[0] - p2[0]) * b) / d,
          (a * (p3[1] - p4[1]) - (p1[1] - p2[1]) * b) / d];
}

/** Detections -> the same {shape, angles, landmarks} a reference bundle carries. */
function buildUserView(dets, W, H, femoral) {
  const levelled = assignLevels(dets, els.regionSel ? els.regionSel.value : "none");
  // Say what the detections look like, without acting on it. See offerRegion.
  offerRegion(dets);
  const ang = computeAngles(levelled);
  const byLevel = Object.fromEntries(levelled.map(d => [d.level, d]));
  const R = Math.min(W, H);
  const angles = [];

  const s1 = byLevel.S1;
  if (s1 && ang.SS != null) {
    const a = kpOf(s1, "sup_ant"), p = kpOf(s1, "sup_post");
    const A = [a.x, a.y], P = [p.x, p.y];
    const [e0, e1] = extend(A, P, 1.9);
    const mid = [(A[0] + P[0]) / 2, (A[1] + P[1]) / 2];
    const len = Math.hypot(P[0] - A[0], P[1] - A[1]);
    // horizontal reference through the same midpoint, running the way the plate does
    const dir = A[0] <= P[0] ? -1 : 1;
    const hz = [mid[0] + dir * len * 0.95, mid[1]];
    angles.push({
      id: "SS", value: ang.SS.toFixed(1), units: "°", color: COLORS.SS,
      segments: [[e0, e1]], dashed: [[mid, hz]],
      arc: arcPts(mid, dir < 0 ? e0 : e1, hz, len * 0.55),
      label_at: [dir < 0 ? -0.015 * W : 1.015 * W, mid[1]],
      label_anchor: dir < 0 ? "end" : "start",
      leader: [[dir < 0 ? -0.012 * W : 1.012 * W, mid[1]], mid],
    });
  }

  /* PI AND PT NEED A FEMORAL HEAD, which only the reference film has. The definitions
     are ostk.metrics2d's, on the same corners: PT at the head between the vertical and the
     line to the S1 endplate midpoint, PI at that midpoint between the plate's perpendicular
     and the line to the head. Image pixels run downward, so cranial is -y. */
  if (s1 && femoral) {
    const a = kpOf(s1, "sup_ant"), p = kpOf(s1, "sup_post");
    if (a && p) {
      const A = [a.x, a.y], P = [p.x, p.y];
      const mid = [(A[0] + P[0]) / 2, (A[1] + P[1]) / 2];
      const len = Math.hypot(P[0] - A[0], P[1] - A[1]) || 1;
      const F = [femoral[0], femoral[1]];
      const toMid = [mid[0] - F[0], mid[1] - F[1]];
      const up = [0, -1];
      const acute = (ux, uy, vx, vy) => {
        const d = (ux * vx + uy * vy) /
                  (Math.hypot(ux, uy) * Math.hypot(vx, vy) || 1);
        let t = Math.acos(Math.max(-1, Math.min(1, d))) * 180 / Math.PI;
        return t > 90 ? 180 - t : t;
      };
      const PT = acute(toMid[0], toMid[1], up[0], up[1]);
      // the plate's perpendicular, pointed cranially
      let n = [-(P[1] - A[1]) / len, (P[0] - A[0]) / len];
      if (n[1] > 0) n = [-n[0], -n[1]];
      const PI = acute(n[0], n[1], -toMid[0], -toMid[1]);
      const vtip = [F[0], F[1] - len * 1.6];
      angles.push({
        id: "PT", value: PT.toFixed(1), units: "\u00b0", color: COLORS.PT || "#f472b6",
        segments: [[F, mid]], dashed: [[F, vtip]],
        arc: arcPts(F, mid, vtip, len * 0.5),
      });
      const ntip = [mid[0] + n[0] * len * 1.1, mid[1] + n[1] * len * 1.1];
      angles.push({
        id: "PI", value: PI.toFixed(1), units: "\u00b0", color: COLORS.PI || "#34d399",
        segments: [[mid, F]], dashed: [[mid, ntip]],
        arc: arcPts(mid, ntip, F, len * 0.62),
      });
    }
  }

  const l1 = byLevel.L1;
  if (l1 && s1 && ang.LL != null) {
    const A1 = [kpOf(l1, "sup_ant").x, kpOf(l1, "sup_ant").y];
    const P1 = [kpOf(l1, "sup_post").x, kpOf(l1, "sup_post").y];
    const A2 = [kpOf(s1, "sup_ant").x, kpOf(s1, "sup_ant").y];
    const P2 = [kpOf(s1, "sup_post").x, kpOf(s1, "sup_post").y];
    const X = intersect(A1, P1, A2, P2);
    const a = { id: "LL", value: ang.LL.toFixed(1), units: "°", color: COLORS.LL,
                segments: [extend(A1, P1, 1.6), extend(A2, P2, 1.6)] };
    if (X && Math.hypot(X[0] - A1[0], X[1] - A1[1]) < 6 * R) {
      // Cobb lines meet ANTERIORLY in a lordosis, often off the film. Only draw the
      // wedge when the vertex is somewhere a reader can actually see it.
      const inside = X[0] > -0.35 * W && X[0] < 1.35 * W && X[1] > -0.35 * H && X[1] < 1.35 * H;
      if (inside) {
        const r = Math.min(0.16 * R,
                           0.55 * Math.min(Math.hypot(X[0] - A1[0], X[1] - A1[1]),
                                           Math.hypot(X[0] - A2[0], X[1] - A2[1])));
        a.arc = arcPts(X, A1, A2, r);
      }
    }
    const my = (A1[1] + A2[1]) / 2;
    a.label_at = [-0.015 * W, my];
    a.label_anchor = "end";
    a.leader = [[-0.012 * W, my], [(A1[0] + A2[0]) / 2, my]];
    angles.push(a);
  }

  const landmarks = [];
  for (const d of levelled)
    for (const k of d.kpts) {
      // The inferior pair of the bottom-most vertebra is annotated invisible in the
      // training data (BUU marks S1's superior plate only), so the model has nothing
      // to say there; v is its own admission of that.
      if (k.v < 0.5) continue;
      landmarks.push({
        id: `${d.level}_${k.name}`, level: d.level, cls: k.name,
        label: `${d.level} ${KPT_LABEL[k.name] || k.name}`,
        xy: [k.x, k.y], color: LM_COLOR[k.name], conf: d.conf,
        desc: `Predicted in this browser. Box confidence ${d.conf.toFixed(2)}; `
            + (d.named
                ? `level names follow the region you selected, counted up from the `
                  + `most caudal detection.`
                : `unnamed — numbered upward from the most caudal detection.`),
      });
    }

  // PI and PT are always unavailable -- no hip landmark survives on a real film. SS and
  // LL go on the list too when their endplates were not found, so a missing parameter
  // is stated rather than silently absent from the panel.
  const unavailable = femoral ? [] : ["PI", "PT"];
  if (ang.SS == null) unavailable.unshift("SS");
  if (ang.LL == null) unavailable.unshift("LL");

  const named = levelled.length && levelled[0].named;
  let note = named
    ? `${levelled.length} vertebrae detected, named from the caudal end up, so a film `
      + `that includes more spine above does not renumber the ones below. The names are `
      + `the region you chose, not a model output. Hover a marker for its class.`
    : `${levelled.length} vertebrae detected, numbered V1 upward from the caudal end. `
      + `The model finds vertebrae but does not name them; choose a region under Model `
      + `to apply level names. Hover a marker for its corner.`;
  if (ang.LL == null)
    note += named
      ? ` LL needs both the L1 and S1 superior endplates; only ${levelled.length} `
        + `vertebra${levelled.length === 1 ? "" : "e"} were found, so L1 was never `
        + `reached.`
      : ` LL is an angle between two NAMED endplates, so it waits on a region.`;

  return { shape: [H, W], angles, landmarks, unavailable, levelled, lmNote: note };
}

/** Run the current model over the reference DRR and replace its corner markers.
 *
 *  The default overlay is precomputed, because the DRR never changes and the opening view
 *  should not wait on a network. This exists for the moment a reader picks a different
 *  model: the pane whose truth is known is exactly where a model comparison belongs.
 */
async function reinferReference() {
  if (!view.ref || !view.ref.imageUrl) return;
  const keep = (view.ref.landmarks || []).filter(l => l.cls === "hip_axis");
  els.loading.hidden = false;
  try {
    const det = await ensureDetector();
    const bmp = await createImageBitmap(await (await fetch(view.ref.imageUrl)).blob());
    const cv = sourceCanvas(bmp, false);
    const conf = Number(els.confRange.value);
    const { dets, ms, backend } =
      await det.infer(cv, bmp.width, bmp.height, conf, els.modeSel.value);
    if (!dets.length) {
      view.ref.lmNote = "No vertebra passed the confidence threshold on the synthetic "
                      + "radiograph at this setting.";
      view.ref.landmarks = keep;
      view.ref.angles = [];
    } else {
      // SAME BUILDER AS A DROPPED FILM, with the one thing a dropped film never has: the
      // femoral head, so this pane gets PI and PT as well.
      const femoral = keep.length ? keep[0].xy : null;
      const built = buildUserView(dets, bmp.width, bmp.height, femoral);
      view.ref.angles = built.angles;
      view.ref.landmarks = built.landmarks.concat(keep);
      view.ref.shape = built.shape;
      const got = Object.fromEntries(built.angles.map(q => [q.id, q.value]));
      view.ref.lmNote =
        `Re-inferred in this browser with ${detImgsz}px weights at confidence `
        + `${conf.toFixed(2)} — ${built.levelled.length} vertebrae, ${ms.toFixed(0)} ms on `
        + `${backend === "webgpu" ? "the GPU" : "the CPU"}. Every angle here is measured `
        + `from these corners, by the same construction ostk uses. `
        + (got.PI ? `PI ${got.PI}°, ` : "")
        + (got.SS ? `SS ${got.SS}°. ` : "")
        + `The femoral head is a 3-D fit from the CT and is not predicted — it is why this `
        + `pane can show PI and PT and a dropped film cannot.`;
      active.ref.clear();
      view.ref.angles.forEach(q => active.ref.set(q.id, true));
    }
    if (panelSrc === "ref") renderPanel();
    draw("ref");
  } catch (e) {
    view.ref.lmNote = `Could not re-run the model on the synthetic radiograph: ${e.message}`;
    if (panelSrc === "ref") renderPanel();
  } finally {
    els.loading.hidden = true;
  }
}

/* ── user pane : plumbing ────────────────────────────────────────────────── */

let detector = null, detImgsz = null;
let userBitmap = null, flipped = false, userURL = null;

async function ensureDetector() {
  if (detector && detImgsz === MODEL_IMGSZ) return detector;
  detector = new SpineDetector({ modelUrl: MODEL_URL, imgsz: MODEL_IMGSZ });
  detImgsz = MODEL_IMGSZ;
  els.engine.className = "badge badge--load";
  els.engine.textContent = "loading…";
  const backend = await detector.load(s => { els.uloadtxt.textContent = s; });
  els.engine.className = "badge badge--ok";
  const gpu = detector.adapter;
  els.engine.textContent = backend === "webgpu"
    ? (gpu ? `WebGPU · ${gpu}` : "WebGPU") : "WASM (CPU)";
  els.engine.title = backend === "webgpu"
    ? `Running on the GPU through WebGPU${gpu ? ` (${gpu})` : ""}.`
      + " If that is the integrated chip on a machine that also has a discrete card,"
      + " set this browser to High performance in the OS graphics settings — measured"
      + " here that is 445 ms against 133 ms, for identical output."
    : "This browser exposes no WebGPU, so the model is running on the CPU through"
      + " WebAssembly, across " + (detector.threads || 1) + " thread(s). The result is"
      + " identical; it is slower than the GPU path but not by the margin one thread"
      + " would cost.";
  return detector;
}

/** Mirroring is a real control, not a nicety: keypoint slots are handed, so a film
 *  scanned facing the other way puts every anterior corner on the posterior wall. */
function sourceCanvas(bmp, mirror) {
  const cv = new OffscreenCanvas(bmp.width, bmp.height);
  const cx = cv.getContext("2d");
  if (mirror) { cx.translate(bmp.width, 0); cx.scale(-1, 1); }
  cx.drawImage(bmp, 0, 0);
  return cv;
}

async function analyse() {
  if (!userBitmap) return;
  const W = userBitmap.width, H = userBitmap.height;
  els.uloading.hidden = false;
  els.uloadtxt.textContent = "loading model…";
  try {
    const det = await ensureDetector();
    const cv = sourceCanvas(userBitmap, flipped);
    // repaint the visible image so the overlay and the pixels agree under mirroring
    if (userURL) URL.revokeObjectURL(userURL);
    const blob = await cv.convertToBlob({ type: "image/png" });
    userURL = URL.createObjectURL(blob);
    await showImage(els.uimg, userURL);
    els.uimg.hidden = false;
    els.dropPrompt.hidden = true;
    els.clearUser.hidden = false;

    els.uloadtxt.textContent = "detecting…";
    const conf = Number(els.confRange.value);
    const { dets, ms, backend, tiles, mode } =
      await det.infer(cv, W, H, conf, els.modeSel.value);
    if (!dets.length) {
      view.user = { shape: [H, W], angles: [], landmarks: [], unavailable: ["PI", "PT"],
                    lmNote: "No vertebra passed the confidence threshold. Lower it, or "
                          + "check that this is a LATERAL lumbar film — the model has "
                          + "only ever seen lateral views." };
      els.hudUser.textContent = "no detections";
    } else {
      view.user = buildUserView(dets, W, H, null);
      els.hudUser.textContent =
        `${W}×${H} · ${view.user.levelled.length} vertebrae`;
    }
    active.user.clear();
    view.user.angles.forEach(a => active.user.set(a.id, true));
    els.timing.textContent = `${ms.toFixed(0)} ms · ${backend === "webgpu" ? "GPU" : "CPU"}`
                           + ` · ${detImgsz}px`
                           + (mode === "tiled" ? ` · ${tiles} tiles` : "");
    focusPane("user");
    panelSrc = "user";
    renderPanel();
    draw("user");
  } catch (e) {
    console.error(e);
    els.hudUser.textContent = `failed: ${e.message}`;
    els.engine.className = "badge badge--err";
    els.engine.textContent = "error";
  } finally {
    els.uloading.hidden = true;
  }
}

async function acceptBlob(blob) {
  if (!blob || !/^image\//.test(blob.type || "")) {
    els.hudUser.textContent = "not an image";
    return;
  }
  try {
    userBitmap = await createImageBitmap(blob);
  } catch {
    els.hudUser.textContent = "could not decode that image";
    return;
  }
  flipped = false;
  els.flipBtn.classList.remove("ctl--on");
  await analyse();
}

function clearUser() {
  userBitmap = null;
  if (userURL) { URL.revokeObjectURL(userURL); userURL = null; }
  view.user = null;
  els.uimg.hidden = true;
  els.uimg.removeAttribute("src");
  els.uoverlay.innerHTML = "";
  els.dropPrompt.hidden = false;
  els.clearUser.hidden = true;
  els.hudUser.textContent = "drop, paste or choose a file";
  els.timing.textContent = "";
  panelSrc = "ref";
  focusPane("ref");
  renderPanel();
}

/* ── events ──────────────────────────────────────────────────────────────── */

els.caseSel.addEventListener("change", e => loadCase(e.target.value));
els.clear.addEventListener("click", () => {
  active[panelSrc].clear();
  draw(panelSrc);
  [...els.metrics.children].forEach(b => b.classList.remove("is-on"));
});
els.paneRef.addEventListener("click", () => focusPane("ref"));
els.paneUser.addEventListener("click", e => {
  if (!e.target.closest("button")) focusPane("user");
});

els.pickBtn.addEventListener("click", e => { e.stopPropagation(); els.fileInput.click(); });
els.fileInput.addEventListener("change", e => acceptBlob(e.target.files?.[0]));
els.clearUser.addEventListener("click", clearUser);
els.flipBtn.addEventListener("click", () => {
  flipped = !flipped;
  els.flipBtn.classList.toggle("ctl--on", flipped);
  analyse();
});
els.modeSel.addEventListener("change", () => { analyse(); reinferReference(); });

/* ── region, camera ──────────────────────────────────────────────────────────── */

/** Offer the region the detections look like, without applying it.
 *
 *  Naming is the user's assertion about what film this is, so the page says what it
 *  would guess and why, and leaves the control alone. Applying a guess silently is how
 *  a cervical C7 came to be labelled "S1". */
function offerRegion(dets) {
  if (!els.regionNote) return;
  if (!dets || !dets.length) {
    els.regionNote.textContent =
      "Levels are an assumption about the film, not a model output. Pick a region to "
      + "name them; angles that need named endplates appear once you do.";
    return;
  }
  const { region, why } = suggestRegion(dets);
  const current = els.regionSel ? els.regionSel.value : "none";
  els.regionNote.textContent = current === "none"
    ? `Unnamed. Looks like a ${region} film — ${why}. Choose a region to apply names.`
    : `Named as ${current}. From the detections alone this looks ${region} — ${why}.`;
}

/** Stop the viewfinder and put the panel back. Safe to call when nothing is running. */
function camStop() {
  const v = els.camVideo;
  if (v && v.srcObject) {
    for (const t of v.srcObject.getTracks()) t.stop();
    v.srcObject = null;
  }
  if (els.camWrap) els.camWrap.hidden = true;
  if (els.dropPrompt) els.dropPrompt.hidden = false;
}

/** A phone has a camera behind the file input; a laptop needs a viewfinder.
 *
 *  Feature-detection, not user-agent sniffing: if the input carries a `capture`
 *  property the platform honours it and the native camera is the better experience. */
async function camOpen() {
  const nativeCapture = els.camInput && "capture" in els.camInput
    && /Android|iPhone|iPad|iPod/i.test(navigator.userAgent || "");
  if (nativeCapture) { els.camInput.click(); return; }

  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    els.fileInput.click();
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "environment", width: { ideal: 1920 }, height: { ideal: 1440 } },
      audio: false,
    });
    els.camVideo.srcObject = stream;
    await els.camVideo.play();
    els.camWrap.hidden = false;
    if (els.dropPrompt) els.dropPrompt.hidden = true;
  } catch (e) {
    // denied, or no camera: fall back to the ordinary picker rather than a dead button
    console.warn("[xr] camera unavailable:", e && e.message);
    els.fileInput.click();
  }
}

/** Grab the current frame at the sensor's own resolution. */
async function camShoot() {
  const v = els.camVideo;
  if (!v || !v.videoWidth) return;
  const c = document.createElement("canvas");
  c.width = v.videoWidth; c.height = v.videoHeight;
  c.getContext("2d").drawImage(v, 0, 0);
  const blob = await new Promise(r => c.toBlob(r, "image/png"));
  camStop();
  await acceptBlob(blob);
}

if (els.camBtn) els.camBtn.addEventListener("click", e => { e.stopPropagation(); camOpen(); });
if (els.camInput) els.camInput.addEventListener("change", e => acceptBlob(e.target.files?.[0]));
if (els.camShoot) els.camShoot.addEventListener("click", e => { e.stopPropagation(); camShoot(); });
if (els.camCancel) els.camCancel.addEventListener("click", e => { e.stopPropagation(); camStop(); });
if (els.regionSel) els.regionSel.addEventListener("change", () => { analyse(); reinferReference(); });

els.confRange.addEventListener("input", () => {
  els.confVal.textContent = Number(els.confRange.value).toFixed(2);
});
// on "change", not "input": a re-infer per slider pixel would be unusable
els.confRange.addEventListener("change", () => { analyse(); reinferReference(); });

/* Drag and drop is bound to the WHOLE window: a dropzone you have to hit is a worse
   target than the page, and the browser's default action for a missed drop is to
   navigate away from the demo and open the file on its own. */
let dragDepth = 0;
window.addEventListener("dragenter", e => {
  if (![...e.dataTransfer.types].includes("Files")) return;
  e.preventDefault(); dragDepth++; els.dragveil.hidden = false;
});
window.addEventListener("dragover", e => e.preventDefault());
window.addEventListener("dragleave", () => {
  if (--dragDepth <= 0) { dragDepth = 0; els.dragveil.hidden = true; }
});
window.addEventListener("drop", e => {
  e.preventDefault(); dragDepth = 0; els.dragveil.hidden = true;
  const f = [...(e.dataTransfer.files || [])].find(f => /^image\//.test(f.type));
  if (f) acceptBlob(f);
  else els.hudUser.textContent = "that drop carried no image file";
});

/* Paste. Bound to the document so it works without focusing anything -- which is the
   whole point of pasting a PACS screenshot. */
document.addEventListener("paste", e => {
  const items = [...(e.clipboardData?.items || [])];
  const it = items.find(i => i.kind === "file" && /^image\//.test(i.type));
  if (!it) return;
  e.preventDefault();
  acceptBlob(it.getAsFile());
});

window.addEventListener("resize", () => { draw("ref"); draw("user"); });

loadManifest();
