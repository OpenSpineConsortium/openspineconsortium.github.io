/* ============================================================
   Gallery — specimen viewers + the shape of the cohort.

   WHY THE MESH VIEWER IS BACK. It was replaced with pre-rendered stills after it
   "failed to render" across several attempts. It had not failed: the card around the
   canvas carried a class that left it at opacity zero, so a working viewer and a broken
   one looked identical from outside. With that fixed, real geometry is the right answer
   — stills can never offer zoom or pan, and no number of frames fixes a fixed
   resolution.

   NO CDN, NO IMPORT MAP. three.js and OrbitControls are vendored under assets/js/vendor
   and OrbitControls has had its bare "three" specifier rewritten to a relative path, so
   nothing here depends on an import map resolving or a CDN answering.

   NO LEVEL NAMES IN THE COPY. Sacralisation and lumbarisation are one morphology under
   two counts, so every caption describes what is visible and never asserts which
   vertebra is which.
   ============================================================ */

import { createViewer } from "./viewer.js?v=bad28eaf";

const DATA = "assets/gallery/";
/* key -> construction diagram. Filled before any panel is drawn; empty is fine, and a
   panel with no entry simply gets no explainer rather than a broken control. */
let MEASURES = {};
/* the figures are plain URLs, so they carry the build stamp from measures/index.json --
   without it a rebuilt diagram is served from cache and the change reaches nobody */
let MEASURE_BUILD = "";
/* the same for the meshes, from assets/gallery/index.json */
let MESH_BUILD = "";
/* one diagram per (section, construction) -- see the note in wrapPanel */
const SHOWN_MEASURES = new Set();
const STILLS = DATA + "stills/";

const CASES = [
  { id: "1090", title: "A thirteenth rib-bearing level", tag: "lumbar rib",
    blurb: "Below twelve ordinary rib pairs, one more: 120 mm on the left and 114 mm on " +
           "the right, articulating with the body at 0.8 mm — about seventy per cent the " +
           "length of the twelfth pair, and nothing like the stub the term “lumbar rib” " +
           "usually calls to mind. Four bodies below it are rib-free instead of the usual " +
           "five. Whether to call this a lumbar vertebra bearing ribs or a thirteenth " +
           "thoracic vertebra cannot be settled from this scan, which begins at T8 and so " +
           "offers no C2 to count down from; the two readings differ only in the number " +
           "assigned. The separate class is what lets the file decline to guess. Forcing " +
           "it to be rib 12 would shift every level beneath it by one.",
    focus: (s) => /lumbar/.test(s.name || "") },
  { id: "0268", title: "Six rib-free bodies, and a process at the ala", tag: "transitional",
    blurb: "Six vertebrae between the lowest rib and the sacrum instead of five, and " +
           "the lowest one reaches out 106 mm to come within 1.3 mm of the sacral " +
           "ala — close enough to articulate. Whether that is a lumbarised segment or " +
           "an accessory joint depends on where the count starts.",
    focus: (s) => s.name === "L6" || s.name === "sacrum" },
  { id: "0349", title: "The widest transverse span in the cohort", tag: "near-contact",
    blurb: "118 mm across the lowest lumbar transverse processes, with 1.3 mm left " +
           "to the ala. This is the geometry Castellvi grades, shown without naming " +
           "the level it happens at.",
    focus: (s) => s.name === "L5" || s.name === "L6" || s.name === "sacrum" },
  { id: "0033", title: "A part-fused transitional vertebra", tag: "part-fused",
    blurb: "Six rib-free bodies above the sacrum, the lowest incompletely fused on the " +
           "left. Whether that is a sacralised or a lumbarised segment depends entirely " +
           "on where the count starts — the fusion itself does not.",
    focus: (s) => s.name === "L6" || s.name === "sacrum" },
  { id: "0631", title: "A hypoplastic twelfth rib", tag: "hypoplastic",
    blurb: "On the right, 45 mm of rib against 120 mm above it, articulating at 1.5 mm: " +
           "hypoplastic, and measured as such. The left side was carrying a segmentation " +
           "error rather than a phenotype — 12 mm of bone sitting 5.3 mm clear of the " +
           "vertebra, where a costovertebral joint measures one to two. It was painted " +
           "back onto the bone that was always there on the CT and now reaches 18.7 mm, " +
           "articulating at 0.9 mm. The lowest-rib ratio moved from 0.10 to 0.16 for this " +
           "record. Across the cohort that ratio is not one distribution with a long tail " +
           "but two populations.",
    focus: (s) => /rib_(left|right)_1[12]$/.test(s.name || "") },
  { id: "0378", title: "Aplastic on one side only", tag: "asymmetric",
    blurb: "A small twelfth rib on one side and none on the other. What the segmentation " +
           "first carried on the absent side was 428 fragments of stray label averaging " +
           "under two voxels each — not a rib, and now recorded as an absence.",
    focus: (s) => /rib_(left|right)_1[12]$/.test(s.name || "") },
  { id: "1153", title: "Eleven rib pairs, and two readings of why", tag: "aplastic",
    blurb: "One long rib on each side reaches T11 and nothing articulates below it. That " +
           "is either a twelfth pair that never formed, or a twelfth thoracic vertebra " +
           "behaving as a lumbar one — six rib-free presacral bodies instead of five. " +
           "Nothing in a field of view starting at T6 decides between them, because both " +
           "readings need a count from C2. Morphology is the better hint than counting " +
           "here: a body that is shaped like a lumbar vertebra is evidence about what it " +
           "is, and that evidence is local. This case also carries the failure it " +
           "illustrates — 1,211 stray fragments, none above 36 voxels, sit in two rib " +
           "classes and are queued for removal.",
    focus: (s) => /rib_(left|right)_1[12]$/.test(s.name || "") },
  { id: "0004", title: "Unremarkable, for reference", tag: "reference",
    blurb: "Five rib-free bodies above the sacrum, twelve rib pairs, nothing " +
           "transitional. Most of the cohort looks like this.",
    focus: null },
];

const VIEW_BUTTONS = [
  ["anterior", "Ant"], ["posterior", "Post"], ["left", "Left"],
  ["right", "Right"], ["superior", "Sup"], ["oblique", "Obl"],
];

/* ---------------------------------------------------------- a case card */
/* ONE OBSERVER FOR THE WHOLE DECK. A per-card observer would work and would also mean
   ten observers watching ten elements; this watches all of them and disconnects each entry
   as it fires, so a card is never started twice. Browsers without IntersectionObserver get
   the old behaviour -- everything at once -- which is slow but not broken. */
const nearViewport = ("IntersectionObserver" in window)
  ? new IntersectionObserver((entries, obs) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        obs.unobserve(e.target);
        const go = e.target.__start;
        if (go) { delete e.target.__start; go(); }
      }
    }, { rootMargin: "150% 0px" })
  : null;


function mountCase(grid, spec) {
  const card = document.createElement("article");
  // NOT "reveal": that class sets opacity:0 and waits for an observer in main.js which
  // collects .reveal elements once, at load. These cards are built afterwards, so
  // nothing ever observed them and they stayed invisible for good — which is what made
  // a working 3-D viewer look like a broken one for three rounds of debugging.
  card.className = "gal__case";
  card.innerHTML = `
    <div class="gal__stage is-loading" data-case="${spec.id}">
      <span class="gal__spin" aria-hidden="true"></span>
      <span class="gal__pct" aria-hidden="true"></span>
      <div class="gal__gizmo" aria-hidden="true"></div>
      <div class="gal__scale" aria-hidden="true"><i></i><b></b></div>
      <span class="gal__tag">${spec.tag}</span>
    </div>
    <div class="gal__bar" role="group" aria-label="Standard views">
      ${VIEW_BUTTONS.map(([k, l]) =>
        `<button type="button" class="gal__vb" data-view="${k}">${l}</button>`).join("")}
      <span class="gal__bar-sep"></span>
      <button type="button" class="gal__vb gal__vb--wide" data-act="isolate">Isolate</button>
    </div>
    <div class="gal__meta">
      <h3>${spec.title}</h3>
      <p>${spec.blurb}</p>
      <div class="gal__groups"></div>
      <ul class="gal__keys" aria-label="Viewer controls">
        <li><b>Rotate</b> drag <span class="gal__touch">&middot; two fingers</span></li>
        <li><b>Zoom</b> scroll <span class="gal__touch">&middot; pinch</span></li>
        <li><b>Pan</b> right-drag</li>
      </ul>
      <div class="gal__row"><span class="gal__id">case ${spec.id}</span></div>
    </div>`;
  grid.appendChild(card);

  const stage = card.querySelector(".gal__stage");
  const bar = card.querySelector(".gal__bar");
  const groupBox = card.querySelector(".gal__groups");
  const gizmo = card.querySelector(".gal__gizmo");
  const pct = card.querySelector(".gal__pct");
  const scaleEl = card.querySelector(".gal__scale");
  const scaleBar = scaleEl.querySelector("i");
  const scaleTxt = scaleEl.querySelector("b");
  let isolated = false;

  // everything below this point is the expensive half: it fetches the mesh, builds the
  // geometry and starts a render loop. It runs when the card approaches the viewport.
  function start() {
  const v = createViewer(stage, {
    dataUrl: DATA,
    bust: MESH_BUILD,
    caseId: spec.id,
    onFail(err) {
      console.error("[gallery]", spec.id, err);
      stage.classList.remove("is-loading");
      bar.remove(); groupBox.remove(); scaleEl.remove();
      fallbackStills(stage, spec);
      card.querySelector(".gal__keys").innerHTML =
        "<li><b>Rotate</b> drag</li>" +
        "<li class='gal__degraded'>3-D unavailable here — showing rendered frames</li>";
    },
    onProgress(f) { pct.textContent = `${Math.round(f * 100)}%`; },
    onReady(api) {
      pct.remove();
      for (const g of api.groups()) {
        const lab = document.createElement("label");
        lab.className = "gal__grp";
        lab.innerHTML = `<input type="checkbox" checked><span>${g.label}</span><em>${g.count}</em>`;
        lab.querySelector("input").addEventListener("change", (e) =>
          api.setGroupVisible(g.key, e.target.checked));
        groupBox.appendChild(lab);
      }
      if (!spec.focus) {
        const b = card.querySelector('[data-act="isolate"]');
        if (b) b.remove();
      }
    },
    // the scale bar is only true for the current camera distance, so it is recomputed
    // every frame rather than written once
    onFrame() {
      if (!v) return;
      // anatomical axes, placed where they actually point on screen this frame
      const ax = v.axisScreen();
      if (ax.length) {
        const w = stage.clientWidth / 2 - 20, h = stage.clientHeight / 2 - 20;
        gizmo.innerHTML = ax.map((a) =>
          `<span class="gz" style="transform:translate(${(a.x * w).toFixed(0)}px,` +
          `${(a.y * h).toFixed(0)}px);opacity:${(0.45 + 0.5 * a.inPlane).toFixed(2)}">` +
          `${a.k}</span>`).join("");
      }
      const ppm = v.pxPerMm();
      if (!isFinite(ppm) || ppm <= 0) return;
      const want = 90 / ppm;
      const mag = Math.pow(10, Math.floor(Math.log10(want)));
      const mm = [1, 2, 5, 10].map((m) => m * mag).find((x) => x >= want) || mag * 10;
      scaleBar.style.width = `${(mm * ppm).toFixed(1)}px`;
      scaleTxt.textContent = mm >= 10 ? `${mm / 10} cm` : `${mm} mm`;
    },
  });
  if (!v) return;

  bar.addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    if (b.dataset.view) {
      v.setView(b.dataset.view);
      bar.querySelectorAll(".gal__vb").forEach((x) => x.classList.remove("is-on"));
      b.classList.add("is-on");
    } else if (b.dataset.act === "isolate") {
      isolated = !isolated;
      v.isolate(isolated ? spec.focus : null);
      b.textContent = isolated ? "Show all" : "Isolate";
      b.classList.toggle("is-on", isolated);
    }
  });
  }

  if (nearViewport) {
    card.__start = start;
    nearViewport.observe(card);
  } else {
    start();
  }
}

/* stills fallback — only reached when WebGL is genuinely unavailable */
function fallbackStills(host, spec) {
  const N = 16;
  host.innerHTML = "";
  const img = new Image();
  img.className = "gal__frame";
  img.alt = `Reconstruction of the segmented spine and pelvis, case ${spec.id}`;
  img.draggable = false;
  img.src = `${STILLS}${spec.id}_00.png`;
  host.appendChild(img);
  const srcs = [img.src], keep = [img];
  for (let i = 1; i < N; i++) {
    const f = new Image();
    f.src = `${STILLS}${spec.id}_${String(i).padStart(2, "0")}.png`;
    keep.push(f); srcs.push(f.src);
  }
  let idx = 0, drag = false, lastX = 0, acc = 0;
  host.addEventListener("pointerdown", (e) => { drag = true; lastX = e.clientX; acc = 0; });
  window.addEventListener("pointerup", () => { drag = false; });
  window.addEventListener("pointermove", (e) => {
    if (!drag) return;
    acc += e.clientX - lastX; lastX = e.clientX;
    const step = Math.max(22, host.clientWidth * 1.4 / N);
    while (Math.abs(acc) >= step) {
      idx = ((idx + (acc > 0 ? -1 : 1)) % N + N) % N;
      img.src = srcs[idx];
      acc -= Math.sign(acc) * step;
    }
  });
}

/* ---------------------------------------------------------- charts */
const NS = "http://www.w3.org/2000/svg";
const el = (tag, attrs, text) => {
  const n = document.createElementNS(NS, tag);
  for (const k in attrs) n.setAttribute(k, attrs[k]);
  if (text != null) n.textContent = text;
  return n;
};
const el2 = (tag, text, cls) => {
  const n = document.createElement(tag);
  n.textContent = text;
  if (cls) n.className = cls;
  return n;
};

/* ticks land on round numbers: "0, 50, 100" reads instantly, "0, 47, 94" does not */
function niceTicks(lo, hi, want) {
  const span = hi - lo;
  if (span <= 0) return [lo];
  const raw = span / want;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((v) => v >= raw) || mag * 10;
  const out = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) {
    out.push(Math.abs(v) < 1e-9 ? 0 : +v.toFixed(6));
  }
  return out;
}

function frame(p, W, H, L, R, T, B) {
  const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, class: "gal__svg",
                          role: "img", "aria-label": p.title });
  // wrapPanel receives only the finished element, so anything wanting to place content in
  // plot coordinates -- the measurement inset -- needs the axes recorded here.
  svg.__plot = { L, R, T, B, W, H, pw: W - L - R, ph: H - T - B };
  return { svg, pw: W - L - R, ph: H - T - B };
}

/* A coarse left-to-right profile of however this panel carries its data, normalised to
   [0,1]. Used only to decide which half of the plot has more ink in it. */
function inkProfile(p) {
  const cand = [];
  if (Array.isArray(p.y)) cand.push(p.y);
  if (Array.isArray(p.values)) cand.push(p.values);
  for (const s2 of p.series || []) {
    // EVERY SHAPE A PANEL STORES ITS HEIGHTS IN. Reading only `y` meant a grouped bar
    // chart, which keeps them in `pct`, profiled as empty -- so the inset was told the
    // whole plot was free and placed itself on the tallest bars. That is precisely the
    // overlap this function exists to prevent.
    if (Array.isArray(s2.y)) cand.push(s2.y);
    else if (Array.isArray(s2.pct)) cand.push(s2.pct);
    else if (Array.isArray(s2.med)) cand.push(s2.med);
    else if (Array.isArray(s2.counts)) cand.push(s2.counts);
  }
  // a scatter has no series at all: bin its points across x and take the tallest in each
  if (!cand.length && Array.isArray(p.points) && p.points.length) {
    // points come as {x, y} objects here, and as [x, y] pairs elsewhere; reading only the
    // array form left every scatter with no profile at all, which the placer then treats
    // as an empty plot -- the one assumption it must never make.
    const pts = p.points
      .map((q) => (Array.isArray(q) ? q : (q && isFinite(q.x) && isFinite(q.y)
                                           ? [q.x, q.y] : null)))
      .filter((q) => q && isFinite(q[0]) && isFinite(q[1]));
    if (pts.length > 8) {
      const xs = pts.map((q) => q[0]), ys = pts.map((q) => q[1]);
      const x0 = Math.min(...xs), x1 = Math.max(...xs);
      const y0 = Math.min(...ys), y1 = Math.max(...ys);
      const NB = 40, prof = new Array(NB).fill(0);
      for (const [qx, qy] of pts) {
        const b = Math.min(NB - 1, Math.floor((qx - x0) / Math.max(1e-9, x1 - x0) * NB));
        prof[b] = Math.max(prof[b], (qy - y0) / Math.max(1e-9, y1 - y0));
      }
      return prof;
    }
  }
  if (!cand.length) return null;
  const n = Math.max(...cand.map((a) => a.length));
  if (n < 2) return null;
  const out = new Array(n).fill(0);
  for (const a of cand) {
    for (let i = 0; i < n; i++) {
      const v = +a[Math.min(a.length - 1, Math.round(i * (a.length - 1) / (n - 1)))];
      if (isFinite(v)) out[i] = Math.max(out[i], v);
    }
  }
  const hi = Math.max(...out) || 1;
  return out.map((v) => v / hi);
}


/* The inset grows in place rather than opening somewhere else.

   A modal reads as leaving the page; Greg wanted the figure to expand where it already is.
   The <g> is scaled about its own centre with a CSS transform on the SVG element, so the
   anatomy enlarges over the chart it belongs to and shrinks back to exactly where it was.
   Nothing is added to the DOM and nothing is fetched again.

   Touch is the reason for the pointer handlers rather than :hover -- a phone has no hover
   state, so an inset that only enlarged on hover would be unopenable on the device where
   it is smallest and most needed. */
function makeZoomable(box, cx, cy, factor) {
  let open = false;
  const apply = () => {
    box.style.transformOrigin = `${cx}px ${cy}px`;
    box.style.transform = open ? `scale(${factor})` : "scale(1)";
    box.style.transition = "transform .28s cubic-bezier(.22,.61,.36,1)";
    box.classList.toggle("is-zoomed", open);
    // a zoomed inset has to paint over the plot and over its neighbours
    if (open) box.parentNode.appendChild(box);
  };
  const toggle = (e) => {
    if (e) { e.preventDefault(); e.stopPropagation(); }
    open = !open;
    apply();
  };
  box.addEventListener("click", toggle);
  box.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") toggle(e);
    if (e.key === "Escape" && open) toggle(e);
  });
  // tapping anywhere else closes it, which is the gesture a phone user expects
  document.addEventListener("click", () => { if (open) { open = false; apply(); } });
  return () => { if (open) { open = false; apply(); } };
}

/* The largest square that fits clear of the data, trying all four corners.

   An earlier version only considered the two TOP corners and, when neither fitted, widened
   the chart and hung the figure outside it -- which on two panels meant no visible inset at
   all. A histogram that fills its top corners usually leaves a bottom one empty, so the
   search now covers all four and the outside path is gone. */
function fitInset(g, prof) {
  const PAD = 10;
  const MAX = Math.min(g.pw * 0.32, g.ph * 0.52);
  const MIN = 88;
  const at = (x0f, x1f) => {
    if (!prof) return 0;
    const i0 = Math.max(0, Math.floor(x0f * (prof.length - 1)));
    const i1 = Math.min(prof.length - 1, Math.ceil(x1f * (prof.length - 1)));
    let peak = 0;
    for (let i = i0; i <= i1; i++) peak = Math.max(peak, prof[i]);
    return peak;
  };
  let best = null;
  for (let size = MAX; size >= MIN; size -= 6) {
    for (const right of [true, false]) {
      const x = right ? g.L + g.pw - size - PAD : g.L + PAD;
      const x0f = (x - g.L) / g.pw, x1f = x0f + size / g.pw;
      const peak = at(x0f, x1f);
      // above the curve: the data occupies the bottom `peak` of the plot
      if (g.ph * (1 - peak) - PAD * 2 >= size) {
        return { size, x, y: g.T + PAD, peak, corner: right ? "top-right" : "top-left" };
      }
      // below it: only where the data in this column is a low, flat tail
      if (peak * g.ph <= PAD && g.ph - PAD * 2 >= size) {
        return { size, x, y: g.T + g.ph - size - PAD, peak,
                 corner: right ? "bottom-right" : "bottom-left" };
      }
      if (!best || size > best.size) best = { size, x, y: g.T + PAD, peak, corner: "fallback" };
    }
  }
  // NOTHING CLEARS THE DATA. A bar chart whose bars fill the plot at every x has no free
  // corner, and putting the figure on top of the bars is the fault this function exists to
  // prevent. Signal that the caller should grow the chart and put it underneath instead.
  return { size: Math.max(MIN, Math.min(g.pw * 0.26, g.ph * 0.5)), below: true };
}

/* Add the construction diagram as an inset, above the data or beside it. */
function addInset(svg, p, href) {
  const g = svg.__plot;
  if (!g) return false;
  const prof = inkProfile(p);
  const spot = fitInset(g, prof);
  if (!spot) return false;
  const size = spot.size;
  let x = spot.x;
  let y = spot.y;
  if (spot.below) {
    // grow the frame and sit the figure in a band of its own, centred under the plot
    const vb = svg.getAttribute("viewBox").split(/\s+/).map(Number);
    const band = size + 34;
    svg.setAttribute("viewBox", `0 0 ${vb[2]} ${vb[3] + band}`);
    x = g.L + (g.pw - size) / 2;
    y = vb[3] + 6;
  }
  const box = el("g", { class: "gal__inset" });
  box.appendChild(el("rect", { x: x - 5, y: y - 5, width: size + 10, height: size + 10,
                               rx: 6, class: "gal__inset-bg" }));
  const im = document.createElementNS(NS, "image");
  im.setAttribute("x", x); im.setAttribute("y", y);
  im.setAttribute("width", size); im.setAttribute("height", size);
  im.setAttribute("preserveAspectRatio", "xMidYMid meet");
  im.setAttributeNS("http://www.w3.org/1999/xlink", "href", href);
  im.setAttribute("href", href);
  box.appendChild(im);
  const cap = el("text", { x: x + size / 2, y: y + size + 14, class: "gal__inset-cap",
                           "text-anchor": "middle" }, "what is measured ↗");
  box.setAttribute("data-placement", spot.outside ? "beside" : "over");

  // AN INSET IS SMALL BY NECESSITY, so it opens. At 156 units square the labels on a
  // construction are legible but the anatomy is not, and the whole point of drawing on real
  // bone is that the reader can look at the bone.
  box.classList.add("is-clickable");
  box.setAttribute("tabindex", "0");
  box.setAttribute("role", "button");
  box.setAttribute("aria-label", `Enlarge: the construction behind ${p.title}`);
  // grow about the inset's own centre, to about the height of the plot
  const factor = Math.max(1.6, Math.min(2.9, (g.ph * 0.92) / size));
  makeZoomable(box, x + size / 2, y + size / 2, factor);
  box.appendChild(cap);
  svg.appendChild(box);
  return true;
}

/* .gal__tick is monospace and reaches 19px at the widest breakpoint, so a character is
   about this many user units wide. Measuring properly would need the text in the document
   already; this errs high, which is the safe direction for a box that must not overflow. */
const CH_W = 11.8;

/* Trend series carry one count per age band. Printing the array was both wrong for the
   reader and four times too wide for the legend it sat in. */
function nText(n) {
  if (n == null) return "";
  const total = Array.isArray(n) ? n.reduce((a, b) => a + (+b || 0), 0) : n;
  return ` (n = ${total})`;
}

const LEG_ROW_H = 26;        // vertical pitch of a legend row
const LEG_SWATCH = 30;      // swatch plus the gap before its label

/* How the entries pack into rows of width pw, and therefore how much room the legend needs
   below the plot. Called BEFORE the frame is built, because the chart's height depends on
   it. */
function legendLayout(labels, pw) {
  const widths = labels.map((t) => LEG_SWATCH + String(t).length * CH_W + 22);
  const rows = [];
  let cur = [], curW = 0;
  labels.forEach((t, i) => {
    if (cur.length && curW + widths[i] > pw) { rows.push(cur); cur = []; curW = 0; }
    cur.push(i); curW += widths[i];
  });
  if (cur.length) rows.push(cur);
  return { rows, widths, height: rows.length * LEG_ROW_H };
}

/* A legend under the plot. Not in it -- a legend placed among the data is one dataset away
   from sitting on top of it, which is exactly what happened on the vacuum panel when its
   two tallest bars turned out to be its two rightmost. `draw` receives (g, index, x) and
   adds the swatch for that series at that offset. */
function legendBelow(svg, labels, L, pw, y, draw) {
  const { rows, widths } = legendLayout(labels, pw);
  rows.forEach((row, r) => {
    const rowW = row.reduce((a, i) => a + widths[i], 0);
    let x = L + Math.max(0, (pw - rowW) / 2);
    for (const i of row) {
      const g = el("g", { transform: `translate(${x} ${y + r * LEG_ROW_H})` });
      draw(g, i);
      g.appendChild(el("text", { x: LEG_SWATCH, y: 4, class: "gal__tick" }, labels[i]));
      svg.appendChild(g);
      x += widths[i];
    }
  });
}


function wrapPanel(host, p, svg, extra, wide) {
  const fig = document.createElement("figure");
  fig.className = "gal__panel" + (wide ? " gal__panel--wide" : "");
  fig.appendChild(el2("h4", p.title));
  if (p.subtitle) fig.appendChild(el2("p", p.subtitle, "gal__sub"));
  fig.appendChild(svg);
  const cap = document.createElement("figcaption");
  cap.textContent = (p.caption || "") + (extra || "");
  fig.appendChild(cap);

  // WHAT THE NUMBER IS, not just how it is distributed. Drawn from real released labels
  // using the extractor's own geometry, so it explains this exact measurement rather than
  // a textbook version of it.
  //
  // SHOWN, NOT HIDDEN BEHIND A DISCLOSURE. A reader who does not already know what pelvic
  // incidence is will not open a control to find out; they will read the plot as if they
  // did. But eleven panels share the pelvic-incidence construction, and repeating one
  // identical figure eleven times down a page is its own kind of noise, so it appears on
  // the FIRST panel in each section that uses it. Sections group measures that share a
  // construction, so in practice that is once per section, next to the plots it explains.
  const measure = MEASURES[p.key];
  if (measure) addInset(svg, p, `${DATA}measures/${measure}${MEASURE_BUILD}`);

  host.appendChild(fig);
}

/* A fitted density curve, not bars. Bins put edges in the reader's eye that are not in
   the data — the rib ratio drew two fat bars and the gap between the two modes read as
   an artefact of where the cuts happened to fall. */
function drawDensity(host, p) {
  const W = 760, H = 430, L = 96, R = 30, T = 34, B = 96;
  const { svg, pw, ph } = frame(p, W, H, L, R, T, B);
  const xs = p.x, ys = p.y;
  if (!xs || xs.length < 2) return;
  const x0 = xs[0], x1 = xs[xs.length - 1];
  const ymax = Math.max(...ys) || 1;
  const px = (v) => L + ((v - x0) / (x1 - x0)) * pw;
  const py = (v) => T + ph - (v / ymax) * ph;

  for (const v of niceTicks(0, ymax, 4)) {
    svg.appendChild(el("line", { x1: L, x2: L + pw, y1: py(v), y2: py(v), class: "gal__grid" }));
    svg.appendChild(el("text", { x: L - 14, y: py(v) + 7, class: "gal__tick",
                                 "text-anchor": "end" }, v.toFixed(2)));
  }
  // POINTWISE 95% BAND, from the closed-form KDE variance rather than a bootstrap.
  // It widens where the density is low, which is exactly where the curve is least
  // supported by data — the honest place for a curve to look uncertain.
  if (p.ylo && p.yhi) {
    let b = `M ${px(xs[0]).toFixed(1)} ${py(p.yhi[0]).toFixed(1)}`;
    for (let i = 1; i < xs.length; i++) b += ` L ${px(xs[i]).toFixed(1)} ${py(p.yhi[i]).toFixed(1)}`;
    for (let i = xs.length - 1; i >= 0; i--) b += ` L ${px(xs[i]).toFixed(1)} ${py(p.ylo[i]).toFixed(1)}`;
    svg.appendChild(el("path", { d: b + " Z", class: "gal__ci-band" }));
  }
  let d = `M ${px(xs[0]).toFixed(1)} ${py(ys[0]).toFixed(1)}`;
  for (let i = 1; i < xs.length; i++) d += ` L ${px(xs[i]).toFixed(1)} ${py(ys[i]).toFixed(1)}`;
  svg.appendChild(el("path", {
    d: `${d} L ${px(x1).toFixed(1)} ${(T + ph).toFixed(1)} L ${px(x0).toFixed(1)} ${(T + ph).toFixed(1)} Z`,
    class: "gal__dens-fill" }));
  svg.appendChild(el("path", { d, class: "gal__dens-line" }));

  if (p.reference != null) {
    const rx = px(p.reference);
    svg.appendChild(el("line", { x1: rx, x2: rx, y1: T, y2: T + ph, class: "gal__ref" }));
    svg.appendChild(el("text", { x: rx + 7, y: T + 17, class: "gal__reftxt" },
                    p.reference_label || "published typical"));
  }
  for (const v of (p.rug || [])) {
    if (v < x0 || v > x1) continue;
    svg.appendChild(el("line", { x1: px(v), x2: px(v), y1: T + ph + 3, y2: T + ph + 12,
                                 class: "gal__rug" }));
  }
  svg.appendChild(el("line", { x1: L, x2: L + pw, y1: T + ph, y2: T + ph, class: "gal__axis" }));
  svg.appendChild(el("line", { x1: L, x2: L, y1: T, y2: T + ph, class: "gal__axis" }));
  for (const v of niceTicks(x0, x1, 5)) {
    svg.appendChild(el("line", { x1: px(v), x2: px(v), y1: T + ph + 14, y2: T + ph + 20,
                                 class: "gal__axis" }));
    svg.appendChild(el("text", { x: px(v), y: T + ph + 40, class: "gal__tick",
                                 "text-anchor": "middle" }, v));
  }
  svg.appendChild(el("text", { x: L + pw / 2, y: H - 18, class: "gal__axtitle",
                               "text-anchor": "middle" }, p.xlabel || p.title));
  svg.appendChild(el("text", { x: 30, y: T + ph / 2, class: "gal__axtitle",
                               "text-anchor": "middle",
                               transform: `rotate(-90 30 ${T + ph / 2})` }, "density"));
  wrapPanel(host, p, svg,
    `  n = ${p.n}${p.bandwidth ? `, bandwidth ${p.bandwidth}` : ""}.`);
}

function drawCategorical(host, p) {
  const W = 760, H = 430, L = 96, R = 30, T = 34, B = 92;
  const { svg, pw, ph } = frame(p, W, H, L, R, T, B);
  const counts = p.counts;
  const max = Math.max(...counts, 1);
  const nz = counts.filter((c) => c > 0);
  const min = nz.length ? Math.min(...nz) : 1;
  // a 734 bar beside a 35 bar leaves the small ones two pixels tall, and 4 and 6 free
  // lumbar ARE the transitional cases — sqrt keeps the tall bar honest and the short
  // ones comparable, and the printed count means the scale never has to be read at all
  const skew = max / min > 20;
  const scale = (v) => (skew ? Math.sqrt(v / max) : v / max) * ph;
  const bw = pw / counts.length;

  for (const v of niceTicks(0, max, 4)) {
    const y = T + ph - scale(v);
    svg.appendChild(el("line", { x1: L, x2: L + pw, y1: y, y2: y, class: "gal__grid" }));
    svg.appendChild(el("text", { x: L - 14, y: y + 7, class: "gal__tick",
                                 "text-anchor": "end" }, v));
  }
  counts.forEach((c, i) => {
    const h = scale(c);
    const r = el("rect", { x: L + i * bw + 2, y: T + ph - h,
                           width: Math.max(2, bw - 4), height: h, class: "gal__bar" });
    r.appendChild(el("title", null, `${p.categories[i]}: ${c} cases`));
    svg.appendChild(r);
    // Wilson interval on the proportion, converted back to counts so it lives on the
    // same axis as the bar it belongs to
    if (p.ci_lo && p.total) {
      const cl = (p.ci_lo[i] / 100) * p.total, ch = (p.ci_hi[i] / 100) * p.total;
      const cx = L + i * bw + bw / 2;
      svg.appendChild(el("line", { x1: cx, x2: cx, y1: T + ph - scale(cl),
                                   y2: T + ph - scale(ch), class: "gal__whisk" }));
      for (const b of [cl, ch]) {
        svg.appendChild(el("line", { x1: cx - 5, x2: cx + 5, y1: T + ph - scale(b),
                                     y2: T + ph - scale(b), class: "gal__whisk" }));
      }
    }
    if (c > 0) {
      svg.appendChild(el("text", { x: L + i * bw + bw / 2, y: T + ph - h - 9,
                                   class: "gal__val", "text-anchor": "middle" }, c));
    }
  });
  svg.appendChild(el("line", { x1: L, x2: L + pw, y1: T + ph, y2: T + ph, class: "gal__axis" }));
  svg.appendChild(el("line", { x1: L, x2: L, y1: T, y2: T + ph, class: "gal__axis" }));
  p.categories.forEach((c, i) => {
    svg.appendChild(el("text", { x: L + i * bw + bw / 2, y: T + ph + 32,
                                 class: "gal__tick", "text-anchor": "middle" }, c));
  });
  svg.appendChild(el("text", { x: L + pw / 2, y: H - 22, class: "gal__axtitle",
                               "text-anchor": "middle" }, p.xlabel || p.title));
  svg.appendChild(el("text", { x: 30, y: T + ph / 2, class: "gal__axtitle",
                               "text-anchor": "middle",
                               transform: `rotate(-90 30 ${T + ph / 2})` },
                     skew ? "cases (√ scale)" : "cases"));
  wrapPanel(host, p, svg, skew
    ? "  Bar heights use a square-root scale so the small categories stay visible; the "
      + "number on each bar is the exact count."
    : "");
}

function drawScatter(host, p) {
  const W = 760, L = 96, R = 30, T = 30;
  const legLabels = p.legend === false ? [] :
    [p.legend_a || "no source LSTV label", p.legend_b || "carries an LSTV label"];
  const legH = legLabels.length ? legendLayout(legLabels, W - L - R).height + 10 : 0;
  const B = 92 + legH, H = 470 + legH;
  const { svg, pw, ph } = frame(p, W, H, L, R, T, B);
  const xs = p.points.map((q) => q.x), ys = p.points.map((q) => q.y);
  const x0 = Math.min(...xs), x1 = Math.max(...xs);
  const logy = p.log_y === true;
  const y0 = logy ? 0.2 : Math.min(...ys), y1 = Math.max(...ys);
  const ty = (v) => (logy ? Math.log10(Math.max(v, 0.2)) : v);
  const l0 = ty(y0), l1 = ty(y1);
  const px = (v) => L + ((v - x0) / (x1 - x0 || 1)) * pw;
  const py = (v) => T + ph - ((ty(v) - l0) / (l1 - l0 || 1)) * ph;

  const yt = logy ? [0.2, 0.5, 1, 2, 5, 10, 20, 50].filter((v) => v <= y1)
                  : niceTicks(y0, y1, 5);
  for (const v of yt) {
    svg.appendChild(el("line", { x1: L, x2: L + pw, y1: py(v), y2: py(v), class: "gal__grid" }));
    svg.appendChild(el("text", { x: L - 14, y: py(v) + 7, class: "gal__tick",
                                 "text-anchor": "end" }, v));
  }
  for (const v of niceTicks(x0, x1, 5)) {
    svg.appendChild(el("line", { x1: px(v), x2: px(v), y1: T + ph, y2: T + ph + 8,
                                 class: "gal__axis" }));
    svg.appendChild(el("text", { x: px(v), y: T + ph + 32, class: "gal__tick",
                                 "text-anchor": "middle" }, v));
  }
  if (p.identity) {                    // the y = x guide: for PI against LL it IS the finding
    const a = Math.max(x0, y0), b = Math.min(x1, y1);
    svg.appendChild(el("line", { x1: px(a), y1: py(a), x2: px(b), y2: py(b), class: "gal__ref" }));
  }
  for (const q of p.points) {
    svg.appendChild(el("circle", { cx: px(q.x), cy: py(q.y), r: q.f ? 4.4 : 2.8,
                                   class: q.f ? "gal__dot gal__dot--flag" : "gal__dot" }));
  }
  svg.appendChild(el("line", { x1: L, x2: L + pw, y1: T + ph, y2: T + ph, class: "gal__axis" }));
  svg.appendChild(el("line", { x1: L, x2: L, y1: T, y2: T + ph, class: "gal__axis" }));
  svg.appendChild(el("text", { x: L + pw / 2, y: H - legH - 22, class: "gal__axtitle",
                               "text-anchor": "middle" }, p.xlabel));
  svg.appendChild(el("text", { x: 30, y: T + ph / 2, class: "gal__axtitle",
                               "text-anchor": "middle",
                               transform: `rotate(-90 30 ${T + ph / 2})` }, p.ylabel));
  // A DECLARED THRESHOLD IS PART OF THE MEASUREMENT, not an annotation. Castellvi type I
  // is defined at nineteen millimetres of transverse-process height, and a scatter of
  // heights without that line asks the reader to hold the number in their head.
  if (typeof p.vline === "number" && isFinite(p.vline)) {
    const vx = L + ((p.vline - x0) / Math.max(1e-9, x1 - x0)) * pw;
    if (vx > L && vx < L + pw) {
      svg.appendChild(el("line", { x1: vx, x2: vx, y1: T, y2: T + ph,
                                   class: "gal__thresh" }));
      svg.appendChild(el("text", { x: vx + 6, y: T + 14, class: "gal__tick" },
                        p.vline_label || ""));
    }
  }

  if (legLabels.length) {
    legendBelow(svg, legLabels, L, pw, H - legH + 20, (g, i) => {
      g.appendChild(el("circle", { cx: 9, cy: 0, r: i ? 4.4 : 2.8,
                                   class: i ? "gal__dot gal__dot--flag" : "gal__dot" }));
    });
  }
  wrapPanel(host, p, svg, "", true);
}

/* paired densities — for a measure split by sex, the separation IS the finding */
function drawSplit(host, p) {
  const W = 760, L = 96, R = 30, T = 34;
  const legLabels = p.series.map((s) => `${s.label}${nText(s.n)}`);
  const legH = legendLayout(legLabels, W - L - R).height + 10;
  const B = 96 + legH, H = 430 + legH;
  const { svg, pw, ph } = frame(p, W, H, L, R, T, B);
  const ymax = Math.max(...p.series.flatMap((s) => s.yhi || s.y)) || 1;
  const xr = p.series[0].x;
  const x0 = xr[0], x1 = xr[xr.length - 1];
  const px = (v) => L + ((v - x0) / (x1 - x0)) * pw;
  const py = (v) => T + ph - (v / ymax) * ph;

  for (const v of niceTicks(0, ymax, 4)) {
    svg.appendChild(el("line", { x1: L, x2: L + pw, y1: py(v), y2: py(v), class: "gal__grid" }));
    svg.appendChild(el("text", { x: L - 14, y: py(v) + 7, class: "gal__tick",
                                 "text-anchor": "end" }, v.toFixed(2)));
  }
  p.series.forEach((s, i) => {
    let d = `M ${px(s.x[0]).toFixed(1)} ${py(s.y[0]).toFixed(1)}`;
    for (let k = 1; k < s.x.length; k++) {
      d += ` L ${px(s.x[k]).toFixed(1)} ${py(s.y[k]).toFixed(1)}`;
    }
    svg.appendChild(el("path", {
      d: `${d} L ${px(x1).toFixed(1)} ${(T + ph).toFixed(1)} L ${px(x0).toFixed(1)} ${(T + ph).toFixed(1)} Z`,
      class: `gal__s${i % 6}-fill` }));
    svg.appendChild(el("path", { d, class: `gal__s${i % 6}-line` }));
  });
  svg.appendChild(el("line", { x1: L, x2: L + pw, y1: T + ph, y2: T + ph, class: "gal__axis" }));
  svg.appendChild(el("line", { x1: L, x2: L, y1: T, y2: T + ph, class: "gal__axis" }));
  for (const v of niceTicks(x0, x1, 5)) {
    svg.appendChild(el("line", { x1: px(v), x2: px(v), y1: T + ph, y2: T + ph + 8,
                                 class: "gal__axis" }));
    svg.appendChild(el("text", { x: px(v), y: T + ph + 34, class: "gal__tick",
                                 "text-anchor": "middle" }, v));
  }
  legendBelow(svg, legLabels, L, pw, H - legH + 20, (g, i) => {
    g.appendChild(el("rect", { x: 0, y: -9, width: 18, height: 12,
                               class: `gal__s${i % 6}-fill` }));
    g.appendChild(el("rect", { x: 0, y: -3, width: 18, height: 2,
                               class: `gal__s${i % 6}-line`, fill: "currentColor" }));
  });
  svg.appendChild(el("text", { x: L + pw / 2, y: H - legH - 18, class: "gal__axtitle",
                               "text-anchor": "middle" }, p.xlabel || p.title));
  svg.appendChild(el("text", { x: 30, y: T + ph / 2, class: "gal__axtitle",
                               "text-anchor": "middle",
                               transform: `rotate(-90 30 ${T + ph / 2})` }, "density"));
  wrapPanel(host, p, svg, "");
}

/* Grouped bars: the same categories measured in two or three populations. Percentages
   rather than counts, because the groups differ in size by more than twenty to one and
   raw counts would say nothing except that most people are typical. */
function drawGrouped(host, p) {
  const W = 760, L = 96, R = 30, T = 34;
  const legLabels = (p.series || []).map((s) => `${s.label}${nText(s.n)}`);
  const legH = legLabels.length ? legendLayout(legLabels, W - L - R).height + 10 : 0;
  const B = 100 + legH, H = 440 + legH;
  const { svg, pw, ph } = frame(p, W, H, L, R, T, B);
  const cats = p.categories, ser = p.series;
  // THE SCALE HAS TO COVER THE WHISKERS, NOT JUST THE BARS. Taking the maximum from `pct`
  // alone put the osteoporosis panel's top confidence bound at 45% on an axis that stopped
  // at 31%, so the bar ran off the top of the plot with nothing to say it had.
  const max = Math.max(...ser.flatMap((s) => (s.hi || s.pct)), ...ser.flatMap((s) => s.pct), 1);
  const gw = pw / cats.length;
  const bw = Math.min(30, (gw - 10) / ser.length);

  for (const v of niceTicks(0, max, 4)) {
    const y = T + ph - (v / max) * ph;
    svg.appendChild(el("line", { x1: L, x2: L + pw, y1: y, y2: y, class: "gal__grid" }));
    svg.appendChild(el("text", { x: L - 14, y: y + 7, class: "gal__tick",
                                 "text-anchor": "end" }, `${v}%`));
  }
  cats.forEach((c, i) => {
    ser.forEach((s, k) => {
      const pctv = s.pct[i] || 0;
      const h = (pctv / max) * ph;
      const x = L + i * gw + gw / 2 - (ser.length * bw) / 2 + k * bw;
      const r = el("rect", { x: x + 1, y: T + ph - h, width: bw - 2, height: h,
                             class: `gal__s${k % 6}-fill` });
      r.appendChild(el("title", null, `${s.label}, ${c}: ${pctv.toFixed(0)}% (${s.counts[i]} cases)`));
      svg.appendChild(r);
      svg.appendChild(el("rect", { x: x + 1, y: T + ph - h, width: bw - 2, height: 2.5,
                                   class: `gal__s${k % 6}-line`, fill: "currentColor" }));
      if (s.lo && s.hi) {
        const cx = x + bw / 2;
        const yl = T + ph - (s.lo[i] / max) * ph, yh = T + ph - (s.hi[i] / max) * ph;
        svg.appendChild(el("line", { x1: cx, x2: cx, y1: yl, y2: yh, class: "gal__whisk" }));
        for (const yy of [yl, yh]) {
          svg.appendChild(el("line", { x1: cx - 4, x2: cx + 4, y1: yy, y2: yy,
                                       class: "gal__whisk" }));
        }
      }
      if (pctv >= 4) {
        svg.appendChild(el("text", { x: x + bw / 2, y: T + ph - h - 7, class: "gal__val",
                                     "text-anchor": "middle" }, Math.round(pctv)));
      }
    });
    svg.appendChild(el("text", { x: L + i * gw + gw / 2, y: T + ph + 30,
                                 class: "gal__tick", "text-anchor": "middle" }, c));
  });
  svg.appendChild(el("line", { x1: L, x2: L + pw, y1: T + ph, y2: T + ph, class: "gal__axis" }));
  svg.appendChild(el("line", { x1: L, x2: L, y1: T, y2: T + ph, class: "gal__axis" }));
  svg.appendChild(el("text", { x: L + pw / 2, y: H - legH - 24, class: "gal__axtitle",
                               "text-anchor": "middle" }, p.xlabel || p.title));
  svg.appendChild(el("text", { x: 30, y: T + ph / 2, class: "gal__axtitle",
                               "text-anchor": "middle",
                               transform: `rotate(-90 30 ${T + ph / 2})` }, "% of group"));
  if (legLabels.length) {
    legendBelow(svg, legLabels, L, pw, H - legH + 20, (g, i) => {
      g.appendChild(el("rect", { x: 0, y: -8, width: 18, height: 11,
                                 class: `gal__s${i % 6}-fill` }));
    });
  }
  wrapPanel(host, p, svg, "", true);
}

/* A trend across ordered bins: median with an interquartile band, several measures at
   once. Bands rather than error bars, because the point of this panel is which lines
   MOVE and which one does not, and overlapping bands say that better than whiskers. */
function drawTrend(host, p) {
  const W = 760, L = 96, R = 30, T = 34;
  const legLabels = p.series.map((s) => s.label);
  const legH = legendLayout(legLabels, W - L - R).height + 10;
  const B = 96 + legH, H = 450 + legH;
  const { svg, pw, ph } = frame(p, W, H, L, R, T, B);
  const bins = p.bins;
  const all = p.series.flatMap((s) => s.q3.concat(s.q1));
  const lo = Math.min(...all), hi = Math.max(...all);
  const pad = (hi - lo) * 0.08;
  const y0 = lo - pad, y1 = hi + pad;
  const px = (i) => L + (bins.length === 1 ? pw / 2 : (i / (bins.length - 1)) * pw);
  const py = (v) => T + ph - ((v - y0) / (y1 - y0)) * ph;

  for (const v of niceTicks(y0, y1, 5)) {
    svg.appendChild(el("line", { x1: L, x2: L + pw, y1: py(v), y2: py(v), class: "gal__grid" }));
    svg.appendChild(el("text", { x: L - 14, y: py(v) + 7, class: "gal__tick",
                                 "text-anchor": "end" }, v));
  }
  p.series.forEach((s, k) => {
    let band = `M ${px(0)} ${py(s.q3[0])}`;
    for (let i = 1; i < bins.length; i++) band += ` L ${px(i)} ${py(s.q3[i])}`;
    for (let i = bins.length - 1; i >= 0; i--) band += ` L ${px(i)} ${py(s.q1[i])}`;
    svg.appendChild(el("path", { d: band + " Z", class: `gal__s${k % 6}-fill` }));
    let line = `M ${px(0)} ${py(s.med[0])}`;
    for (let i = 1; i < bins.length; i++) line += ` L ${px(i)} ${py(s.med[i])}`;
    svg.appendChild(el("path", { d: line, class: `gal__s${k % 6}-line` }));
    for (let i = 0; i < bins.length; i++) {
      const c = el("circle", { cx: px(i), cy: py(s.med[i]), r: 4,
                               class: `gal__s${k % 6}-line`, fill: "currentColor" });
      c.appendChild(el("title", null,
        `${s.label}, ${bins[i]}: median ${s.med[i].toFixed(1)} (n = ${s.n[i]})`));
      svg.appendChild(c);
    }
  });
  svg.appendChild(el("line", { x1: L, x2: L + pw, y1: T + ph, y2: T + ph, class: "gal__axis" }));
  svg.appendChild(el("line", { x1: L, x2: L, y1: T, y2: T + ph, class: "gal__axis" }));
  bins.forEach((b, i) => {
    svg.appendChild(el("text", { x: px(i), y: T + ph + 32, class: "gal__tick",
                                 "text-anchor": "middle" }, b));
  });
  svg.appendChild(el("text", { x: L + pw / 2, y: H - legH - 22, class: "gal__axtitle",
                               "text-anchor": "middle" }, p.xlabel || ""));
  svg.appendChild(el("text", { x: 30, y: T + ph / 2, class: "gal__axtitle",
                               "text-anchor": "middle",
                               transform: `rotate(-90 30 ${T + ph / 2})` }, p.ylabel || ""));
  legendBelow(svg, legLabels, L, pw, H - legH + 20, (g, i) => {
    g.appendChild(el("rect", { x: 0, y: -8, width: 18, height: 11,
                               class: `gal__s${i % 6}-fill` }));
    g.appendChild(el("rect", { x: 0, y: -3, width: 18, height: 2.4,
                               class: `gal__s${i % 6}-line`, fill: "currentColor" }));
  });
  wrapPanel(host, p, svg, "", true);
}

/* RIDGELINE: one density per age decade, stacked and overlapped.
   A median-and-band line chart compresses each decade to three numbers and throws the
   shape away, so a distribution that is shifting, spreading and skewing all at once
   looks like a line that moves slightly. Stacked densities show the whole thing: where
   the mass goes, whether a tail grows, whether a second mode appears. That is the
   difference between "the median fell 4 units" and seeing a population slide. */
function drawRidge(host, p) {
  const rows = p.series.length;
  // R holds the per-ridge median, drawn six units past the plot edge in a five-character
  // monospace face -- about 60 units of text. At 34 it ran off the viewBox.
  const W = 760, L = 104, R = 62, T = 30, B = 76;
  const RH = 46;                       // vertical pitch between ridges
  const OVER = 2.05;                   // how far a ridge may rise into the one above
  const H = T + rows * RH + B;
  const { svg, pw } = frame(p, W, H, L, R, T, B);
  const ph = rows * RH;

  const x0 = p.x[0], x1 = p.x[p.x.length - 1];
  const px = (v) => L + ((v - x0) / (x1 - x0)) * pw;
  const gmax = Math.max(...p.series.flatMap((s) => s.yhi || s.y)) || 1;

  // reference band, drawn under everything so it reads as ground rather than as a series
  if (p.ref != null && p.ref_sd != null) {
    svg.appendChild(el("rect", { x: px(p.ref - p.ref_sd), y: T,
                                 width: px(p.ref + p.ref_sd) - px(p.ref - p.ref_sd),
                                 height: ph, class: "gal__refband" }));
    svg.appendChild(el("line", { x1: px(p.ref), x2: px(p.ref), y1: T, y2: T + ph,
                                 class: "gal__ref" }));
  }

  // draw from the BACK so nearer ridges overlap the ones behind, as a range of hills does
  for (let i = rows - 1; i >= 0; i--) {
    const s = p.series[i];
    const base = T + (i + 1) * RH;
    const sc = (RH * OVER) / gmax;
    let d = `M ${px(s.x[0]).toFixed(1)} ${base.toFixed(1)}`;
    for (let k = 0; k < s.x.length; k++) {
      d += ` L ${px(s.x[k]).toFixed(1)} ${(base - s.y[k] * sc).toFixed(1)}`;
    }
    d += ` L ${px(s.x[s.x.length - 1]).toFixed(1)} ${base.toFixed(1)} Z`;
    svg.appendChild(el("path", { d, class: `gal__s${i % 6}-fill`, "fill-opacity": 0.82 }));
    svg.appendChild(el("path", { d, class: `gal__s${i % 6}-line`, fill: "none" }));
    // the median, marked on its own ridge
    if (s.med != null) {
      // the median and its distribution-free interval (the notched-boxplot bound),
      // which assumes nothing about shape — several of these are skewed or bimodal
      if (s.med_lo != null && s.med_hi != null) {
        svg.appendChild(el("line", { x1: px(s.med_lo), x2: px(s.med_hi),
                                     y1: base + 1.5, y2: base + 1.5, class: "gal__whisk" }));
        for (const b of [s.med_lo, s.med_hi]) {
          svg.appendChild(el("line", { x1: px(b), x2: px(b), y1: base - 1.5,
                                       y2: base + 4.5, class: "gal__whisk" }));
        }
      }
      svg.appendChild(el("line", { x1: px(s.med), x2: px(s.med), y1: base - 5,
                                   y2: base + 5, class: "gal__axis" }));
    }
    svg.appendChild(el("text", { x: L - 12, y: base - 3, class: "gal__tick",
                                 "text-anchor": "end" }, s.label));
    svg.appendChild(el("text", { x: L + pw + 6, y: base - 3, class: "gal__tick" },
                    s.med != null ? s.med.toFixed(1) : ""));
  }

  svg.appendChild(el("line", { x1: L, x2: L + pw, y1: T + ph, y2: T + ph, class: "gal__axis" }));
  for (const v of niceTicks(x0, x1, 5)) {
    svg.appendChild(el("line", { x1: px(v), x2: px(v), y1: T + ph, y2: T + ph + 7,
                                 class: "gal__axis" }));
    svg.appendChild(el("text", { x: px(v), y: T + ph + 30, class: "gal__tick",
                                 "text-anchor": "middle" }, v));
  }
  svg.appendChild(el("text", { x: L + pw / 2, y: H - 22, class: "gal__axtitle",
                               "text-anchor": "middle" }, p.xlabel || ""));
  wrapPanel(host, p, svg, "", true);
}

function drawPanel(host, p) {
  if (p.type === "scatter") return drawScatter(host, p);
  if (p.type === "density") return drawDensity(host, p);
  if (p.type === "split") return drawSplit(host, p);
  if (p.type === "categorical") return drawCategorical(host, p);
  if (p.type === "grouped") return drawGrouped(host, p);
  if (p.type === "trend") return drawTrend(host, p);
  if (p.type === "ridge") return drawRidge(host, p);
}

/* ---------------------------------------------------------- boot */
function initGallery() {
  const grid = document.getElementById("gal-cases");
  if (grid) for (const spec of CASES) mountCase(grid, spec);

  const dist = document.getElementById("gal-dist");
  if (!dist) return;
  // the measure index is optional: if it is missing the panels still draw, without
  // explainers, which is strictly better than the section failing to render
  fetch(`${DATA}index.json`)
    .then((r) => (r.ok ? r.json() : {}))
    .catch(() => ({}))
    .then((ix) => { MESH_BUILD = (ix && ix.build) ? `?v=${ix.build}` : ""; })
    .then(() => fetch(`${DATA}measures/index.json`))
    .then((r) => (r.ok ? r.json() : { panels: {} }))
    .catch(() => ({ panels: {} }))
    .then((mi) => {
      MEASURES = (mi && mi.panels) || {};
      MEASURE_BUILD = (mi && mi.build) ? `?v=${mi.build}` : "";
    })
    .then(() => fetch(`${DATA}distributions.json`))
    .then((r) => r.json())
    .then((d) => {
      const n = document.getElementById("gal-n");
      if (n) {
        n.textContent = `${d.n_cases} cases · ${d.n_lstv_labelled} carrying a source ` +
          `LSTV label · ${d.n_lumbar_rib} with a rib on a lumbar body`;
      }
      // panels arrive tagged with a section so the page groups itself: the reader meets
      // the transition measures, then the surgical ones, rather than one long strip
      const sections = new Map();
      for (const p of d.panels) {
        const key = p.section || "Anatomy of the transition";
        if (!sections.has(key)) {
          const h = el2("h3", key, "gal__secttl");
          const box = document.createElement("div");
          box.className = "gal__dist";
          if (p.section_note) {
            const note = el2("p", p.section_note, "gal__secnote");
            dist.appendChild(h); dist.appendChild(note);
          } else {
            dist.appendChild(h);
          }
          dist.appendChild(box);
          sections.set(key, box);
        }
        drawPanel(sections.get(key), p);
      }
    })
    .catch(() => {
      dist.innerHTML = '<p class="gal__err">Distributions are still being generated.</p>';
    });
}

try {
  initGallery();
} catch (err) {
  const g = document.getElementById("gal-cases");
  if (g) g.innerHTML = `<p class="gal__err">The gallery failed to start: ${err.message}.</p>`;
  console.error("[gallery]", err);
}
