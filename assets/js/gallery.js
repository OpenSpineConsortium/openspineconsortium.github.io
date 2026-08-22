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

import { createViewer } from "./viewer.js?v=e23dece8";

const DATA = "assets/gallery/";
const STILLS = DATA + "stills/";

const CASES = [
  { id: "0231", title: "A lumbar rib as long as the one above it", tag: "lumbar rib",
    blurb: "Most extra ribs on a lumbar body are stubs. This one measures 99.6% the " +
           "length of the rib above — a full rib on a body that should not have one. " +
           "It gets its own class in the release rather than being forced to be a " +
           "twelfth rib, so the count stays honest whichever way you read it.",
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
    blurb: "The lowest rib is a fraction of the one above it. Measured across the whole " +
           "cohort this is not one distribution with a long tail but two populations.",
    focus: (s) => /rib_(left|right)_12$/.test(s.name || "") },
  { id: "0378", title: "Aplastic on one side only", tag: "asymmetric",
    blurb: "A small twelfth rib on one side and none on the other. What the segmentation " +
           "first carried on the absent side was 428 fragments of stray label averaging " +
           "under two voxels each — not a rib, and now recorded as an absence.",
    focus: (s) => /rib_(left|right)_1[12]$/.test(s.name || "") },
  { id: "1153", title: "Aplastic twelfth ribs", tag: "aplastic",
    blurb: "The count ends at eleven on both sides. Recording that as an absence rather " +
           "than as a mislabelled fragment is the difference between a phenotype and a " +
           "segmentation error.",
    focus: (s) => /rib_(left|right)_11$/.test(s.name || "") },
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

  const v = createViewer(stage, {
    dataUrl: DATA,
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
  return { svg, pw: W - L - R, ph: H - T - B };
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
  const W = 760, H = 470, L = 96, R = 30, T = 30, B = 92;
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
  svg.appendChild(el("text", { x: L + pw / 2, y: H - 22, class: "gal__axtitle",
                               "text-anchor": "middle" }, p.xlabel));
  svg.appendChild(el("text", { x: 30, y: T + ph / 2, class: "gal__axtitle",
                               "text-anchor": "middle",
                               transform: `rotate(-90 30 ${T + ph / 2})` }, p.ylabel));
  if (p.legend !== false) {
    const lg = el("g", { transform: `translate(${L + pw - 250} ${T + 10})` });
    lg.appendChild(el("circle", { cx: 8, cy: -5, r: 2.8, class: "gal__dot" }));
    lg.appendChild(el("text", { x: 24, y: 1, class: "gal__tick" },
                    p.legend_a || "no source LSTV label"));
    lg.appendChild(el("circle", { cx: 8, cy: 22, r: 4.4, class: "gal__dot gal__dot--flag" }));
    lg.appendChild(el("text", { x: 24, y: 28, class: "gal__tick" },
                    p.legend_b || "carries an LSTV label"));
    svg.appendChild(lg);
  }
  wrapPanel(host, p, svg, "", true);
}

/* paired densities — for a measure split by sex, the separation IS the finding */
function drawSplit(host, p) {
  const W = 760, H = 430, L = 96, R = 30, T = 34, B = 96;
  const { svg, pw, ph } = frame(p, W, H, L, R, T, B);
  const ymax = Math.max(...p.series.flatMap((s) => s.y)) || 1;
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
  // the legend has to fit however many series there are: two for a sex comparison,
  // six for a gradient down the spine
  const lg = el("g", { transform: `translate(${L + pw - 215} ${T + 14})` });
  const rowH = p.series.length > 3 ? 20 : 26;
  p.series.forEach((s, i) => {
    lg.appendChild(el("rect", { x: 0, y: i * rowH - 12, width: 18, height: 12,
                                class: `gal__s${i % 6}-fill` }));
    lg.appendChild(el("rect", { x: 0, y: i * rowH - 6, width: 18, height: 2,
                                class: `gal__s${i % 6}-line`, fill: "currentColor" }));
    lg.appendChild(el("text", { x: 26, y: i * rowH - 2, class: "gal__tick" },
                    `${s.label} (n = ${s.n})`));
  });
  svg.appendChild(lg);
  svg.appendChild(el("text", { x: L + pw / 2, y: H - 18, class: "gal__axtitle",
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
  const W = 760, H = 440, L = 96, R = 30, T = 34, B = 100;
  const { svg, pw, ph } = frame(p, W, H, L, R, T, B);
  const cats = p.categories, ser = p.series;
  const max = Math.max(...ser.flatMap((s) => s.pct), 1);
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
  svg.appendChild(el("text", { x: L + pw / 2, y: H - 24, class: "gal__axtitle",
                               "text-anchor": "middle" }, p.xlabel || p.title));
  svg.appendChild(el("text", { x: 30, y: T + ph / 2, class: "gal__axtitle",
                               "text-anchor": "middle",
                               transform: `rotate(-90 30 ${T + ph / 2})` }, "% of group"));
  const lg = el("g", { transform: `translate(${L + pw - 250} ${T + 12})` });
  ser.forEach((s, k) => {
    lg.appendChild(el("rect", { x: 0, y: k * 22 - 11, width: 18, height: 11,
                                class: `gal__s${k % 6}-fill` }));
    lg.appendChild(el("text", { x: 26, y: k * 22 - 1, class: "gal__tick" },
                    `${s.label} (n = ${s.n})`));
  });
  svg.appendChild(lg);
  wrapPanel(host, p, svg, "", true);
}

/* A trend across ordered bins: median with an interquartile band, several measures at
   once. Bands rather than error bars, because the point of this panel is which lines
   MOVE and which one does not, and overlapping bands say that better than whiskers. */
function drawTrend(host, p) {
  const W = 760, H = 450, L = 96, R = 30, T = 34, B = 96;
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
  svg.appendChild(el("text", { x: L + pw / 2, y: H - 22, class: "gal__axtitle",
                               "text-anchor": "middle" }, p.xlabel || ""));
  svg.appendChild(el("text", { x: 30, y: T + ph / 2, class: "gal__axtitle",
                               "text-anchor": "middle",
                               transform: `rotate(-90 30 ${T + ph / 2})` }, p.ylabel || ""));
  const lg = el("g", { transform: `translate(${L + 14} ${T + 14})` });
  p.series.forEach((s, k) => {
    lg.appendChild(el("rect", { x: 0, y: k * 22 - 11, width: 18, height: 11,
                                class: `gal__s${k % 6}-fill` }));
    lg.appendChild(el("rect", { x: 0, y: k * 22 - 6, width: 18, height: 2.4,
                                class: `gal__s${k % 6}-line`, fill: "currentColor" }));
    lg.appendChild(el("text", { x: 26, y: k * 22 - 1, class: "gal__tick" }, s.label));
  });
  svg.appendChild(lg);
  wrapPanel(host, p, svg, "", true);
}

function drawPanel(host, p) {
  if (p.type === "scatter") return drawScatter(host, p);
  if (p.type === "density") return drawDensity(host, p);
  if (p.type === "split") return drawSplit(host, p);
  if (p.type === "categorical") return drawCategorical(host, p);
  if (p.type === "grouped") return drawGrouped(host, p);
  if (p.type === "trend") return drawTrend(host, p);
}

/* ---------------------------------------------------------- boot */
function initGallery() {
  const grid = document.getElementById("gal-cases");
  if (grid) for (const spec of CASES) mountCase(grid, spec);

  const dist = document.getElementById("gal-dist");
  if (!dist) return;
  fetch(`${DATA}distributions.json`)
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
